/**
 * Integration Tests: API Endpoints (Full HTTP Stack)
 *
 * Uses supertest against the Express app with mocked Neo4j.
 * Tests the complete request/response cycle including middleware.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import * as crypto from 'crypto';
import { generateTestKeyPair, signRequest, solveChallenge } from '../helpers/crypto';

// Mock Neo4j before any imports that use it
const mockSession = {
  run: vi.fn().mockResolvedValue({ records: [] }),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockDriver = {
  session: vi.fn().mockReturnValue(mockSession),
  verifyConnectivity: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/db/neo4j', () => ({
  getDriver: vi.fn().mockReturnValue(mockDriver),
  verifyConnectivity: vi.fn().mockResolvedValue(true),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

let app: Express;

beforeAll(async () => {
  const { createApp } = await import('../../src/app');
  app = createApp();
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset the mock session
  mockSession.run.mockResolvedValue({ records: [] });
  mockDriver.session.mockReturnValue(mockSession);
  // Dynamic import to avoid triggering module load before mocks are established
  const { clearReplayCache } = await import('../../src/middleware/auth');
  clearReplayCache(); // Prevent replay-detection false positives between tests
});

describe('GET /health', () => {
  it('returns 200 with healthy status when Neo4j connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('MoltBridge');
    expect(res.body.status).toBe('healthy');
    expect(res.body.neo4j.connected).toBe(true);
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('version');
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('returns valid JWKS structure', async () => {
    const res = await request(app).get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('keys');
    expect(Array.isArray(res.body.keys)).toBe(true);
    expect(res.body.keys[0]).toHaveProperty('kty', 'OKP');
    expect(res.body.keys[0]).toHaveProperty('crv', 'Ed25519');
    expect(res.body.keys[0]).toHaveProperty('alg', 'EdDSA');
    expect(res.headers['cache-control']).toContain('public');
  });
});

describe('POST /verify', () => {
  it('generates challenge when no challenge_id provided', async () => {
    const res = await request(app)
      .post('/verify')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('challenge_id');
    expect(res.body).toHaveProperty('nonce');
    expect(res.body).toHaveProperty('difficulty', 4);
    expect(res.body).toHaveProperty('timestamp');
  });

  it('accepts valid proof-of-work solution', async () => {
    // Step 1: Get challenge
    const challengeRes = await request(app)
      .post('/verify')
      .send({});

    const { challenge_id, nonce, difficulty } = challengeRes.body;

    // Step 2: Solve it
    const solution = solveChallenge(nonce, difficulty);

    // Step 3: Submit solution
    const verifyRes = await request(app)
      .post('/verify')
      .send({ challenge_id, proof_of_work: solution });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verified).toBe(true);
    expect(verifyRes.body).toHaveProperty('token');
  });

  it('rejects invalid proof-of-work', async () => {
    const challengeRes = await request(app)
      .post('/verify')
      .send({});

    const res = await request(app)
      .post('/verify')
      .send({
        challenge_id: challengeRes.body.challenge_id,
        proof_of_work: 'wrong_answer',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_FAILED');
  });

  it('rejects missing proof_of_work with challenge_id', async () => {
    const res = await request(app)
      .post('/verify')
      .send({ challenge_id: 'some-id' });

    expect(res.status).toBe(400);
  });
});

describe('POST /register', () => {
  it('registers a new agent with valid data', async () => {
    const keyPair = generateTestKeyPair();

    // Get a valid verification token first
    const challengeRes = await request(app).post('/verify').send({});
    const { challenge_id, nonce, difficulty } = challengeRes.body;
    const solution = solveChallenge(nonce, difficulty);
    const verifyRes = await request(app)
      .post('/verify')
      .send({ challenge_id, proof_of_work: solution });
    const token = verifyRes.body.token;

    // Mock Neo4j responses for registration
    const agentNode = {
      properties: {
        id: 'test-agent',
        name: 'Test Agent',
        platform: 'test',
        trust_score: 0,
        capabilities: ['ai-research'],
        verified_at: new Date().toISOString(),
        pubkey: keyPair.publicKeyB64,
        a2a_endpoint: null,
      },
    };

    mockSession.run
      .mockResolvedValueOnce({ records: [] }) // check for duplicate
      .mockResolvedValueOnce({ records: [{ get: () => agentNode }] }); // create agent

    const res = await request(app)
      .post('/register')
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        platform: 'test',
        pubkey: keyPair.publicKeyB64,
        capabilities: ['ai-research'],
        clusters: [],
        verification_token: token,
        omniscience_acknowledged: true,
        article22_consent: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.agent).toBeDefined();
    expect(res.body.agent.id).toBe('test-agent');
    expect(res.body.consents_granted).toContain('operational_omniscience');
    expect(res.body.consents_granted).toContain('iqs_scoring');
    expect(res.body.disclosures_acknowledged.omniscience).toBe('v1.0');
    expect(res.body.disclosures_acknowledged.article22).toBe(true);
  });

  it('returns omniscience disclosure when not acknowledged', async () => {
    const keyPair2 = generateTestKeyPair();
    const challengeRes2 = await request(app).post('/verify').send({});
    const solution2 = solveChallenge(challengeRes2.body.nonce, challengeRes2.body.difficulty);
    const verifyRes2 = await request(app)
      .post('/verify')
      .send({ challenge_id: challengeRes2.body.challenge_id, proof_of_work: solution2 });

    const res = await request(app)
      .post('/register')
      .send({
        agent_id: 'test-no-ack',
        name: 'Test Agent',
        platform: 'test',
        pubkey: keyPair2.publicKeyB64,
        capabilities: [],
        clusters: [],
        verification_token: verifyRes2.body.token,
        // Missing: omniscience_acknowledged, article22_consent
      });

    expect(res.status).toBe(200);
    expect(res.body.registration_blocked).toBe(true);
    expect(res.body.reason).toBe('omniscience_disclosure_required');
    expect(res.body.disclosure).toBeDefined();
    expect(res.body.disclosure.version).toBe('v1.0');
    expect(res.body.disclosure.categories).toHaveLength(4);
    expect(res.body.article22_info).toBeDefined();
  });

  it('returns article22 info when omniscience acknowledged but article22 missing', async () => {
    const keyPair3 = generateTestKeyPair();
    const challengeRes3 = await request(app).post('/verify').send({});
    const solution3 = solveChallenge(challengeRes3.body.nonce, challengeRes3.body.difficulty);
    const verifyRes3 = await request(app)
      .post('/verify')
      .send({ challenge_id: challengeRes3.body.challenge_id, proof_of_work: solution3 });

    const res = await request(app)
      .post('/register')
      .send({
        agent_id: 'test-no-art22',
        name: 'Test Agent',
        platform: 'test',
        pubkey: keyPair3.publicKeyB64,
        capabilities: [],
        clusters: [],
        verification_token: verifyRes3.body.token,
        omniscience_acknowledged: true,
        // Missing: article22_consent
      });

    expect(res.status).toBe(200);
    expect(res.body.registration_blocked).toBe(true);
    expect(res.body.reason).toBe('article22_consent_required');
    expect(res.body.article22_info.description).toContain('GDPR Article 22');
    expect(res.body.article22_info.appeal_available).toBe(true);
  });

  it('rejects registration with missing required fields', async () => {
    const res = await request(app)
      .post('/register')
      .send({ agent_id: 'test' }); // missing name, platform, etc.

    expect(res.status).toBe(400);
  });

  it('rejects registration with invalid verification token', async () => {
    const keyPair = generateTestKeyPair();

    const res = await request(app)
      .post('/register')
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        platform: 'test',
        pubkey: keyPair.publicKeyB64,
        capabilities: ['ai-research'],
        clusters: [],
        verification_token: 'invalid-token',
        omniscience_acknowledged: true,
        article22_consent: true,
      });

    expect(res.status).toBe(401);
  });

  it('rejects duplicate agent_id (409 CONFLICT)', async () => {
    const keyPair = generateTestKeyPair();

    // Get valid token
    const challengeRes = await request(app).post('/verify').send({});
    const solution = solveChallenge(challengeRes.body.nonce, challengeRes.body.difficulty);
    const verifyRes = await request(app)
      .post('/verify')
      .send({ challenge_id: challengeRes.body.challenge_id, proof_of_work: solution });

    // Mock: agent already exists
    mockSession.run.mockResolvedValueOnce({
      records: [{ get: () => 'existing-agent' }],
    });

    const res = await request(app)
      .post('/register')
      .send({
        agent_id: 'existing-agent',
        name: 'Test Agent',
        platform: 'test',
        pubkey: keyPair.publicKeyB64,
        capabilities: ['ai-research'],
        clusters: [],
        verification_token: verifyRes.body.token,
        omniscience_acknowledged: true,
        article22_consent: true,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('Authenticated Endpoints', () => {
  it('rejects request with no auth header (POST /discover-broker)', async () => {
    const res = await request(app)
      .post('/discover-broker')
      .send({ target_identifier: 'some-agent' });

    expect(res.status).toBe(401);
  });

  it('rejects request with wrong auth scheme', async () => {
    const res = await request(app)
      .post('/discover-broker')
      .set('Authorization', 'Bearer some-token')
      .send({ target_identifier: 'some-agent' });

    expect(res.status).toBe(401);
  });

  it('rejects request with malformed auth header', async () => {
    const res = await request(app)
      .post('/discover-broker')
      .set('Authorization', 'MoltBridge-Ed25519 malformed')
      .send({ target_identifier: 'some-agent' });

    expect(res.status).toBe(401);
  });

  it('rejects stale timestamp (>60s)', async () => {
    const keyPair = generateTestKeyPair();
    const oldTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
    const body = { target_identifier: 'some-agent' };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const message = `POST:/discover-broker:${oldTimestamp}:${bodyHash}`;
    const messageBytes = new TextEncoder().encode(message);

    const { sign } = await import('@noble/ed25519');
    const signature = sign(messageBytes, keyPair.privateKey);
    const sigB64 = Buffer.from(signature).toString('base64url');

    const res = await request(app)
      .post('/discover-broker')
      .set('Authorization', `MoltBridge-Ed25519 test-agent:${oldTimestamp}:${sigB64}`)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('stale');
  });

  describe('POST /discover-broker (with valid auth)', () => {
    it('returns broker results when path exists', async () => {
      const keyPair = generateTestKeyPair();
      const body = { target_identifier: 'target-agent' };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/discover-broker', body);

      // Mock: agent found with pubkey
      mockSession.run.mockImplementation(async (query: string) => {
        if (query.includes('RETURN a.pubkey')) {
          return {
            records: [{
              get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
            }],
          };
        }
        // broker discovery query
        return {
          records: [{
            get: (key: string) => {
              const data: Record<string, any> = {
                broker_id: 'bridge-bot',
                broker_name: 'BridgeBot',
                trust_score: 0.85,
                hops: 2,
                clusters: ['ai-research'],
                composite_score: 1.5,
              };
              return data[key];
            },
          }],
        };
      });

      const res = await request(app)
        .post('/discover-broker')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.path_found).toBe(true);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].broker_agent_id).toBe('bridge-bot');
    });

    it('rejects missing target_identifier', async () => {
      const keyPair = generateTestKeyPair();
      const body = {};
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/discover-broker', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/discover-broker')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /discover-capability', () => {
    it('returns ranked results for valid capability search', async () => {
      const keyPair = generateTestKeyPair();
      const body = { capabilities: ['ai-research'] };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/discover-capability', body);

      mockSession.run.mockImplementation(async (query: string) => {
        if (query.includes('RETURN a.pubkey')) {
          return {
            records: [{
              get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
            }],
          };
        }
        return {
          records: [{
            get: (key: string) => {
              const data: Record<string, any> = {
                agent_id: 'research-bot',
                agent_name: 'Research Bot',
                trust_score: 0.9,
                matched_capabilities: ['ai-research'],
                match_score: 0.81,
              };
              return data[key];
            },
          }],
        };
      });

      const res = await request(app)
        .post('/discover-capability')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(0);
    });

    it('rejects empty capabilities', async () => {
      const keyPair = generateTestKeyPair();
      const body = { capabilities: [] };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/discover-capability', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/discover-capability')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /attest', () => {
    it('rejects self-attestation', async () => {
      const keyPair = generateTestKeyPair();
      const body = {
        target_agent_id: 'dawn-001', // same as auth agent
        attestation_type: 'CAPABILITY',
        confidence: 0.9,
      };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/attest', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/attest')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('yourself');
    });

    it('rejects invalid attestation_type', async () => {
      const keyPair = generateTestKeyPair();
      const body = {
        target_agent_id: 'other-agent',
        attestation_type: 'INVALID',
        confidence: 0.9,
      };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/attest', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/attest')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(400);
    });

    it('rejects confidence out of range', async () => {
      const keyPair = generateTestKeyPair();
      const body = {
        target_agent_id: 'other-agent',
        attestation_type: 'CAPABILITY',
        confidence: 1.5,
      };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/attest', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/attest')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /report-outcome', () => {
    it('accepts valid outcome report', async () => {
      const keyPair = generateTestKeyPair();
      const body = {
        introduction_id: 'intro-123',
        status: 'successful',
        evidence_type: 'target_confirmation',
      };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/report-outcome', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/report-outcome')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.outcome.introduction_id).toBe('intro-123');
      expect(res.body.outcome.status).toBe('successful');
    });

    it('rejects invalid status', async () => {
      const keyPair = generateTestKeyPair();
      const body = {
        introduction_id: 'intro-123',
        status: 'invalid-status',
        evidence_type: 'target_confirmation',
      };
      const auth = signRequest(keyPair, 'dawn-001', 'POST', '/report-outcome', body);

      mockSession.run.mockResolvedValue({
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      });

      const res = await request(app)
        .post('/report-outcome')
        .set('Authorization', auth)
        .send(body);

      expect(res.status).toBe(400);
    });
  });
});

describe('Security', () => {
  it('rejects body > 50KB', async () => {
    const largeBody = { data: 'x'.repeat(60 * 1024) };

    const res = await request(app)
      .post('/verify')
      .set('Content-Length', (60 * 1024).toString())
      .send(largeBody);

    // Either 400 (our middleware) or 413 (express json limit)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects Cypher injection in agent_id during registration', async () => {
    const keyPair = generateTestKeyPair();

    // Get valid token
    const challengeRes = await request(app).post('/verify').send({});
    const solution = solveChallenge(challengeRes.body.nonce, challengeRes.body.difficulty);
    const verifyRes = await request(app)
      .post('/verify')
      .send({ challenge_id: challengeRes.body.challenge_id, proof_of_work: solution });

    const res = await request(app)
      .post('/register')
      .send({
        agent_id: "'; MATCH (n) DELETE n;",
        name: 'Hacker',
        platform: 'test',
        pubkey: keyPair.publicKeyB64,
        capabilities: [],
        clusters: [],
        verification_token: verifyRes.body.token,
        omniscience_acknowledged: true,
        article22_consent: true,
      });

    expect(res.status).toBe(400);
  });

  it('rejects XSS in capability tags', async () => {
    const keyPair = generateTestKeyPair();
    const body = { capabilities: ['<script>alert(1)</script>'] };
    const auth = signRequest(keyPair, 'dawn-001', 'POST', '/discover-capability', body);

    mockSession.run.mockResolvedValue({
      records: [{
        get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
      }],
    });

    const res = await request(app)
      .post('/discover-capability')
      .set('Authorization', auth)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('rejects path traversal in target_identifier', async () => {
    const keyPair = generateTestKeyPair();
    const body = { target_identifier: '../../etc/passwd' };
    const auth = signRequest(keyPair, 'dawn-001', 'POST', '/discover-broker', body);

    mockSession.run.mockResolvedValue({
      records: [{
        get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
      }],
    });

    const res = await request(app)
      .post('/discover-broker')
      .set('Authorization', auth)
      .send(body);

    expect(res.status).toBe(400);
  });
});
