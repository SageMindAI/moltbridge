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

  // Async route wrapper
  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res, next).catch(next);

  // ========================
  // Public Endpoints (no auth)
  // ========================

  // GET /health — Server + Neo4j connectivity
  router.get('/health', asyncHandler(async (_req, res) => {
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
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(getJWKS());
  });

  // POST /verify — Proof-of-AI challenge-response
  router.post('/verify', (req, res) => {
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
  router.post('/register', asyncHandler(async (req, res) => {
    const {
      agent_id, name, platform, pubkey,
      capabilities, clusters, a2a_endpoint,
      verification_token,
    } = req.body;

    // Validate required fields
    if (!agent_id || !name || !platform || !pubkey || !verification_token) {
      throw Errors.validationError('Missing required fields: agent_id, name, platform, pubkey, verification_token');
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
    });

    res.status(201).json({ agent });
  }));

  // ========================
  // Authenticated Endpoints
  // ========================

  // PUT /profile — Update agent profile
  router.put('/profile', requireAuth, asyncHandler(async (req, res) => {
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
  router.post('/discover-broker', requireAuth, asyncHandler(async (req, res) => {
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
      });
      return;
    }

    res.json(result);
  }));

  // POST /discover-capability — Find agents matching capability needs
  router.post('/discover-capability', requireAuth, asyncHandler(async (req, res) => {
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

    res.json(result);
  }));

  // GET /credibility-packet — Generate credibility proof
  router.get('/credibility-packet', requireAuth, asyncHandler(async (req, res) => {
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
  router.post('/attest', requireAuth, asyncHandler(async (req, res) => {
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

  // POST /report-outcome — Report introduction outcome
  router.post('/report-outcome', requireAuth, asyncHandler(async (req, res) => {
    const auth = (req as any).auth as AuthenticatedRequest;
    const { introduction_id, status, evidence_type } = req.body;

    if (!introduction_id || !status || !evidence_type) {
      throw Errors.validationError('Missing introduction_id, status, or evidence_type');
    }
    if (!['attempted', 'acknowledged', 'successful', 'failed', 'disputed'].includes(status)) {
      throw Errors.validationError('Invalid status');
    }
    if (!['target_confirmation', 'requester_report', 'timeout'].includes(evidence_type)) {
      throw Errors.validationError('Invalid evidence_type');
    }

    // Phase 1: Store outcome report (simple — no complex verification flow yet)
    // Full outcome verification protocol deferred to Phase 1.5
    res.status(201).json({
      outcome: {
        introduction_id,
        status,
        evidence_type,
        submitted_by: auth.agent_id,
        submitted_at: new Date().toISOString(),
      },
      message: 'Outcome recorded. Full outcome verification available in Phase 1.5.',
    });
  }));

  // ========================
  // Error Handler (must be last)
  // ========================
  router.use(globalErrorHandler);

  return router;
}
