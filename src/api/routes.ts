/**
 * API Routes — Express endpoints for MoltBridge
 *
 * 8 core endpoints per spec + health + JWKS
 */

import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { verifyConnectivity, getDriver } from '../db/neo4j';
import { getJWKS } from '../crypto/keys';
import { requireAuth } from '../middleware/auth';
import { globalErrorHandler, Errors } from '../middleware/errors';
import { isValidAgentId, isSafeString, validateCapabilities, requireFields } from '../middleware/validate';
import { BrokerService } from '../services/broker';
import { CredibilityService } from '../services/credibility';
import { TrustService } from '../services/trust';
import { VerificationService } from '../services/verification';
import { RegistrationService } from '../services/registration';
import { PrincipalService } from '../services/principal';
import { IQSService, type IQSComponents } from '../services/iqs';
import { getWebhookService, type WebhookEventType } from '../services/webhooks';
import { getInboundWebhookService, type InboundEventReceipt } from '../services/inbound-webhooks';
import { ConsentService, CONSENT_PURPOSES, CONSENT_DESCRIPTIONS, OMNISCIENCE_DISCLOSURE, type ConsentPurpose } from '../services/consent';
import { PaymentService, type PaymentType } from '../services/payments';
import { OutcomeService } from '../services/outcomes';
import {
  PreEscrowGate,
  DEFAULT_POLICY,
  type PreEscrowPolicy,
  type PreEscrowRequest,
  type PreEscrowAssessment,
  type GateOverride,
} from '../services/pre-escrow';
import { FeedbackService, type FeedbackType, type FeedbackStatus } from '../services/feedback';
import { GoalService } from '../services/goals';
import { attestationToNIP32, type AttestationInput } from '../services/nip32';
import { rateLimit } from '../middleware/ratelimit';
import type { AuthenticatedRequest } from '../types';
import { getMetricsStore } from '../services/metrics';

const startTime = Date.now();

// Which source commit this build came from. scripts/deploy.sh writes dist/build-info.json;
// a build made any other way reports "unknown" instead of guessing (drift check, 2026-10-08).
function readBuildInfo(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'build-info.json'), 'utf8'));
  } catch {
    return { source_commit: 'unknown', built_at: null, note: 'no build-info.json: not built by scripts/deploy.sh' };
  }
}

