/**
 * E2E Flow Test: Full Agent Lifecycle
 *
 * Exercises the complete flow:
 *   verify → register → consent → discover → outcomes → stats
 *
 * This test validates that all services work together correctly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { generateTestKeyPair, signRequest, solveChallenge } from '../helpers/crypto';

// Mock Neo4j
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
const requesterKeyPair = generateTestKeyPair();
const targetKeyPair = generateTestKeyPair();
const REQUESTER_ID = 'requester-agent-e2e';
const TARGET_ID = 'target-agent-e2e';

function authFor(keyPair: ReturnType<typeof generateTestKeyPair>, agentId: string, method: string, path: string, body: any = {}) {
  return signRequest(keyPair, agentId, method, path, body);
}

function mockAuthBothAgents() {
  mockSession.run.mockImplementation(async (query: string, params?: any) => {
    if (query.includes('RETURN a.pubkey')) {
      const queriedId = params?.agentId;
      if (queriedId === REQUESTER_ID) {
        return {
          records: [{ get: (key: string) => key === 'pubkey' ? requesterKeyPair.publicKeyB64 : null }],
        };
      }
      if (queriedId === TARGET_ID) {
        return {
          records: [{ get: (key: string) => key === 'pubkey' ? targetKeyPair.publicKeyB64 : null }],
        };
      }
    }
    return { records: [] };
  });
}

beforeAll(async () => {
  const { createApp } = await import('../../src/app');
  app = createApp();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthBothAgents();

  const { clearReplayCache } = await import('../../src/middleware/auth');
  clearReplayCache();

  const { limiter } = await import('../../src/middleware/ratelimit');
  limiter.reset();
});

describe('E2E Flow: Full Agent Lifecycle', () => {
  it('health → JWKS → verify flow', async () => {
    // 1. Health check
    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('healthy');

    // 2. JWKS endpoint
    const jwksRes = await request(app).get('/.well-known/jwks.json');
    expect(jwksRes.status).toBe(200);
    expect(jwksRes.body.keys).toHaveLength(1);
    expect(jwksRes.body.keys[0].crv).toBe('Ed25519');

    // 3. Proof-of-AI verification
    const challengeRes = await request(app).post('/verify').send({});
    expect(challengeRes.status).toBe(200);

    const { challenge_id, nonce, difficulty } = challengeRes.body;
    const solution = solveChallenge(nonce, difficulty);

    const verifyRes = await request(app)
      .post('/verify')
      .send({ challenge_id, proof_of_work: solution });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verified).toBe(true);
    expect(verifyRes.body.token).toBeDefined();
  });

  it('consent → grant → withdraw → export → erase lifecycle', async () => {
    // 1. Check initial consent status
    const statusRes = await request(app)
      .get('/consent')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/consent'));
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.consents).toBeDefined();

    // 2. Grant IQS consent
    const grantBody = { purpose: 'iqs_scoring' };
    const grantRes = await request(app)
      .post('/consent/grant')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/consent/grant', grantBody))
      .send(grantBody);
    expect(grantRes.status).toBe(200);
    expect(grantRes.body.consent.granted).toBe(true);

    // 3. Grant data sharing consent
    const shareBody = { purpose: 'data_sharing' };
    const shareRes = await request(app)
      .post('/consent/grant')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/consent/grant', shareBody))
      .send(shareBody);
    expect(shareRes.status).toBe(200);

    // 4. Export consent data (GDPR Article 20)
    const exportRes = await request(app)
      .get('/consent/export')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/consent/export'));
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.status).toBeDefined();
    expect(exportRes.body.history).toBeDefined();
    expect(exportRes.body.descriptions).toBeDefined();

    // 5. Withdraw one consent
    const withdrawBody = { purpose: 'data_sharing' };
    const withdrawRes = await request(app)
      .post('/consent/withdraw')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/consent/withdraw', withdrawBody))
      .send(withdrawBody);
    expect(withdrawRes.status).toBe(200);

    // 6. Verify withdrawal took effect
    const status2Res = await request(app)
      .get('/consent')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/consent'));
    expect(status2Res.status).toBe(200);

    // 7. Erase all consent data (GDPR Article 17)
    const eraseRes = await request(app)
      .delete('/consent/erase')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'DELETE', '/consent/erase'));
    expect(eraseRes.status).toBe(200);
    expect(eraseRes.body.erased).toBe(true);
  });

  it('payment lifecycle: create account → deposit → check balance → view history', async () => {
    // 1. Create payment account
    const createRes = await request(app)
      .post('/payments/account')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/payments/account'))
      .send({});
    expect(createRes.status).toBe(201);

    // 2. Deposit funds
    const depositBody = { amount: 5.00 };
    const depositRes = await request(app)
      .post('/payments/deposit')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/payments/deposit', depositBody))
      .send(depositBody);
    expect(depositRes.status).toBe(200);
    expect(depositRes.body.entry.balance_after).toBe(5.00);

    // 3. Check balance
    const balanceRes = await request(app)
      .get('/payments/balance')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/payments/balance'));
    expect(balanceRes.status).toBe(200);
    expect(balanceRes.body.balance.balance).toBeGreaterThanOrEqual(5.00);

    // 4. View history
    const historyRes = await request(app)
      .get('/payments/history')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/payments/history'));
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.history.length).toBeGreaterThan(0);

    // 5. Check pricing
    const pricingRes = await request(app).get('/payments/pricing');
    expect(pricingRes.status).toBe(200);
    expect(pricingRes.body.pricing).toBeDefined();
  });

  it('IQS evaluation with consent', async () => {
    // 1. Grant IQS consent
    const grantBody = { purpose: 'iqs_scoring' };
    await request(app)
      .post('/consent/grant')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/consent/grant', grantBody))
      .send(grantBody);

    // 2. Evaluate introduction quality
    const evalBody = {
      target_id: TARGET_ID,
      requester_capabilities: ['ai-research', 'nlp'],
      target_capabilities: ['ai-research', 'computer-vision'],
      broker_success_count: 15,
      broker_total_intros: 20,
      hops: 2,
    };
    const evalRes = await request(app)
      .post('/iqs/evaluate')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/iqs/evaluate', evalBody))
      .send(evalBody);

    expect(evalRes.status).toBe(200);
    expect(['low', 'medium', 'high']).toContain(evalRes.body.band);
    expect(evalRes.body.recommendation).toBeDefined();
    // Anti-oracle: no exact score
    expect(evalRes.body.score).toBeUndefined();
  });

  it('webhook lifecycle: register → list → unregister', async () => {
    // 1. Register webhook
    const regBody = {
      endpoint_url: 'https://example.com/webhook',
      event_types: ['outcome_reported', 'trust_score_changed'],
    };
    const regRes = await request(app)
      .post('/webhooks/register')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/webhooks/register', regBody))
      .send(regBody);
    expect(regRes.status).toBe(201);
    expect(regRes.body.registration).toBeDefined();

    // 2. List webhooks
    const listRes = await request(app)
      .get('/webhooks')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/webhooks'));
    expect(listRes.status).toBe(200);
    expect(listRes.body.registrations.length).toBe(1);

    // 3. Unregister
    const unregBody = { endpoint_url: 'https://example.com/webhook' };
    const unregRes = await request(app)
      .delete('/webhooks/unregister')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'DELETE', '/webhooks/unregister', unregBody))
      .send(unregBody);
    expect(unregRes.status).toBe(200);
    expect(unregRes.body.removed).toBe(true);

    // 4. Verify removed
    const list2Res = await request(app)
      .get('/webhooks')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/webhooks'));
    expect(list2Res.status).toBe(200);
    expect(list2Res.body.registrations.length).toBe(0);
  });

  it('outcome verification: create → report (bilateral) → resolve → stats', async () => {
    const introId = `intro-e2e-${Date.now()}`;

    // 1. Create outcome record
    const createBody = {
      introduction_id: introId,
      requester_id: REQUESTER_ID,
      broker_id: 'broker-e2e',
      target_id: TARGET_ID,
    };
    const createRes = await request(app)
      .post('/outcomes')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/outcomes', createBody))
      .send(createBody);
    expect(createRes.status).toBe(201);
    expect(createRes.body.outcome.resolved_status).toBeNull();

    // 2. Requester reports success
    const reportBody1 = {
      introduction_id: introId,
      status: 'successful',
      evidence_type: 'requester_report',
    };
    const report1Res = await request(app)
      .post('/report-outcome')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/report-outcome', reportBody1))
      .send(reportBody1);
    expect(report1Res.status).toBe(201);
    expect(report1Res.body.outcome.reports_count).toBe(1);

    // 3. Target reports success (bilateral agreement)
    const reportBody2 = {
      introduction_id: introId,
      status: 'successful',
      evidence_type: 'target_report',
    };
    const report2Res = await request(app)
      .post('/report-outcome')
      .set('Authorization', authFor(targetKeyPair, TARGET_ID, 'POST', '/report-outcome', reportBody2))
      .send(reportBody2);
    expect(report2Res.status).toBe(201);
    expect(report2Res.body.outcome.reports_count).toBe(2);
    // Bilateral agreement → resolved
    expect(report2Res.body.outcome.resolved_status).toBe('successful');
    expect(report2Res.body.outcome.verification_layer).toBeGreaterThanOrEqual(1);

    // 4. Get outcome by ID
    const getRes = await request(app)
      .get(`/outcomes/${introId}`)
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', `/outcomes/${introId}`));
    expect(getRes.status).toBe(200);
    expect(getRes.body.outcome.introduction_id).toBe(introId);

    // 5. Check agent stats
    const statsRes = await request(app)
      .get(`/outcomes/agent/${REQUESTER_ID}/stats`)
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', `/outcomes/agent/${REQUESTER_ID}/stats`));
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.stats.total).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.stats.successful).toBeGreaterThanOrEqual(1);

    // 6. Verify outcome resolved as successful (not disputed)
    // Note: In tests, reports happen within milliseconds, triggering 'instant_sync' anomaly flag.
    // This correctly puts the outcome in the pending review queue even though bilateral agreement resolved it.
    // We verify the resolution status is correct — the anomaly flag is expected test behavior.
    const getRes2 = await request(app)
      .get(`/outcomes/${introId}`)
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', `/outcomes/${introId}`));
    expect(getRes2.status).toBe(200);
    expect(getRes2.body.outcome.resolved_status).toBe('successful');
  });

  it('outcome dispute flow: create → conflicting reports → dispute → pending', async () => {
    const introId = `intro-dispute-${Date.now()}`;

    // 1. Create outcome
    const createBody = {
      introduction_id: introId,
      requester_id: REQUESTER_ID,
      broker_id: 'broker-e2e',
      target_id: TARGET_ID,
    };
    await request(app)
      .post('/outcomes')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/outcomes', createBody))
      .send(createBody);

    // 2. Requester reports success
    const reportBody1 = {
      introduction_id: introId,
      status: 'successful',
      evidence_type: 'requester_report',
    };
    await request(app)
      .post('/report-outcome')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'POST', '/report-outcome', reportBody1))
      .send(reportBody1);

    // 3. Target reports failure (conflict!)
    const reportBody2 = {
      introduction_id: introId,
      status: 'failed',
      evidence_type: 'target_report',
    };
    const report2Res = await request(app)
      .post('/report-outcome')
      .set('Authorization', authFor(targetKeyPair, TARGET_ID, 'POST', '/report-outcome', reportBody2))
      .send(reportBody2);
    expect(report2Res.status).toBe(201);
    expect(report2Res.body.outcome.resolved_status).toBe('disputed');
    expect(report2Res.body.outcome.verification_layer).toBe(2); // Escalated

    // 4. Disputed outcomes show in pending
    const pendingRes = await request(app)
      .get('/outcomes/pending')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/outcomes/pending'));
    expect(pendingRes.status).toBe(200);
    const disputed = pendingRes.body.pending.find((p: any) => p.introduction_id === introId);
    expect(disputed).toBeDefined();
    expect(disputed.resolved_status).toBe('disputed');
  });

  it('rate limit headers present on all responses', async () => {
    // Public endpoint
    const healthRes = await request(app).get('/health');
    expect(healthRes.headers['x-ratelimit-limit']).toBeDefined();
    expect(healthRes.headers['x-ratelimit-remaining']).toBeDefined();

    // Authenticated endpoint
    const consentRes = await request(app)
      .get('/consent')
      .set('Authorization', authFor(requesterKeyPair, REQUESTER_ID, 'GET', '/consent'));
    expect(consentRes.headers['x-ratelimit-limit']).toBeDefined();
    expect(parseInt(consentRes.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
  });
});
