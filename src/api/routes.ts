/**
 * API Routes — Express endpoints for MoltBridge
 *
 * 8 core endpoints per spec + health + JWKS
 */

import { Router, Request, Response, NextFunction } from 'express';
import { verifyConnectivity } from '../db/neo4j';
import { getJWKS } from '../crypto/keys';
import { requireAuth } from '../middleware/auth';
import { globalErrorHandler, Errors } from '../middleware/errors';
import { isValidAgentId, isSafeString, validateCapabilities, requireFields } from '../middleware/validate';
import { BrokerService } from '../services/broker';
import { CredibilityService } from '../services/credibility';
import { TrustService } from '../services/trust';
import { VerificationService } from '../services/verification';
import { RegistrationService } from '../services/registration';
import { IQSService, type IQSComponents } from '../services/iqs';
import { WebhookService, type WebhookEventType } from '../services/webhooks';
import { ConsentService, CONSENT_PURPOSES, CONSENT_DESCRIPTIONS, OMNISCIENCE_DISCLOSURE, type ConsentPurpose } from '../services/consent';
import { PaymentService, type PaymentType } from '../services/payments';
import { OutcomeService } from '../services/outcomes';
import { rateLimit } from '../middleware/ratelimit';
import type { AuthenticatedRequest } from '../types';

const startTime = Date.now();

export function createRoutes(): Router {
  const router = Router();

  // Service instances
  const brokerService = new BrokerService();
  const credibilityService = new CredibilityService();
  const trustService = new TrustService();
  const verificationService = new VerificationService();
  const registrationService = new RegistrationService();
  const iqsService = new IQSService();
  const webhookService = new WebhookService();
  const consentService = new ConsentService();
  const paymentService = new PaymentService();
  const outcomeService = new OutcomeService();

  // Async route wrapper
  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res, next).catch(next);

  // ========================
  // Public Endpoints (no auth)
  // ========================

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
    });
  }));

  // GET /.well-known/jwks.json — Public key for JWT verification
  router.get('/.well-known/jwks.json', rateLimit('public'), (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(getJWKS());
  });

  // POST /verify — Proof-of-AI challenge-response
  router.post('/verify', rateLimit('public'), (req, res) => {
    const { challenge_id, proof_of_work } = req.body;

    // If no challenge_id provided, generate a new challenge
    if (!challenge_id) {
      const challenge = verificationService.generateChallenge();
      return res.json(challenge);
    }

    // Verify the solution
    if (!proof_of_work) {
      throw Errors.validationError('Missing proof_of_work');
    }

    const result = verificationService.verifySolution(challenge_id, proof_of_work);

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
        discovery_hint: 'Find brokers and connections at moltbridge.com — agent card: moltbridge.com/.well-known/agent.json',
      });
      return;
    }

    res.json({
      ...result,
      discovery_hint: 'Share with agents who need networking: moltbridge.com/.well-known/agent.json',
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
      discovery_hint: 'Share with agents who need networking: moltbridge.com/.well-known/agent.json',
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

  // POST /outcomes — Create an outcome record for a new introduction
  router.post('/outcomes', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { introduction_id, requester_id, broker_id, target_id } = req.body;

    if (!introduction_id || !requester_id || !broker_id || !target_id) {
      throw Errors.validationError('Missing introduction_id, requester_id, broker_id, or target_id');
    }

    try {
      const outcome = outcomeService.createOutcome(introduction_id, requester_id, broker_id, target_id);
      res.status(201).json({ outcome });
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
    const stats = outcomeService.getAgentStats(req.params.agentId);
    res.json({ stats });
  }));

  // GET /outcomes/:id — Get outcome by introduction ID
  // NOTE: Must be AFTER specific routes (/pending, /agent/:id/stats)
  router.get('/outcomes/:id', requireAuth, rateLimit('standard'), asyncHandler(async (req, res) => {
    const outcome = outcomeService.getOutcome(req.params.id);
    if (!outcome) {
      throw Errors.validationError(`Outcome not found: ${req.params.id}`);
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

    const validTypes: WebhookEventType[] = ['introduction_request', 'attestation_received', 'trust_score_changed', 'outcome_reported', 'iqs_guidance'];
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
  // Error Handler (must be last)
  // ========================
  router.use(globalErrorHandler);

  return router;
}