export function createRoutes(): Router {
  const router = Router();

  // Service instances
  const brokerService = new BrokerService();
  const credibilityService = new CredibilityService();
  const trustService = new TrustService();
  const verificationService = new VerificationService();
  const registrationService = new RegistrationService();
  const principalService = new PrincipalService();
  const iqsService = new IQSService();
  const webhookService = getWebhookService();
  const consentService = new ConsentService();
  const paymentService = new PaymentService();
  const outcomeService = new OutcomeService();
  // PROP-881: the gate reads the outcome ledger, so it shares this instance.
  const preEscrowGate = new PreEscrowGate(outcomeService);
  const feedbackService = new FeedbackService();
  const goalService = new GoalService();

  // Analytics ring buffer (in-memory, last 10K events)
  const analyticsBuffer: Array<{
    session_id: string; event: string; page: string;
    timestamp: string; data: Record<string, any>;
    ip: string | undefined; ua: string;
  }> = [];

  // Async route wrapper
  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res, next).catch(next);

  // ========================
  // PROP-881 — Pre-Escrow Trust Verification helpers
  // ========================

  /**
   * Enforcement is ON by default. The break-glass is an explicit env var, and
   * GET /status reports the resulting state, so a disabled gate is visible
   * rather than quietly permissive.
   */
  const preEscrowEnforcing = process.env.MOLTBRIDGE_PRE_ESCROW_ENFORCE !== 'false';

  /**
   * Resolve a counterparty's declared (attested) trust score.
   *
   * Returns null — never 0 — when the agent is absent or the graph is
   * unreachable. A 0 would read as "below the floor" when the truth is
   * "could not measure", and the gate treats those two differently.
   */
  async function lookupDeclaredTrust(agentId: string): Promise<number | null> {
    let session;
    try {
      session = getDriver().session();
      const result = await session.run(
        'MATCH (a:Agent {id: $agentId}) RETURN a.trust_score AS trust_score',
        { agentId },
      );
      if (result.records.length === 0) return null;
      const raw = result.records[0].get('trust_score');
      if (raw === null || raw === undefined) return null;
      const num = typeof raw === 'object' && typeof (raw as any).toNumber === 'function'
        ? (raw as any).toNumber()
        : parseFloat(raw.toString());
      return Number.isFinite(num) ? num : null;
    } catch (err: any) {
      console.error('[PreEscrow] Declared trust lookup failed:', err.message);
      return null;
    } finally {
      if (session) {
        try { await session.close(); } catch { /* already closed */ }
      }
    }
  }

  /** Validate a caller-supplied policy fragment. */
  function parseTrustPolicy(raw: any): Partial<PreEscrowPolicy> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw Errors.validationError('trust_policy must be an object');
    }
    const out: Partial<PreEscrowPolicy> = {};
    const unit = (key: string, value: any): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw Errors.validationError(`trust_policy.${key} must be a number in [0, 1]`);
      }
      return value;
    };
    const positiveInt = (key: string, value: any): number => {
      if (!Number.isInteger(value) || value < 1) {
        throw Errors.validationError(`trust_policy.${key} must be an integer >= 1`);
      }
      return value;
    };

    if ('min_success_lower_bound' in raw) {
      out.min_success_lower_bound = unit('min_success_lower_bound', raw.min_success_lower_bound);
    }
    if ('max_dispute_rate' in raw) {
      out.max_dispute_rate = unit('max_dispute_rate', raw.max_dispute_rate);
    }
    if ('min_declared_trust' in raw) {
      out.min_declared_trust = raw.min_declared_trust === null
        ? null
        : unit('min_declared_trust', raw.min_declared_trust);
    }
    if ('min_resolved_outcomes' in raw) {
      out.min_resolved_outcomes = positiveInt('min_resolved_outcomes', raw.min_resolved_outcomes);
    }
    if ('deny_on_collusion_patterns' in raw) {
      out.deny_on_collusion_patterns = positiveInt('deny_on_collusion_patterns', raw.deny_on_collusion_patterns);
    }
    if ('collusion_rate_threshold' in raw) {
      out.collusion_rate_threshold = unit('collusion_rate_threshold', raw.collusion_rate_threshold);
    }
    if ('require_evidence' in raw) {
      if (typeof raw.require_evidence !== 'boolean') {
        throw Errors.validationError('trust_policy.require_evidence must be a boolean');
      }
      out.require_evidence = raw.require_evidence;
    }
    return out;
  }

  /**
   * Validate caller-supplied overrides. An override must name the counterparty
   * it covers and state a reason — an unexplained override is how a blocking
   * decision gets laundered out of the record.
   */
  function parseTrustOverrides(raw: any, approvedByDefault: string): Map<string, GateOverride> {
    const map = new Map<string, GateOverride>();
    if (raw === undefined || raw === null) return map;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw Errors.validationError('trust_override entries must be objects');
      }
      const id = item.counterparty_agent_id;
      if (typeof id !== 'string' || !isValidAgentId(id)) {
        throw Errors.validationError('trust_override.counterparty_agent_id must be a valid agent id');
      }
      if (typeof item.reason !== 'string' || item.reason.trim().length < 8) {
        throw Errors.validationError(
          'trust_override.reason must be at least 8 characters — an override with no stated reason is not recorded',
        );
      }
      map.set(id, {
        reason: item.reason.trim(),
        approved_by: typeof item.approved_by === 'string' && item.approved_by.length > 0
          ? item.approved_by
          : approvedByDefault,
      });
    }
    return map;
  }

  /** Append one gate decision to the durable JSONL audit log. */
  function logGateDecision(endpoint: string, a: PreEscrowAssessment): void {
    getMetricsStore().appendLog('pre-escrow-decisions', {
      endpoint,
      decision: a.decision,
      allowed: a.allowed,
      overridden: a.overridden,
      evidence_basis: a.evidence_basis,
      reason_codes: a.reasons.map(r => r.code),
      blocking_reason_codes: a.reasons.filter(r => r.blocking).map(r => r.code),
      requester_agent_id: a.requester_agent_id,
      counterparty_agent_id: a.counterparty_agent_id,
      counterparty_role: a.counterparty_role,
      introduction_id: a.introduction_id,
      resolved_outcomes: a.behavioral?.resolved ?? 0,
      success_lower_bound: a.behavioral?.success_lower_bound ?? null,
      dispute_rate: a.behavioral?.dispute_rate ?? null,
      strong_flags: a.behavioral?.strong_flags ?? [],
      declared_trust_score: a.declared_trust_score,
      enforcing: preEscrowEnforcing,
      evaluated_at: a.evaluated_at,
    });
  }

  // ========================
  // Public Endpoints (no auth)
  // ========================

  // GET /version — the source commit and build time of the running server
  router.get('/version', rateLimit('public'), (_req: Request, res: Response) => {
    res.json(readBuildInfo());
  });

  // GET /health — Server + Neo4j connectivity
  router.get('/health', rateLimit('public'), asyncHandler(async (_req, res) => {
    const neo4jConnected = await verifyConnectivity();
    const uptime = Math.round((Date.now() - startTime) / 1000);

    res.status(neo4jConnected ? 200 : 503).json({
      name: 'MoltBridge',
      version: '0.1.0',
      status: neo4jConnected ? 'healthy' : 'degraded',
      uptime,
      neo4j: { connected: neo4jConnected },
      webhooks: webhookService.getQueueStatus(),
    });
  }));

  // GET /status — Detailed network stats (localhost only)
  router.get('/status', rateLimit('public'), asyncHandler(async (req, res) => {
    // Restrict to localhost
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('::ffff:127.0.0.1')) {
      res.status(403).json({ error: 'Localhost only' });
      return;
    }

    const neo4jConnected = await verifyConnectivity();
    const uptime = Math.round((Date.now() - startTime) / 1000);

    // Network stats from Neo4j
    let networkStats = { agents: 0, principals: 0, attestations: 0, outcomes: 0, goals: 0 };
    if (neo4jConnected) {
      try {
        const session = getDriver().session();
        try {
          const result = await session.run(`
            OPTIONAL MATCH (a:Agent) WITH count(a) AS agents
            OPTIONAL MATCH (p:Principal) WITH agents, count(p) AS principals
            OPTIONAL MATCH ()-[att:ATTESTED]->() WITH agents, principals, count(att) AS attestations
            OPTIONAL MATCH (o:Outcome) WITH agents, principals, attestations, count(o) AS outcomes
            OPTIONAL MATCH (g:ConnectionGoal)
            RETURN agents, principals, attestations, outcomes, count(g) AS goals
          `);
          if (result.records.length > 0) {
            const r = result.records[0];
            networkStats = {
              agents: r.get('agents').toNumber(),
              principals: r.get('principals').toNumber(),
              attestations: r.get('attestations').toNumber(),
              outcomes: r.get('outcomes').toNumber(),
              goals: r.get('goals').toNumber(),
            };
          }
        } finally {
          await session.close();
        }
      } catch (err: any) {
        console.error('[Status] Neo4j query error:', err.message);
      }
    }

    res.json({
      name: 'MoltBridge',
      version: '0.1.0',
      status: neo4jConnected ? 'healthy' : 'degraded',
      uptime,
      neo4j: { connected: neo4jConnected },
      webhooks: webhookService.getQueueStatus(),
      network: networkStats,
      // PROP-881: surfaced here so a disabled gate is observable, not silent.
      pre_escrow_gate: {
        enforcing: preEscrowEnforcing,
        ...preEscrowGate.getDecisionStats(),
      },
      analytics: {
        total_events: analyticsBuffer.length,
        unique_sessions: new Set(analyticsBuffer.map(e => e.session_id)).size,
      },
    });
  }));

  // POST /analytics/event — Lightweight page analytics
  router.post('/analytics/event', rateLimit('public'), (req, res) => {
    const { session_id, event, page, timestamp, data } = req.body;
    if (!session_id || !event || !page) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const entry = {
      session_id: String(session_id).substring(0, 64),
      event: String(event).substring(0, 32),
      page: String(page).substring(0, 128),
      timestamp: timestamp || new Date().toISOString(),
      data: typeof data === 'object' ? data : {},
      ip: req.ip,
      ua: String(req.headers['user-agent'] || '').substring(0, 256),
    };

    // Append to in-memory ring buffer (last 10K events)
    analyticsBuffer.push(entry);
    if (analyticsBuffer.length > 10000) analyticsBuffer.splice(0, analyticsBuffer.length - 10000);

    // Persist to JSONL for survival across restarts
    getMetricsStore().appendLog('analytics-events', entry);

    res.status(204).end();
  });

  // GET /analytics/summary — Analytics dashboard data (auth required)
  router.get('/analytics/summary', requireAuth, rateLimit('standard'), (_req, res) => {
    const sessions = new Set(analyticsBuffer.map(e => e.session_id));
    const pageViews: Record<string, number> = {};
    const scrollDepths: Record<string, number[]> = {};
    const timeSpent: number[] = [];
    const ctaClicks: { text: string; href: string; count: number }[] = [];
    const ctaMap: Record<string, { text: string; href: string; count: number }> = {};

    for (const e of analyticsBuffer) {
      if (e.event === 'page_view') {
        pageViews[e.page] = (pageViews[e.page] || 0) + 1;
      } else if (e.event === 'scroll_depth') {
        if (!scrollDepths[e.page]) scrollDepths[e.page] = [];
        scrollDepths[e.page].push(e.data.depth || 0);
      } else if (e.event === 'page_exit' && e.data.time_spent) {
        timeSpent.push(e.data.time_spent);
      } else if (e.event === 'cta_click') {
        const key = `${e.data.text}|${e.data.href}`;
        if (!ctaMap[key]) ctaMap[key] = { text: e.data.text, href: e.data.href, count: 0 };
        ctaMap[key].count++;
      }
    }

    res.json({
      total_events: analyticsBuffer.length,
      unique_sessions: sessions.size,
      page_views: pageViews,
      scroll_depths: Object.fromEntries(
        Object.entries(scrollDepths).map(([page, depths]) => [
          page,
          { avg: Math.round(depths.reduce((a, b) => a + b, 0) / depths.length), max: Math.max(...depths), count: depths.length }
        ])
      ),
      avg_time_on_page: timeSpent.length ? Math.round(timeSpent.reduce((a, b) => a + b, 0) / timeSpent.length) : 0,
      cta_clicks: Object.values(ctaMap).sort((a, b) => b.count - a.count),
    });
  });

  // GET /.well-known/jwks.json — Public key for JWT verification
  router.get('/.well-known/jwks.json', rateLimit('public'), (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(getJWKS());
  });

  // GET /agents/:agentId/public-key — Per-agent Ed25519 public key for payload verification (GAP-017)
  // Public endpoint: safe to expose (public keys cannot be used to impersonate an agent)
  // Enables external networks (Weave, Ridgeline, etc.) to verify MoltBridge-signed payloads
  router.get('/agents/:agentId/public-key', rateLimit('public'), asyncHandler(async (req, res) => {
    const agentId = req.params['agentId'] as string;

    if (!isValidAgentId(agentId)) {
      throw Errors.validationError('Invalid agent_id format');
    }

    const agent = await registrationService.getAgent(agentId);
    if (!agent) {
      throw Errors.agentNotFound(agentId);
    }

    if (!agent.pubkey) {
      res.status(404).json({
        error: { code: 'NO_PUBLIC_KEY', message: 'Agent has no registered public key', status: 404 },
      });
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      agent_id: agent.id,
      public_key: agent.pubkey,
      key_format: 'ed25519',
      encoding: 'base64url',
      registered_at: agent.verified_at ?? null,
      last_verified: agent.verified_at ?? null,
    });
  }));

  // GET /agents/:agentId/did.json — Per-agent did:web DID document (did:web:api.moltbridge.ai:agents:{id})
  // Committed in autogen#7525 (2026-04-10): needed so MolTrust /identity/bridge-simple can
  // auto-resolve MoltBridge agents. Public endpoint: the agent's registered Ed25519 pubkey is
  // public-safe. Per did:web spec, DID did:web:api.moltbridge.ai:agents:{id} resolves to this path.
  router.get('/agents/:agentId/did.json', rateLimit('public'), asyncHandler(async (req, res) => {
    const agentId = req.params['agentId'] as string;

    if (!isValidAgentId(agentId)) {
      throw Errors.validationError('Invalid agent_id format');
    }

    const agent = await registrationService.getAgent(agentId);
    if (!agent) {
      throw Errors.agentNotFound(agentId);
    }

    if (!agent.pubkey) {
      res.status(404).json({
        error: { code: 'NO_PUBLIC_KEY', message: 'Agent has no registered public key', status: 404 },
      });
      return;
    }

    const did = `did:web:api.moltbridge.ai:agents:${agentId}`;
    const vmId = `${did}#key-1`;

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1',
      ],
      id: did,
      alsoKnownAs: [`https://api.moltbridge.ai/agents/${agentId}`],
      controller: 'did:web:api.moltbridge.ai',
      verificationMethod: [
        {
          id: vmId,
          type: 'JsonWebKey2020',
          controller: did,
          publicKeyJwk: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: agent.pubkey,
            use: 'sig',
            alg: 'EdDSA',
          },
        },
      ],
      authentication: [vmId],
      assertionMethod: [vmId],
    });
  }));

  // POST /verify — Proof-of-AI challenge-response (computational + cognitive)
  router.post('/verify', rateLimit('public'), (req, res) => {
    const { challenge_id, proof_of_work, cognitive_answer } = req.body;

    // If no challenge_id provided, generate a new challenge
    if (!challenge_id) {
      const challenge = verificationService.generateChallenge();
      return res.json(challenge);
    }

    // Verify the solution (both layers)
    if (!proof_of_work) {
      throw Errors.validationError('Missing proof_of_work');
    }

    const result = verificationService.verifySolution(challenge_id, proof_of_work, cognitive_answer);

    if (!result.valid) {
      return res.status(400).json({
        error: { code: 'VERIFICATION_FAILED', message: result.error, status: 400 },
      });
    }

    res.json({ verified: true, token: result.token });
  });

  // POST /register — Register a new agent
  // Requires explicit acknowledgment of operational omniscience disclosure
  // and GDPR Article 22 consent for IQS automated decision-making.
  router.post('/register', rateLimit('public'), asyncHandler(async (req, res) => {
    const {
      agent_id, name, platform, pubkey,
      capabilities, clusters, a2a_endpoint,
      verification_token,
      omniscience_acknowledged,
      article22_consent,
    } = req.body;

    // Validate required fields
    if (!agent_id || !name || !platform || !pubkey || !verification_token) {
      throw Errors.validationError('Missing required fields: agent_id, name, platform, pubkey, verification_token');
    }

    // Require explicit omniscience acknowledgment (spec Section 9)
    if (!omniscience_acknowledged) {
      res.status(200).json({
        registration_blocked: true,
        reason: 'omniscience_disclosure_required',
        disclosure: OMNISCIENCE_DISCLOSURE,
        message: 'You must acknowledge the operational omniscience disclosure before registering. Re-submit with omniscience_acknowledged: true.',
        article22_info: {
          description: 'MoltBridge uses automated Introduction Quality Scoring (IQS) that may affect your access to professional opportunities. Under GDPR Article 22, you have the right to human review of automated decisions.',
          consent_required: true,
          appeal_available: true,
          message: 'Include article22_consent: true to consent to IQS automated decision-making.',
        },
      });
      return;
    }

    // Require GDPR Article 22 consent for IQS (spec Section 8.11)
    if (!article22_consent) {
      res.status(200).json({
        registration_blocked: true,
        reason: 'article22_consent_required',
        article22_info: {
          description: 'MoltBridge uses automated Introduction Quality Scoring (IQS) that may affect your access to professional opportunities. Under GDPR Article 22, you have the right to human review of automated decisions.',
          consent_required: true,
          appeal_available: true,
          appeal_endpoint: 'POST /v1/introductions/appeal (Phase 2)',
          message: 'Include article22_consent: true to consent to IQS automated decision-making.',
        },
      });
      return;
    }

    // Validate verification token
    const tokenResult = verificationService.validateToken(verification_token);
    if (!tokenResult.valid) {
      throw Errors.unauthorized(`Invalid verification token: ${tokenResult.error}`);
    }

    const agent = await registrationService.register({
      agent_id,
      name,
      platform,
      pubkey,
      capabilities: capabilities || [],
      clusters: clusters || [],
      a2a_endpoint,
      verification_token,
      omniscience_acknowledged: true,
      article22_consent: true,
    });

    // Auto-grant consent records for acknowledged disclosures
    consentService.grant(agent_id, 'operational_omniscience', 'registration');
    consentService.grant(agent_id, 'iqs_scoring', 'registration-article22');
    consentService.grant(agent_id, 'data_sharing', 'registration-default');
    consentService.grant(agent_id, 'profiling', 'registration-default');

    // Mark all connection goals as stale (graph changed)
    goalService.markAllGoalsStale().catch(() => {});

    // Activity tracking
    getMetricsStore().appendLog('activity', {
      event: 'agent_registered',
      timestamp: new Date().toISOString(),
      details: { agent_id, name, platform },
    });

    res.status(201).json({
      agent,
      consents_granted: ['operational_omniscience', 'iqs_scoring', 'data_sharing', 'profiling'],
      disclosures_acknowledged: {
        omniscience: OMNISCIENCE_DISCLOSURE.version,
        article22: true,
      },
    });
  }));

  // ========================
  // Authenticated Endpoints
  // ========================

  // PUT /profile — Update agent profile
  router.put('/profile', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { capabilities, clusters, a2a_endpoint } = req.body;

    const agent = await registrationService.updateProfile(auth.agent_id, {
      capabilities,
      clusters,
      a2a_endpoint,
    });

    res.json({ agent });
  }));

  // ========================
  // Principal Onboarding Endpoints
  // ========================

  // POST /principal/onboard — Agent submits initial profile for its human
  router.post('/principal/onboard', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { industry, role, organization, expertise, interests, projects, location, bio, looking_for, can_offer } = req.body;

    const profile = await principalService.onboard(auth.agent_id, {
      industry, role, organization, expertise, interests, projects, location, bio, looking_for, can_offer,
    });

    res.status(201).json({ profile, enrichment_level: profile.enrichment_level });
  }));

  // PUT /principal/profile — Agent updates principal profile
  router.put('/principal/profile', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { industry, role, organization, expertise, interests, projects, location, bio, looking_for, can_offer, replace } = req.body;

    const profile = await principalService.updateProfile(auth.agent_id, {
      industry, role, organization, expertise, interests, projects, location, bio, looking_for, can_offer, replace,
    });

    res.json({ profile });
  }));

  // GET /principal/profile — Agent reads its principal's full profile
  router.get('/principal/profile', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const profile = await principalService.getProfile(auth.agent_id);
    res.json({ profile });
  }));

  // GET /principal/visibility — What others can see about this principal
  router.get('/principal/visibility', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const visible = await principalService.getVisibility(auth.agent_id);
    res.json({ visible, enrichment_level: visible.enrichment_level });
  }));

  // POST /discover-broker — Find best broker to reach a person
  router.post('/discover-broker', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { target_identifier, max_hops, max_results } = req.body;

    if (!target_identifier) {
      throw Errors.validationError('Missing target_identifier');
    }
    if (!isSafeString(target_identifier)) {
      throw Errors.validationError('Invalid target_identifier format');
    }

    const result = await brokerService.findBrokerToPerson({
      source_agent_id: auth.agent_id,
      target_identifier,
      max_hops,
      max_results,
    });

    if (!result.path_found) {
      res.json({
        ...result,
        error: { code: 'NO_PATH_FOUND', message: result.message, status: 200 },
        discovery_hint: 'Find brokers and connections at moltbridge.ai — agent card: moltbridge.ai/.well-known/agent.json',
      });
      return;
    }

    res.json({
      ...result,
      discovery_hint: 'Share with agents who need networking: moltbridge.ai/.well-known/agent.json',
    });
  }));

  // POST /discover-capability — Find agents matching capability needs
  router.post('/discover-capability', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const { capabilities, min_trust_score, max_results } = req.body;

    const validCaps = validateCapabilities(capabilities);
    if (!validCaps || validCaps.length === 0) {
      throw Errors.validationError('Missing or invalid capabilities array');
    }

    const result = await brokerService.findCapabilityMatch({
      capabilities: validCaps,
      min_trust_score,
      max_results,
    });

    res.json({
      ...result,
      discovery_hint: 'Share with agents who need networking: moltbridge.ai/.well-known/agent.json',
    });
  }));

  // GET /credibility-packet — Generate credibility proof
  router.get('/credibility-packet', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const targetId = req.query.target as string;
    const brokerId = req.query.broker as string;

    if (!targetId || !brokerId) {
      throw Errors.validationError('Missing target and/or broker query parameters');
    }
    if (!isSafeString(targetId) || !isSafeString(brokerId)) {
      throw Errors.validationError('Invalid target or broker format');
    }

    const jwt = await credibilityService.generatePacket(
      auth.agent_id,
      targetId,
      brokerId,
    );

    res.json({
      packet: jwt,
      expires_in: 30 * 24 * 60 * 60, // 30 days in seconds
      verify_url: '/.well-known/jwks.json',
    });
  }));

  // POST /attest — Submit attestation about another agent
  router.post('/attest', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const {
      target_agent_id,
      attestation_type,
      capability_tag,
      confidence,
    } = req.body;

    if (!target_agent_id || !attestation_type) {
      throw Errors.validationError('Missing target_agent_id or attestation_type');
    }
    if (!isValidAgentId(target_agent_id)) {
      throw Errors.validationError('Invalid target_agent_id format');
    }
    if (!['CAPABILITY', 'IDENTITY', 'INTERACTION'].includes(attestation_type)) {
      throw Errors.validationError('attestation_type must be CAPABILITY, IDENTITY, or INTERACTION');
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      throw Errors.validationError('confidence must be a number between 0.0 and 1.0');
    }
    if (auth.agent_id === target_agent_id) {
      throw Errors.validationError('Cannot attest about yourself');
    }

    const { getDriver } = await import('../db/neo4j');
    const driver = getDriver();
    const session = driver.session();

    try {
      // Verify target exists
      const targetCheck = await session.run(
        'MATCH (a:Agent {id: $targetId}) RETURN a.id',
        { targetId: target_agent_id }
      );

      if (targetCheck.records.length === 0) {
        throw Errors.agentNotFound(target_agent_id);
      }

      // Create attestation edge
      const now = new Date().toISOString();
      const validUntil = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(); // 180 days

      await session.run(
        `
        MATCH (source:Agent {id: $sourceId})
        MATCH (target:Agent {id: $targetId})
        CREATE (source)-[:ATTESTED {
          claim: $attestationType,
          timestamp: $timestamp,
          evidence: $capabilityTag,
          valid_until: $validUntil,
          confidence: $confidence
        }]->(target)
        `,
        {
          sourceId: auth.agent_id,
          targetId: target_agent_id,
          attestationType: attestation_type,
          timestamp: now,
          capabilityTag: capability_tag || '',
          validUntil: validUntil,
          confidence,
        }
      );

      // Recalculate target's trust score
      const newScore = await trustService.recalculate(target_agent_id);

      // Activity tracking
      getMetricsStore().appendLog('activity', {
        event: 'attestation_created',
        timestamp: now,
        details: { source: auth.agent_id, target: target_agent_id, type: attestation_type, confidence },
      });

      res.status(201).json({
        attestation: {
          source: auth.agent_id,
          target: target_agent_id,
          type: attestation_type,
          confidence,
          created_at: now,
          valid_until: validUntil,
        },
        target_trust_score: newScore,
      });
    } finally {
      await session.close();
    }
  }));

  // GET /attest/nip32/:agentId — Export attestations for an agent as NIP-32 label events
  router.get('/attest/nip32/:agentId', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const targetAgentId = req.params.agentId as string;

    if (!isValidAgentId(targetAgentId)) {
      throw Errors.validationError('Invalid agent_id format');
    }

    const { getDriver } = await import('../db/neo4j');
    const driver = getDriver();
    const session = driver.session();

    try {
      // Fetch all attestations targeting this agent, with source/target pubkeys
      const result = await session.run(
        `
        MATCH (source:Agent)-[att:ATTESTED]->(target:Agent {id: $targetId})
        RETURN source.id AS source_id, source.pubkey AS source_pubkey,
               target.id AS target_id, target.pubkey AS target_pubkey,
               att.claim AS attestation_type, att.evidence AS capability_tag,
               att.confidence AS confidence, att.timestamp AS timestamp,
               att.valid_until AS valid_until
        ORDER BY att.timestamp DESC
        `,
        { targetId: targetAgentId }
      );

      const events = result.records.map((record) => {
        const input: AttestationInput = {
          source_agent_id: record.get('source_id'),
          source_pubkey: record.get('source_pubkey') || '',
          target_agent_id: record.get('target_id'),
          target_pubkey: record.get('target_pubkey') || '',
          attestation_type: record.get('attestation_type'),
          capability_tag: record.get('capability_tag') || undefined,
          confidence: typeof record.get('confidence') === 'number'
            ? record.get('confidence')
            : parseFloat(record.get('confidence')) || 0,
          timestamp: record.get('timestamp'),
          valid_until: record.get('valid_until') || '',
        };
        return attestationToNIP32(input);
      });

      res.json({
        agent_id: targetAgentId,
        nip32_namespace: 'com.moltbridge.trust',
        events,
        count: events.length,
        note: 'Events are unsigned. Consumers must sign with secp256k1 key for Nostr relay publishing.',
      });
    } finally {
      await session.close();
    }
  }));

  // ========================
  // PROP-881 — Pre-Escrow Trust Verification
  // ========================

  // POST /trust/pre-escrow — Verify a counterparty BEFORE committing to the handoff.
  // Evaluation only, no side effects on the network. Enforcement lives at POST /outcomes.
  router.post('/trust/pre-escrow', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { counterparty_agent_id, counterparty_role, introduction_id, trust_policy, trust_override } = req.body;

    if (!counterparty_agent_id || typeof counterparty_agent_id !== 'string') {
      throw Errors.validationError('Missing counterparty_agent_id');
    }
    if (!isValidAgentId(counterparty_agent_id)) {
      throw Errors.validationError('Invalid counterparty_agent_id format');
    }
    const role = counterparty_role ?? 'target';
    if (!['target', 'broker', 'requester'].includes(role)) {
      throw Errors.validationError('counterparty_role must be one of: target, broker, requester');
    }

    const policy = parseTrustPolicy(trust_policy);
    const overrides = parseTrustOverrides(trust_override, auth.agent_id);

    const assessment = preEscrowGate.evaluate({
      requester_agent_id: auth.agent_id,
      counterparty_agent_id,
      counterparty_role: role as 'target' | 'broker' | 'requester',
      introduction_id: typeof introduction_id === 'string' ? introduction_id : null,
      declared_trust_score: await lookupDeclaredTrust(counterparty_agent_id),
      policy,
      override: overrides.get(counterparty_agent_id),
    });

    logGateDecision('POST /trust/pre-escrow', assessment);

    res.json({
      assessment,
      enforcing: preEscrowEnforcing,
      note: 'Evaluation only. The same gate enforces when the introduction is registered at POST /outcomes.',
    });
  }));

  // GET /trust/pre-escrow/policy — The policy the gate applies by default
  router.get('/trust/pre-escrow/policy', rateLimit('public'), (_req, res) => {
    res.json({
      default_policy: DEFAULT_POLICY,
      active_policy: preEscrowGate.getPolicy(),
      enforcing: preEscrowEnforcing,
      overridable_per_request: Object.keys(DEFAULT_POLICY),
    });
  });

  // GET /trust/pre-escrow/stats — Decision distribution. A gate that has never
  // blocked is reporting a broken input, not a clean network; this makes that visible.
  router.get('/trust/pre-escrow/stats', requireAuth, rateLimit('standard'), asyncHandler(async (_req, res) => {
    const stats = preEscrowGate.getDecisionStats();
    res.json({
      stats,
      enforcing: preEscrowEnforcing,
      recent: preEscrowGate.getRecentDecisions(20),
      interpretation: stats.total === 0
        ? 'No evaluations recorded yet.'
        : stats.block_rate === 0
          ? 'Zero blocking decisions across every evaluation. Check whether the outcome ledger is being populated before reading this as a healthy network.'
          : `${(stats.block_rate * 100).toFixed(1)}% of evaluations produced a blocking decision.`,
    });
  }));

  // POST /outcomes — Create an outcome record for a new introduction
  router.post('/outcomes', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { introduction_id, requester_id, broker_id, target_id } = req.body;

    if (!introduction_id || !requester_id || !broker_id || !target_id) {
      throw Errors.validationError('Missing introduction_id, requester_id, broker_id, or target_id');
    }

    // PROP-881 — Pre-escrow trust verification.
    // Registering the introduction is entry into the economic relationship, so
    // the gate runs BEFORE createOutcome: a blocked handoff leaves no record
    // for a later fee to attach to. Both counterparties are judged (a broker
    // taking a commission is as much a risk as the target), and the worst
    // decision governs.
    const trustPolicy = parseTrustPolicy(req.body.trust_policy);
    const trustOverrides = parseTrustOverrides(req.body.trust_override, auth.agent_id);

    const gateRequests: PreEscrowRequest[] = [];
    const seenCounterparties = new Set<string>();
    for (const [role, counterpartyId] of [['target', target_id], ['broker', broker_id]] as const) {
      if (seenCounterparties.has(counterpartyId)) continue;
      seenCounterparties.add(counterpartyId);
      gateRequests.push({
        requester_agent_id: requester_id,
        counterparty_agent_id: counterpartyId,
        counterparty_role: role,
        introduction_id,
        declared_trust_score: await lookupDeclaredTrust(counterpartyId),
        policy: trustPolicy,
        override: trustOverrides.get(counterpartyId),
      });
    }

    const gate = preEscrowGate.evaluateHandoff(gateRequests);
    for (const assessment of gate.assessments) {
      logGateDecision('POST /outcomes', assessment);
    }

    if (!gate.allowed) {
      const blocked = gate.assessments.filter(a => !a.allowed);
      if (preEscrowEnforcing) {
        res.status(403).json({
          error: {
            code: 'TRUST_GATE_BLOCKED',
            message: `Pre-escrow trust verification returned '${gate.decision}' for ${blocked
              .map(a => `${a.counterparty_role} '${a.counterparty_agent_id}'`)
              .join(', ')}`,
            status: 403,
          },
          gate,
        });
        return;
      }
      console.warn(
        `[PreEscrow] NOT ENFORCING — would have blocked introduction '${introduction_id}' (${gate.decision})`,
      );
    }

    try {
      const outcome = outcomeService.createOutcome(introduction_id, requester_id, broker_id, target_id);
      // The gate travels with the response. An allow on no evidence says so.
      res.status(201).json({ outcome, gate });
    } catch (err: any) {
      if (err.message.includes('already exists')) {
        throw Errors.conflict(`Outcome already exists for introduction: ${introduction_id}`);
      }
      throw err;
    }
  }));

  // POST /report-outcome — Submit a bilateral outcome report (Layer 1 verification)
  router.post('/report-outcome', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { introduction_id, status, evidence_type, evidence_url } = req.body;

    if (!introduction_id || !status || !evidence_type) {
      throw Errors.validationError('Missing introduction_id, status, or evidence_type');
    }
    if (!['successful', 'failed', 'no_response', 'disputed'].includes(status)) {
      throw Errors.validationError('Invalid status. Must be: successful, failed, no_response, or disputed');
    }
    if (!['requester_report', 'target_report', 'url_evidence', 'a2a_proof'].includes(evidence_type)) {
      throw Errors.validationError('Invalid evidence_type. Must be: requester_report, target_report, url_evidence, or a2a_proof');
    }

    // Determine reporter role from evidence_type
    const roleMap: Record<string, 'requester' | 'target' | 'broker'> = {
      'requester_report': 'requester',
      'target_report': 'target',
      'url_evidence': 'requester',
      'a2a_proof': 'target',
    };

    try {
      const outcome = outcomeService.submitReport({
        introduction_id,
        reporter_agent_id: auth.agent_id,
        reporter_role: roleMap[evidence_type],
        status,
        evidence_type,
        evidence_url,
        reported_at: new Date().toISOString(),
      });

      // Activity tracking
      getMetricsStore().appendLog('activity', {
        event: 'outcome_reported',
        timestamp: new Date().toISOString(),
        details: { introduction_id, reporter: auth.agent_id, status: outcome.resolved_status },
      });

      // Emit webhook event
      webhookService.emit({
        id: `outcome-${Date.now()}`,
        type: 'outcome_reported',
        timestamp: new Date().toISOString(),
        payload: {
          introduction_id,
          status: outcome.resolved_status,
          verification_layer: outcome.verification_layer,
          anomaly_flags: outcome.anomaly_flags,
        },
      });

      res.status(201).json({
        outcome: {
          introduction_id: outcome.introduction_id,
          resolved_status: outcome.resolved_status,
          verification_layer: outcome.verification_layer,
          timing_analysis: outcome.timing_analysis,
          anomaly_flags: outcome.anomaly_flags,
          reports_count: outcome.reports.length,
        },
      });
    } catch (err: any) {
      if (err.message.includes('not found')) {
        throw Errors.validationError(`Outcome not found. Create one first via POST /outcomes.`);
      }
      if (err.message.includes('already reported')) {
        throw Errors.conflict(err.message);
      }
      if (err.message.includes('not a party')) {
        throw Errors.unauthorized('You are not a party to this introduction');
      }
      throw err;
    }
  }));

  // GET /outcomes/pending — Get outcomes needing resolution (admin/review)
  // NOTE: Must be registered BEFORE /outcomes/:id to avoid "pending" matching as :id
  router.get('/outcomes/pending', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const pending = outcomeService.getPendingResolution();
    res.json({
      pending: pending.map(o => ({
        introduction_id: o.introduction_id,
        resolved_status: o.resolved_status,
        verification_layer: o.verification_layer,
        anomaly_flags: o.anomaly_flags,
        reports_count: o.reports.length,
      })),
      count: pending.length,
    });
  }));

  // GET /outcomes/agent/:agentId/stats — Get agent outcome statistics
  router.get('/outcomes/agent/:agentId/stats', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const stats = outcomeService.getAgentStats(req.params.agentId as string);
    res.json({ stats });
  }));

  // GET /outcomes/:id — Get outcome by introduction ID
  // NOTE: Must be AFTER specific routes (/pending, /agent/:id/stats)
  router.get('/outcomes/:id', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const outcome = outcomeService.getOutcome(id);
    if (!outcome) {
      throw Errors.validationError(`Outcome not found: ${id}`);
    }
    res.json({ outcome });
  }));

  // ========================
  // IQS Endpoints
  // ========================

  // POST /iqs/evaluate — Evaluate introduction quality (band-based, anti-oracle)
  router.post('/iqs/evaluate', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;

    // Require IQS consent
    if (!consentService.hasConsent(auth.agent_id, 'iqs_scoring')) {
      throw Errors.validationError('IQS scoring requires iqs_scoring consent. Grant consent via POST /consent/grant.');
    }

    const { target_id, requester_capabilities, target_capabilities, broker_success_count, broker_total_intros, hops } = req.body;

    if (!target_id) {
      throw Errors.validationError('Missing target_id');
    }

    // Compute component scores
    const components: IQSComponents = {
      relevance_score: iqsService.computeRelevance(
        requester_capabilities || [],
        target_capabilities || [],
      ),
      requester_credibility: iqsService.mapCredibility(0.5), // Default; production reads from graph
      broker_confidence: iqsService.computeBrokerConfidence(
        broker_success_count || 0,
        broker_total_intros || 0,
      ),
      path_proximity: iqsService.computePathProximity(hops || 2),
      novelty_score: iqsService.computeNovelty(target_id, auth.agent_id),
    };

    const result = iqsService.evaluate(components, target_id, auth.agent_id);

    // Emit webhook event
    webhookService.emit({
      id: `iqs-${Date.now()}`,
      type: 'iqs_guidance',
      timestamp: new Date().toISOString(),
      payload: { target_id, requester_id: auth.agent_id, band: result.band },
    });

    res.json(result);
  }));

  // ========================
  // Webhook Endpoints
  // ========================

  // POST /webhooks/register — Register a webhook endpoint
  router.post('/webhooks/register', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { endpoint_url, event_types } = req.body;

    if (!endpoint_url || !event_types || !Array.isArray(event_types)) {
      throw Errors.validationError('Missing endpoint_url or event_types array');
    }

    const validTypes: WebhookEventType[] = ['introduction_request', 'attestation_received', 'trust_score_changed', 'outcome_reported', 'iqs_guidance', 'connection_goal_ready'];
    for (const t of event_types) {
      if (!validTypes.includes(t)) {
        throw Errors.validationError(`Invalid event type: ${t}`);
      }
    }

    const registration = webhookService.register(auth.agent_id, endpoint_url, event_types);

    res.status(201).json({
      registration: {
        agent_id: registration.agent_id,
        endpoint_url: registration.endpoint_url,
        event_types: registration.event_types,
        active: registration.active,
      },
      secret: registration.secret, // Only returned once — agent must store it
    });
  }));

  // DELETE /webhooks/unregister — Remove a webhook endpoint
  router.delete('/webhooks/unregister', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { endpoint_url } = req.body;

    if (!endpoint_url) {
      throw Errors.validationError('Missing endpoint_url');
    }

    const removed = webhookService.unregister(auth.agent_id, endpoint_url);

    res.json({ removed });
  }));

  // GET /webhooks — List agent's webhook registrations
  router.get('/webhooks', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const registrations = webhookService.getRegistrations(auth.agent_id);

    res.json({
      registrations: registrations.map(r => ({
        endpoint_url: r.endpoint_url,
        event_types: r.event_types,
        active: r.active,
        last_delivery_at: r.last_delivery_at,
        failure_count: r.failure_count,
      })),
    });
  }));

  // ============================================================
  // Inbound webhooks — events FROM partner trust providers
  //   VeroQ Shield     → POST /webhooks/inbound/veroq
  //   AgentGraph (A2A) → POST /webhooks/inbound/a2a
  //   MolTrust         → POST /webhooks/inbound/moltrust
  // Security: per-partner HMAC-SHA256 over raw body + timestamp window.
  // ============================================================
  const inboundSvc = getInboundWebhookService();

  router.post('/webhooks/inbound/:partnerId', rateLimit('standard'), asyncHandler(async (req, res) => {
    const partnerId = String(req.params.partnerId ?? '');
    const partner = inboundSvc.getPartner(partnerId);
    if (!partner) {
      // Don't leak which partners are registered.
      throw Errors.validationError('Unknown partner');
    }

    const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
    const signatureHeader = String(req.header('X-Partner-Signature') ?? '');
    const timestampHeaderRaw = req.header('X-Partner-Timestamp');
    const timestampHeader = Array.isArray(timestampHeaderRaw) ? timestampHeaderRaw[0] : timestampHeaderRaw;

    if (!inboundSvc.verifyTimestamp(timestampHeader)) {
      throw Errors.unauthorized('Timestamp missing or outside ±5 minute window');
    }
    if (!inboundSvc.verifySignature(partner.signing_secret, rawBody, signatureHeader)) {
      throw Errors.unauthorized('Invalid partner signature');
    }

    const payload = req.body ?? {};
    const eventType = String(payload.event ?? payload.event_type ?? payload.type ?? 'unknown');
    if (!partner.allowed_events.includes(eventType)) {
      throw Errors.validationError(`Event type not allowed for partner: ${eventType}`);
    }

    const bodyHash = require('crypto').createHash('sha256').update(rawBody).digest('hex');
    const receipt: InboundEventReceipt = {
      receipt_id: `rcpt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      partner_id: partner.partner_id,
      event_type: eventType,
      received_at: new Date().toISOString(),
      signature_valid: true,
      body_hash: bodyHash,
      attestation_id: inboundSvc.extractAttestationId(partner, payload),
      payload,
    };
    inboundSvc.recordReceipt(receipt);

    res.status(202).json({
      accepted: true,
      receipt_id: receipt.receipt_id,
      attestation_id: receipt.attestation_id,
    });
  }));

  // GET /webhooks/inbound/receipts — recent inbound receipts (localhost/admin debugging)
  router.get('/webhooks/inbound/receipts', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const partnerId = req.query.partner_id as any;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    res.json({ receipts: inboundSvc.listReceipts(partnerId, limit) });
  }));

  // ========================
  // Consent Endpoints (GDPR)
  // ========================

  // GET /consent — Get consent status
  router.get('/consent', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const status = consentService.getStatus(auth.agent_id);

    res.json({
      ...status,
      descriptions: CONSENT_DESCRIPTIONS,
    });
  }));

  // POST /consent/grant — Grant consent for a purpose
  router.post('/consent/grant', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { purpose } = req.body;

    if (!purpose || !CONSENT_PURPOSES.includes(purpose)) {
      throw Errors.validationError(`Invalid purpose. Must be one of: ${CONSENT_PURPOSES.join(', ')}`);
    }

    const record = consentService.grant(auth.agent_id, purpose, 'api-grant');

    res.json({ consent: record });
  }));

  // POST /consent/withdraw — Withdraw consent
  router.post('/consent/withdraw', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { purpose } = req.body;

    if (!purpose || !CONSENT_PURPOSES.includes(purpose)) {
      throw Errors.validationError(`Invalid purpose. Must be one of: ${CONSENT_PURPOSES.join(', ')}`);
    }

    const record = consentService.withdraw(auth.agent_id, purpose, 'api-withdraw');

    res.json({ consent: record });
  }));

  // GET /consent/export — Export all consent data (GDPR Article 20)
  router.get('/consent/export', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const data = consentService.exportData(auth.agent_id);

    res.json(data);
  }));

  // DELETE /consent/erase — Right to erasure (GDPR Article 17)
  router.delete('/consent/erase', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const erased = consentService.eraseData(auth.agent_id);

    res.json({ erased, message: erased ? 'All consent data erased.' : 'No consent data found.' });
  }));

  // ========================
  // Payment Endpoints
  // ========================

  // POST /payments/account — Create a payment account
  router.post('/payments/account', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { tier } = req.body;

    try {
      const account = paymentService.createAccount(auth.agent_id, tier || 'standard');
      res.status(201).json({ account });
    } catch (err: any) {
      if (err.message.includes('already exists')) {
        throw Errors.conflict('Payment account already exists');
      }
      throw err;
    }
  }));

  // GET /payments/balance — Get balance
  router.get('/payments/balance', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const balance = paymentService.getBalance(auth.agent_id);

    if (!balance) {
      throw Errors.validationError('No payment account. Create one via POST /payments/account.');
    }

    res.json({ balance });
  }));

  // POST /payments/deposit — Deposit funds (Phase 1: simulated)
  router.post('/payments/deposit', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { amount } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
      throw Errors.validationError('amount must be a positive number');
    }

    const entry = paymentService.deposit(auth.agent_id, amount);

    res.json({
      entry,
      message: 'Phase 1: Simulated deposit. Phase 2 will use on-chain USDC.',
    });
  }));

  // GET /payments/history — Transaction history
  router.get('/payments/history', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const limit = parseInt(req.query.limit as string) || 50;

    const history = paymentService.getHistory(auth.agent_id, Math.min(limit, 100));

    res.json({ history });
  }));

  // GET /payments/pricing — Current pricing
  router.get('/payments/pricing', rateLimit('public'), (_req, res) => {
    res.json({ pricing: paymentService.getPricing() });
  });

  // ========================
  // Feedback Endpoints (Spec 21)
  // ========================

  const VALID_FEEDBACK_TYPES: FeedbackType[] = ['bug', 'feature_request', 'api_issue', 'data_quality', 'security', 'praise'];

  // POST /feedback — Submit feedback
  router.post('/feedback', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { type, title, description, priority, context, reproducible, steps_to_reproduce, use_case, proposed_api, impact, vote } = req.body;

    if (!type || !title || !description) {
      throw Errors.validationError('Missing required fields: type, title, description');
    }
    if (!VALID_FEEDBACK_TYPES.includes(type)) {
      throw Errors.validationError(`Invalid type. Must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}`);
    }
    if (title.length > 200) {
      throw Errors.validationError('Title must be 200 characters or less');
    }
    if (description.length > 5000) {
      throw Errors.validationError('Description must be 5000 characters or less');
    }

    try {
      const ticket = feedbackService.submit(auth.agent_id, {
        type, title, description, priority, context, reproducible, steps_to_reproduce, use_case, proposed_api, impact, vote,
      });

      const similar = feedbackService.findSimilar(title, type);
      const similarIds = similar
        .filter(t => t.ticket_id !== ticket.ticket_id)
        .map(t => t.ticket_id);

      res.status(201).json({
        ticket_id: ticket.ticket_id,
        status: ticket.status,
        priority: ticket.priority,
        type: ticket.type,
        acknowledged: false,
        created_at: ticket.created_at,
        similar_tickets: similarIds.length > 0 ? similarIds : undefined,
        message: 'Thank you for the detailed report. This has been logged for investigation.',
      });
    } catch (err: any) {
      if (err.message.includes('Rate limit')) {
        throw Errors.rateLimited();
      }
      throw err;
    }
  }));

  // POST /feedback/feature — Shorthand for feature requests
  router.post('/feedback/feature', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { title, description, use_case, proposed_api, impact, vote } = req.body;

    if (!title || !description) {
      throw Errors.validationError('Missing required fields: title, description');
    }

    try {
      const ticket = feedbackService.submit(auth.agent_id, {
        type: 'feature_request',
        title,
        description,
        use_case,
        proposed_api,
        impact,
        vote: vote !== false, // Default to voting for your own feature request
      });

      const similar = feedbackService.findSimilar(title, 'feature_request');
      const similarIds = similar
        .filter(t => t.ticket_id !== ticket.ticket_id)
        .map(t => t.ticket_id);

      res.status(201).json({
        ticket_id: ticket.ticket_id,
        status: ticket.status,
        type: 'feature_request',
        vote_count: ticket.vote_count,
        similar_requests: similarIds.length > 0 ? similarIds : undefined,
        message: `Feature request logged. ${similarIds.length > 0 ? `${similarIds.length} other agent(s) have requested similar functionality.` : ''}`,
      });
    } catch (err: any) {
      if (err.message.includes('Rate limit')) {
        throw Errors.rateLimited();
      }
      throw err;
    }
  }));

  // GET /feedback — List feedback submitted by this agent
  router.get('/feedback', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const tickets = feedbackService.listByAgent(auth.agent_id);

    res.json({
      tickets: tickets.map(t => ({
        ticket_id: t.ticket_id,
        type: t.type,
        title: t.title,
        status: t.status,
        priority: t.priority,
        created_at: t.created_at,
        updated_at: t.updated_at,
        resolution: t.resolution ?? null,
      })),
      total: tickets.length,
    });
  }));

  // GET /feedback/quality — Get feedback quality score for this agent
  router.get('/feedback/quality', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const quality = feedbackService.getQualityScore(auth.agent_id);
    const trustAdjustment = feedbackService.getTrustAdjustment(auth.agent_id);

    res.json({
      ...quality,
      trust_adjustment: trustAdjustment,
    });
  }));

  // GET /feedback/:ticketId — Get specific ticket details
  router.get('/feedback/:ticketId', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const ticketId = req.params.ticketId as string;
    const ticket = feedbackService.getTicket(ticketId);
    if (!ticket) {
      throw Errors.validationError(`Ticket not found: ${ticketId}`);
    }

    res.json({
      ticket_id: ticket.ticket_id,
      type: ticket.type,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      context: ticket.context,
      reproducible: ticket.reproducible,
      steps_to_reproduce: ticket.steps_to_reproduce,
      vote_count: ticket.vote_count,
      comments: ticket.comments,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      resolution: ticket.resolution ?? null,
    });
  }));

  // POST /feedback/:ticketId/vote — Vote on a feature request
  router.post('/feedback/:ticketId/vote', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const ticketId = req.params.ticketId as string;

    try {
      const result = feedbackService.vote(ticketId, auth.agent_id);
      res.json(result);
    } catch (err: any) {
      if (err.message.includes('not found')) {
        throw Errors.validationError(`Ticket not found: ${ticketId}`);
      }
      if (err.message.includes('only vote on feature requests')) {
        throw Errors.validationError('Can only vote on feature requests');
      }
      if (err.message.includes('Already voted')) {
        throw Errors.conflict('Already voted on this ticket');
      }
      throw err;
    }
  }));

  // POST /feedback/:ticketId/comment — Add a comment to a ticket
  router.post('/feedback/:ticketId/comment', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const ticketId = req.params.ticketId as string;
    const { comment } = req.body;

    if (!comment || typeof comment !== 'string') {
      throw Errors.validationError('Missing comment field');
    }
    if (comment.length > 2000) {
      throw Errors.validationError('Comment must be 2000 characters or less');
    }

    try {
      const result = feedbackService.addComment(ticketId, auth.agent_id, comment);
      res.status(201).json(result);
    } catch (err: any) {
      if (err.message.includes('not found')) {
        throw Errors.validationError(`Ticket not found: ${ticketId}`);
      }
      throw err;
    }
  }));

  // ========================
  // Connection Goals Endpoints
  // ========================

  // POST /connection-goals — Register a new goal
  router.post('/connection-goals', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { target_identifier, target_type, description, notify_threshold, max_hops } = req.body;

    if (!target_identifier) {
      throw Errors.validationError('Missing target_identifier');
    }
    if (!isSafeString(target_identifier)) {
      throw Errors.validationError('Invalid target_identifier format. Use alphanumeric, hyphens, underscores, dots only.');
    }
    if (description && typeof description === 'string' && description.length > 500) {
      throw Errors.validationError('Description must be 500 characters or less');
    }
    if (notify_threshold !== undefined && notify_threshold !== null) {
      const nt = Number(notify_threshold);
      if (!Number.isInteger(nt) || nt < 1 || nt > 100) {
        throw Errors.validationError('notify_threshold must be an integer between 1 and 100');
      }
    }
    if (max_hops !== undefined) {
      const mh = Number(max_hops);
      if (!Number.isInteger(mh) || mh < 1 || mh > 6) {
        throw Errors.validationError('max_hops must be an integer between 1 and 6');
      }
    }

    try {
      const { goal, score } = await goalService.createGoal(
        auth.agent_id,
        target_identifier,
        target_type || 'human',
        description || '',
        notify_threshold ? Number(notify_threshold) : null,
        max_hops ? Number(max_hops) : 4,
      );

      res.status(201).json({
        goal_id: goal.id,
        source_agent_id: goal.source_agent_id,
        target_identifier: goal.target_identifier,
        created_at: goal.created_at,
        expires_at: goal.expires_at,
        initial_score: score,
        notify_threshold: goal.notify_threshold,
        stale: goal.stale,
      });
    } catch (err: any) {
      if (err.message.startsWith('GOAL_LIMIT')) {
        res.status(429).json({
          error: { code: 'GOAL_LIMIT_REACHED', message: err.message.split(': ')[1], status: 429 },
        });
        return;
      }
      if (err.message.startsWith('GOAL_EXISTS')) {
        throw Errors.conflict(err.message.split(': ')[1]);
      }
      if (err.message.startsWith('TARGET_NOT_FOUND')) {
        throw Errors.validationError(err.message.split(': ')[1]);
      }
      throw err;
    }
  }));

  // GET /connection-goals — List agent's goals
  router.get('/connection-goals', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const goals = await goalService.listGoals(auth.agent_id);
    res.json({ goals });
  }));

  // GET /connection-goals/targeting-me — See goals targeting you
  // NOTE: Must be registered BEFORE /:id to prevent "targeting-me" matching as :id
  router.get('/connection-goals/targeting-me', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const goals = await goalService.getGoalsTargetingMe(auth.agent_id);
    res.json({ targeting_goals: goals });
  }));

  // DELETE /connection-goals/targeting-me/:id — Request removal of a goal targeting you
  router.delete('/connection-goals/targeting-me/:id', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const goalId = req.params.id as string;
    const deleted = await goalService.deleteGoalTargetingMe(auth.agent_id, goalId);
    if (!deleted) {
      throw Errors.validationError(`Goal not found or you are not the target`);
    }
    res.json({ deleted: true, goal_id: goalId });
  }));

  // GET /connection-goals/:id — Get goal with cached score
  router.get('/connection-goals/:id', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const goalId = req.params.id as string;
    const result = await goalService.getGoal(auth.agent_id, goalId);
    if (!result) {
      throw Errors.validationError(`Goal not found: ${goalId}`);
    }
    res.json({
      goal: {
        goal_id: result.goal.id,
        source_agent_id: result.goal.source_agent_id,
        target_identifier: result.goal.target_identifier,
        target_type: result.goal.target_type,
        description: result.goal.description,
        current_score: result.goal.current_score,
        notify_threshold: result.goal.notify_threshold,
        stale: result.goal.stale,
        expires_at: result.goal.expires_at,
        last_scored_at: result.goal.last_scored_at,
        created_at: result.goal.created_at,
      },
    });
  }));

  // POST /connection-goals/:id/rescore — Force fresh rescore
  router.post('/connection-goals/:id/rescore', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const goalId = req.params.id as string;

    try {
      const result = await goalService.rescoreGoal(auth.agent_id, goalId);
      if (!result) {
        throw Errors.validationError(`Goal not found: ${goalId}`);
      }

      // Check if threshold was crossed — emit webhook
      if ((result.score as any)._thresholdCrossed) {
        webhookService.emit({
          id: `evt-${goalId}-${Date.now()}`,
          type: 'connection_goal_ready',
          timestamp: new Date().toISOString(),
          payload: {
            goal_id: goalId,
            target_identifier: result.goal.target_identifier,
            previous_score: (result.score as any)._previousScore,
            current_score: result.score.total,
            threshold: result.goal.notify_threshold,
          },
        });
      }

      res.json({
        goal_id: result.goal.id,
        score: result.score,
        stale: result.goal.stale,
      });
    } catch (err: any) {
      if (err.message.startsWith('RESCORE_COOLDOWN')) {
        throw Errors.rateLimited();
      }
      throw err;
    }
  }));

  // DELETE /connection-goals/:id — Delete a goal
  router.delete('/connection-goals/:id', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const goalId = req.params.id as string;
    const deleted = await goalService.deleteGoal(auth.agent_id, goalId);
    if (!deleted) {
      throw Errors.validationError(`Goal not found: ${goalId}`);
    }
    res.json({ deleted: true, goal_id: goalId });
  }));

  // ========================
  // Error Handler (must be last)
  // ========================
  router.use(globalErrorHandler);

  return router;
}
