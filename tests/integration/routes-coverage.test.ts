/**
 * Integration Tests: Route Coverage Expansion
 *
 * Tests API routes not covered by api.test.ts and e2e-flow.test.ts:
 * - Consent endpoints (grant, withdraw, export, erase)
 * - Webhook endpoints (register, list, unregister)
 * - IQS evaluate endpoint
 * - Outcomes detail endpoints (pending, agent stats, get by ID)
 * - Payment endpoints (account, balance, deposit, history, pricing)
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
const keyPair = generateTestKeyPair();
const AGENT_ID = 'coverage-agent';

function auth(method: string, path: string, body: any = {}) {
  return signRequest(keyPair, AGENT_ID, method, path, body);
}

function mockAuthLookup() {
  mockSession.run.mockImplementation(async (query: string) => {
    if (query.includes('RETURN a.pubkey')) {
      return {
        records: [{
          get: (key: string) => key === 'pubkey' ? keyPair.publicKeyB64 : null,
        }],
      };
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
  mockSession.run.mockResolvedValue({ records: [] });
  mockDriver.session.mockReturnValue(mockSession);
  const { clearReplayCache } = await import('../../src/middleware/auth');
  clearReplayCache();
  const { limiter } = await import('../../src/middleware/ratelimit');
  limiter.reset();
});

// ========================
// Consent Endpoints
// ========================

describe('Consent Endpoints', () => {
  it('GET /consent — returns consent status', async () => {
    mockAuthLookup();
    const res = await request(app)
      .get('/consent')
      .set('Authorization', auth('GET', '/consent'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('descriptions');
    expect(res.body).toHaveProperty('consents');
  });

  it('POST /consent/grant — grants consent', async () => {
    mockAuthLookup();
    const body = { purpose: 'iqs_scoring' };
    const res = await request(app)
      .post('/consent/grant')
      .set('Authorization', auth('POST', '/consent/grant', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.consent).toHaveProperty('purpose', 'iqs_scoring');
    expect(res.body.consent).toHaveProperty('granted', true);
  });

  it('POST /consent/grant — rejects invalid purpose', async () => {
    mockAuthLookup();
    const body = { purpose: 'invalid_purpose' };
    const res = await request(app)
      .post('/consent/grant')
      .set('Authorization', auth('POST', '/consent/grant', body))
      .send(body);

    expect(res.status).toBe(400);
  });

  it('POST /consent/withdraw — withdraws consent', async () => {
    mockAuthLookup();

    // First grant
    const grantBody = { purpose: 'data_sharing' };
    await request(app)
      .post('/consent/grant')
      .set('Authorization', auth('POST', '/consent/grant', grantBody))
      .send(grantBody);

    // Clear replay cache for next request
    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // Then withdraw
    const withdrawBody = { purpose: 'data_sharing' };
    const res = await request(app)
      .post('/consent/withdraw')
      .set('Authorization', auth('POST', '/consent/withdraw', withdrawBody))
      .send(withdrawBody);

    expect(res.status).toBe(200);
    expect(res.body.consent).toHaveProperty('purpose', 'data_sharing');
    expect(res.body.consent).toHaveProperty('granted', false);
  });

  it('POST /consent/withdraw — rejects invalid purpose', async () => {
    mockAuthLookup();
    const body = { purpose: 'nonexistent' };
    const res = await request(app)
      .post('/consent/withdraw')
      .set('Authorization', auth('POST', '/consent/withdraw', body))
      .send(body);

    expect(res.status).toBe(400);
  });

  it('GET /consent/export — exports consent data', async () => {
    mockAuthLookup();
    const res = await request(app)
      .get('/consent/export')
      .set('Authorization', auth('GET', '/consent/export'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('history');
    expect(res.body).toHaveProperty('descriptions');
  });

  it('DELETE /consent/erase — erases consent data', async () => {
    mockAuthLookup();
    const res = await request(app)
      .delete('/consent/erase')
      .set('Authorization', auth('DELETE', '/consent/erase'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('erased');
    expect(res.body).toHaveProperty('message');
  });
});

// ========================
// Webhook Endpoints
// ========================

describe('Webhook Endpoints', () => {
  it('POST /webhooks/register — registers webhook', async () => {
    mockAuthLookup();
    const body = {
      endpoint_url: 'https://example.com/webhook-reg',
      event_types: ['outcome_reported', 'iqs_guidance'],
    };

    const res = await request(app)
      .post('/webhooks/register')
      .set('Authorization', auth('POST', '/webhooks/register', body))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.registration).toHaveProperty('endpoint_url', 'https://example.com/webhook-reg');
    expect(res.body.registration.event_types).toEqual(['outcome_reported', 'iqs_guidance']);
    expect(res.body.registration.active).toBe(true);
    expect(res.body).toHaveProperty('secret');
  });

  it('POST /webhooks/register — rejects missing fields', async () => {
    mockAuthLookup();
    const body = { endpoint_url: 'https://example.com/webhook' }; // missing event_types

    const res = await request(app)
      .post('/webhooks/register')
      .set('Authorization', auth('POST', '/webhooks/register', body))
      .send(body);

    expect(res.status).toBe(400);
  });

  it('GET /webhooks — lists registrations', async () => {
    mockAuthLookup();

    // Register first
    const registerBody = {
      endpoint_url: 'https://example.com/hook',
      event_types: ['outcome_reported'],
    };
    await request(app)
      .post('/webhooks/register')
      .set('Authorization', auth('POST', '/webhooks/register', registerBody))
      .send(registerBody);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // List
    const res = await request(app)
      .get('/webhooks')
      .set('Authorization', auth('GET', '/webhooks'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.registrations)).toBe(true);
  });

  it('DELETE /webhooks/unregister — registers then removes webhook', async () => {
    // Use a unique agent for this test to avoid cross-test state
    const unregKeyPair = generateTestKeyPair();
    const UNREG_AGENT = 'unreg-webhook-agent';

    function unregAuth(method: string, path: string, body: any = {}) {
      return signRequest(unregKeyPair, UNREG_AGENT, method, path, body);
    }

    mockSession.run.mockImplementation(async (query: string) => {
      if (query.includes('RETURN a.pubkey')) {
        return {
          records: [{
            get: (key: string) => key === 'pubkey' ? unregKeyPair.publicKeyB64 : null,
          }],
        };
      }
      return { records: [] };
    });

    // Register first
    const registerBody = {
      endpoint_url: 'https://example.com/remove-me',
      event_types: ['outcome_reported'],
    };
    const regRes = await request(app)
      .post('/webhooks/register')
      .set('Authorization', unregAuth('POST', '/webhooks/register', registerBody))
      .send(registerBody);
    expect(regRes.status).toBe(201);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // Unregister
    const body = { endpoint_url: 'https://example.com/remove-me' };
    const res = await request(app)
      .delete('/webhooks/unregister')
      .set('Authorization', unregAuth('DELETE', '/webhooks/unregister', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });

  it('DELETE /webhooks/unregister — rejects missing endpoint_url', async () => {
    mockAuthLookup();
    const body = {};
    const res = await request(app)
      .delete('/webhooks/unregister')
      .set('Authorization', auth('DELETE', '/webhooks/unregister', body))
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ========================
// IQS Evaluate Endpoint
// ========================

describe('IQS Endpoints', () => {
  it('POST /iqs/evaluate — rejects without consent', async () => {
    mockAuthLookup();
    const body = { target_id: 'some-agent' };

    const res = await request(app)
      .post('/iqs/evaluate')
      .set('Authorization', auth('POST', '/iqs/evaluate', body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('iqs_scoring consent');
  });

  it('POST /iqs/evaluate — returns band with consent', async () => {
    mockAuthLookup();

    // Grant IQS consent first
    const consentBody = { purpose: 'iqs_scoring' };
    await request(app)
      .post('/consent/grant')
      .set('Authorization', auth('POST', '/consent/grant', consentBody))
      .send(consentBody);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // Evaluate IQS
    const body = {
      target_id: 'target-agent',
      requester_capabilities: ['ai-research', 'nlp'],
      target_capabilities: ['ai-research', 'computer-vision'],
      broker_success_count: 5,
      broker_total_intros: 10,
      hops: 2,
    };

    const res = await request(app)
      .post('/iqs/evaluate')
      .set('Authorization', auth('POST', '/iqs/evaluate', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('band');
    expect(['high', 'medium', 'low']).toContain(res.body.band);
    expect(res.body).toHaveProperty('recommendation');
    expect(res.body).toHaveProperty('components_received', true);
  });

  it('POST /iqs/evaluate — rejects missing target_id', async () => {
    mockAuthLookup();

    // Grant consent
    const consentBody = { purpose: 'iqs_scoring' };
    await request(app)
      .post('/consent/grant')
      .set('Authorization', auth('POST', '/consent/grant', consentBody))
      .send(consentBody);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    const body = {}; // missing target_id

    const res = await request(app)
      .post('/iqs/evaluate')
      .set('Authorization', auth('POST', '/iqs/evaluate', body))
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ========================
// Outcomes Detail Endpoints
// ========================

describe('Outcomes Detail Endpoints', () => {
  const agentKeyPair = generateTestKeyPair();
  const OUTCOME_AGENT = 'outcomes-agent';

  function outcomeAuth(method: string, path: string, body: any = {}) {
    return signRequest(agentKeyPair, OUTCOME_AGENT, method, path, body);
  }

  function mockOutcomeAuth() {
    mockSession.run.mockImplementation(async (query: string) => {
      if (query.includes('RETURN a.pubkey')) {
        return {
          records: [{
            get: (key: string) => key === 'pubkey' ? agentKeyPair.publicKeyB64 : null,
          }],
        };
      }
      return { records: [] };
    });
  }

  it('GET /outcomes/pending — returns pending outcomes', async () => {
    mockOutcomeAuth();

    const res = await request(app)
      .get('/outcomes/pending')
      .set('Authorization', outcomeAuth('GET', '/outcomes/pending'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pending)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });

  it('GET /outcomes/agent/:agentId/stats — returns agent stats', async () => {
    mockOutcomeAuth();

    const res = await request(app)
      .get(`/outcomes/agent/${OUTCOME_AGENT}/stats`)
      .set('Authorization', outcomeAuth('GET', `/outcomes/agent/${OUTCOME_AGENT}/stats`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stats');
  });

  it('GET /outcomes/:id — returns 400 for nonexistent outcome', async () => {
    mockOutcomeAuth();

    const res = await request(app)
      .get('/outcomes/nonexistent-intro')
      .set('Authorization', outcomeAuth('GET', '/outcomes/nonexistent-intro'));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not found');
  });

  it('GET /outcomes/:id — returns outcome when it exists', async () => {
    mockOutcomeAuth();

    // Create outcome first
    const createBody = {
      introduction_id: 'detail-intro-1',
      requester_id: OUTCOME_AGENT,
      broker_id: 'broker-1',
      target_id: 'target-1',
    };
    await request(app)
      .post('/outcomes')
      .set('Authorization', outcomeAuth('POST', '/outcomes', createBody))
      .send(createBody);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // Fetch it
    const res = await request(app)
      .get('/outcomes/detail-intro-1')
      .set('Authorization', outcomeAuth('GET', '/outcomes/detail-intro-1'));

    expect(res.status).toBe(200);
    expect(res.body.outcome).toHaveProperty('introduction_id', 'detail-intro-1');
  });
});

// ========================
// Payment Endpoints
// ========================

describe('Payment Endpoints', () => {
  const payKeyPair = generateTestKeyPair();
  const PAY_AGENT = 'payment-agent';

  function payAuth(method: string, path: string, body: any = {}) {
    return signRequest(payKeyPair, PAY_AGENT, method, path, body);
  }

  function mockPayAuth() {
    mockSession.run.mockImplementation(async (query: string) => {
      if (query.includes('RETURN a.pubkey')) {
        return {
          records: [{
            get: (key: string) => key === 'pubkey' ? payKeyPair.publicKeyB64 : null,
          }],
        };
      }
      return { records: [] };
    });
  }

  it('POST /payments/account — creates payment account', async () => {
    mockPayAuth();
    const body = { tier: 'founding' };

    const res = await request(app)
      .post('/payments/account')
      .set('Authorization', payAuth('POST', '/payments/account', body))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.account).toHaveProperty('agent_id', PAY_AGENT);
    expect(res.body.account).toHaveProperty('broker_tier', 'founding');
    expect(res.body.account).toHaveProperty('balance', 0);
  });

  it('POST /payments/account — rejects duplicate account', async () => {
    mockPayAuth();
    const body = { tier: 'standard' };

    // Create first
    await request(app)
      .post('/payments/account')
      .set('Authorization', payAuth('POST', '/payments/account', body))
      .send(body);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // Try duplicate
    const res = await request(app)
      .post('/payments/account')
      .set('Authorization', payAuth('POST', '/payments/account', body))
      .send(body);

    expect(res.status).toBe(409);
  });

  it('GET /payments/balance — returns balance', async () => {
    mockPayAuth();

    // Create account first
    const createBody = { tier: 'standard' };
    await request(app)
      .post('/payments/account')
      .set('Authorization', payAuth('POST', '/payments/account', createBody))
      .send(createBody);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    const res = await request(app)
      .get('/payments/balance')
      .set('Authorization', payAuth('GET', '/payments/balance'));

    expect(res.status).toBe(200);
    expect(res.body.balance).toHaveProperty('balance');
  });

  it('GET /payments/balance — rejects unauthenticated', async () => {
    const res = await request(app).get('/payments/balance');
    expect(res.status).toBe(401);
  });

  it('POST /payments/deposit — deposits funds', async () => {
    mockPayAuth();

    // Create account first
    const createBody = { tier: 'standard' };
    await request(app)
      .post('/payments/account')
      .set('Authorization', payAuth('POST', '/payments/account', createBody))
      .send(createBody);

    const { clearReplayCache } = await import('../../src/middleware/auth');
    clearReplayCache();

    // Deposit
    const body = { amount: 100 };
    const res = await request(app)
      .post('/payments/deposit')
      .set('Authorization', payAuth('POST', '/payments/deposit', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.entry).toHaveProperty('amount', 100);
    expect(res.body.message).toContain('Simulated deposit');
  });

  it('POST /payments/deposit — rejects non-positive amount', async () => {
    mockPayAuth();
    const body = { amount: -5 };

    const res = await request(app)
      .post('/payments/deposit')
      .set('Authorization', payAuth('POST', '/payments/deposit', body))
      .send(body);

    expect(res.status).toBe(400);
  });

  it('GET /payments/history — returns transaction history', async () => {
    mockPayAuth();

    // Create account and make a deposit
    const createBody = { tier: 'standard' };
    await request(app)
      .post('/payments/account')
      .set('Authorization', payAuth('POST', '/payments/account', createBody))
      .send(createBody);

    const { clearReplayCache: cr1 } = await import('../../src/middleware/auth');
    cr1();

    const depositBody = { amount: 50 };
    await request(app)
      .post('/payments/deposit')
      .set('Authorization', payAuth('POST', '/payments/deposit', depositBody))
      .send(depositBody);

    const { clearReplayCache: cr2 } = await import('../../src/middleware/auth');
    cr2();

    const res = await request(app)
      .get('/payments/history')
      .set('Authorization', payAuth('GET', '/payments/history'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it('GET /payments/pricing — returns pricing (public)', async () => {
    const res = await request(app).get('/payments/pricing');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pricing');
    expect(res.body.pricing).toHaveProperty('broker_discovery');
  });
});

// ========================
// Outcome Error Paths (lines 447-456)
// ========================

describe('Outcome Report Error Paths', () => {
  // Use a dedicated agent for outcome error tests
  const outcomeKeyPair = generateTestKeyPair();
  const OUTCOME_AGENT = 'outcome-error-agent';

  function outcomeAuth(method: string, path: string, body: any = {}) {
    return signRequest(outcomeKeyPair, OUTCOME_AGENT, method, path, body);
  }

  function mockOutcomeAuthLookup() {
    mockSession.run.mockImplementation(async (query: string) => {
      if (query.includes('RETURN a.pubkey')) {
        return {
          records: [{
            get: (key: string) => key === 'pubkey' ? outcomeKeyPair.publicKeyB64 : null,
          }],
        };
      }
      return { records: [] };
    });
  }

  it('POST /report-outcome — 400 when missing required fields', async () => {
    mockOutcomeAuthLookup();

    // Missing status and evidence_type
    const body = { introduction_id: 'some-intro' };
    const res = await request(app)
      .post('/report-outcome')
      .set('Authorization', outcomeAuth('POST', '/report-outcome', body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing');
  });

  it('POST /report-outcome — 400 when invalid status value', async () => {
    const { clearReplayCache: crc } = await import('../../src/middleware/auth');
    crc();
    mockOutcomeAuthLookup();

    const body = {
      introduction_id: 'some-intro',
      status: 'invalid_status',
      evidence_type: 'requester_report',
    };
    const res = await request(app)
      .post('/report-outcome')
      .set('Authorization', outcomeAuth('POST', '/report-outcome', body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid status');
  });

  it('POST /report-outcome — 400 when invalid evidence_type', async () => {
    const { clearReplayCache: crc } = await import('../../src/middleware/auth');
    crc();
    mockOutcomeAuthLookup();

    const body = {
      introduction_id: 'some-intro',
      status: 'successful',
      evidence_type: 'invalid_evidence',
    };
    const res = await request(app)
      .post('/report-outcome')
      .set('Authorization', outcomeAuth('POST', '/report-outcome', body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid evidence_type');
  });

  it('POST /report-outcome — 400 when outcome not found', async () => {
    const { clearReplayCache: crc2 } = await import('../../src/middleware/auth');
    crc2();
    mockOutcomeAuthLookup();

    const body = {
      introduction_id: 'nonexistent-intro-id',
      status: 'successful',
      evidence_type: 'requester_report',
    };

    const res = await request(app)
      .post('/report-outcome')
      .set('Authorization', outcomeAuth('POST', '/report-outcome', body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Outcome not found');
  });

  it('POST /report-outcome — 409 when role already reported', async () => {
    mockOutcomeAuthLookup();

    // First create an outcome (POST /outcomes) — needs requester_id field
    const createBody = {
      introduction_id: 'dup-report-intro',
      requester_id: OUTCOME_AGENT,
      target_id: 'target-agent-dup',
      broker_id: 'broker-agent-dup',
    };

    const createRes = await request(app)
      .post('/outcomes')
      .set('Authorization', outcomeAuth('POST', '/outcomes', createBody))
      .send(createBody);

    expect(createRes.status).toBe(201);

    const { clearReplayCache: cr1 } = await import('../../src/middleware/auth');
    cr1();

    // First report succeeds
    const reportBody = {
      introduction_id: 'dup-report-intro',
      status: 'successful',
      evidence_type: 'requester_report',
    };

    const firstReport = await request(app)
      .post('/report-outcome')
      .set('Authorization', outcomeAuth('POST', '/report-outcome', reportBody))
      .send(reportBody);

    expect(firstReport.status).toBe(201);

    const { clearReplayCache: cr2 } = await import('../../src/middleware/auth');
    cr2();

    // Second report from same role should fail
    const res = await request(app)
      .post('/report-outcome')
      .set('Authorization', outcomeAuth('POST', '/report-outcome', reportBody))
      .send(reportBody);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already reported');
  });

  it('POST /report-outcome — 401 when not a party', async () => {
    // Create outcome with different requester than our auth agent
    const otherKeyPair = generateTestKeyPair();
    const OTHER_AGENT = 'other-outcome-agent';

    function otherAuth(method: string, path: string, body: any = {}) {
      return signRequest(otherKeyPair, OTHER_AGENT, method, path, body);
    }

    // Mock auth to resolve both agents
    mockSession.run.mockImplementation(async (query: string, params: any) => {
      if (query.includes('RETURN a.pubkey')) {
        if (params?.agentId === OUTCOME_AGENT) {
          return { records: [{ get: () => outcomeKeyPair.publicKeyB64 }] };
        }
        if (params?.agentId === OTHER_AGENT) {
          return { records: [{ get: () => otherKeyPair.publicKeyB64 }] };
        }
      }
      return { records: [] };
    });

    // Create outcome where OUTCOME_AGENT is the requester
    const createBody = {
      introduction_id: 'not-party-intro',
      requester_id: OUTCOME_AGENT,
      target_id: 'target-xxx',
      broker_id: 'broker-xxx',
    };

    await request(app)
      .post('/outcomes')
      .set('Authorization', outcomeAuth('POST', '/outcomes', createBody))
      .send(createBody);

    const { clearReplayCache: cr } = await import('../../src/middleware/auth');
    cr();

    // OTHER_AGENT tries to report — not a party to this intro
    const reportBody = {
      introduction_id: 'not-party-intro',
      status: 'successful',
      evidence_type: 'requester_report',
    };

    const res = await request(app)
      .post('/report-outcome')
      .set('Authorization', otherAuth('POST', '/report-outcome', reportBody))
      .send(reportBody);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('not a party');
  });
});

// ========================
// Payment Account Error Paths (line 678)
// ========================

describe('Payment Account Error Paths', () => {
  const payErrKeyPair = generateTestKeyPair();
  const PAY_ERR_AGENT = 'pay-err-agent';

  function payErrAuth(method: string, path: string, body: any = {}) {
    return signRequest(payErrKeyPair, PAY_ERR_AGENT, method, path, body);
  }

  function mockPayErrAuth() {
    mockSession.run.mockImplementation(async (query: string) => {
      if (query.includes('RETURN a.pubkey')) {
        return {
          records: [{
            get: (key: string) => key === 'pubkey' ? payErrKeyPair.publicKeyB64 : null,
          }],
        };
      }
      return { records: [] };
    });
  }

  it('POST /payments/account — 409 when account already exists', async () => {
    mockPayErrAuth();

    const body = { tier: 'founding' };

    // First creation succeeds
    const first = await request(app)
      .post('/payments/account')
      .set('Authorization', payErrAuth('POST', '/payments/account', body))
      .send(body);

    expect(first.status).toBe(201);

    const { clearReplayCache: cr } = await import('../../src/middleware/auth');
    cr();

    // Second creation should conflict
    const res = await request(app)
      .post('/payments/account')
      .set('Authorization', payErrAuth('POST', '/payments/account', body))
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already exists');
  });

  it('GET /payments/balance — 400 when no payment account', async () => {
    // Use a fresh agent that has NO payment account
    const balKeyPair = generateTestKeyPair();
    const BAL_AGENT = 'balance-no-acct-agent';

    function balAuth(method: string, path: string, body: any = {}) {
      return signRequest(balKeyPair, BAL_AGENT, method, path, body);
    }

    mockSession.run.mockImplementation(async (query: string) => {
      if (query.includes('RETURN a.pubkey')) {
        return {
          records: [{
            get: (key: string) => key === 'pubkey' ? balKeyPair.publicKeyB64 : null,
          }],
        };
      }
      return { records: [] };
    });

    const res = await request(app)
      .get('/payments/balance')
      .set('Authorization', balAuth('GET', '/payments/balance'));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('No payment account');
  });
});
