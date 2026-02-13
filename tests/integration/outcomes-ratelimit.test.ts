/**
 * Integration Tests: Outcome Verification + Rate Limiting
 *
 * Tests the outcome endpoints (create, report, get, stats, pending)
 * and rate limiting middleware via supertest.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { generateTestKeyPair, signRequest } from '../helpers/crypto';

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
let keyPair: ReturnType<typeof generateTestKeyPair>;
const AGENT_ID = 'test-agent-outcomes';

function authFor(method: string, path: string, body: any = {}) {
  return signRequest(keyPair, AGENT_ID, method, path, body);
}

function mockAuthAccept() {
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
  keyPair = generateTestKeyPair();
  const { createApp } = await import('../../src/app');
  app = createApp();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuthAccept();

  // Clear replay cache between tests to prevent false replay detection
  const { clearReplayCache } = await import('../../src/middleware/auth');
  clearReplayCache();
});

// Unique ID generator to prevent outcome collisions across tests
let idCounter = 0;
function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${++idCounter}`;
}

describe('Outcome Endpoints', () => {
  describe('POST /outcomes', () => {
    it('creates an outcome record', async () => {
      const body = {
        introduction_id: uniqueId('intro'),
        requester_id: AGENT_ID,
        broker_id: 'broker-001',
        target_id: 'target-001',
      };

      const res = await request(app)
        .post('/outcomes')
        .set('Authorization', authFor('POST', '/outcomes', body))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.outcome.introduction_id).toBe(body.introduction_id);
      expect(res.body.outcome.resolved_status).toBeNull();
    });

    it('rejects missing fields', async () => {
      const body = { introduction_id: 'x' };

      const res = await request(app)
        .post('/outcomes')
        .set('Authorization', authFor('POST', '/outcomes', body))
        .send(body);

      expect(res.status).toBe(400);
    });

    it('rejects duplicate introduction_id', async () => {
      const introId = uniqueId('intro-dup');

      const body1 = {
        introduction_id: introId,
        requester_id: AGENT_ID,
        broker_id: 'broker-001',
        target_id: 'target-001',
      };

      // First create succeeds
      const res1 = await request(app)
        .post('/outcomes')
        .set('Authorization', authFor('POST', '/outcomes', body1))
        .send(body1);
      expect(res1.status).toBe(201);

      // Second create with same intro_id but different body to avoid replay
      const body2 = {
        introduction_id: introId,
        requester_id: AGENT_ID,
        broker_id: 'broker-002', // Different broker to avoid exact replay
        target_id: 'target-002',
      };

      const res2 = await request(app)
        .post('/outcomes')
        .set('Authorization', authFor('POST', '/outcomes', body2))
        .send(body2);

      expect(res2.status).toBe(409);
    });
  });

  describe('POST /report-outcome', () => {
    let introId: string;

    beforeEach(async () => {
      introId = uniqueId('intro-report');
      const body = {
        introduction_id: introId,
        requester_id: AGENT_ID,
        broker_id: 'broker-001',
        target_id: 'target-001',
      };
      await request(app)
        .post('/outcomes')
        .set('Authorization', authFor('POST', '/outcomes', body))
        .send(body);
    });

    it('accepts a report from the requester', async () => {
      const body = {
        introduction_id: introId,
        status: 'successful',
        evidence_type: 'requester_report',
      };

      const res = await request(app)
        .post('/report-outcome')
        .set('Authorization', authFor('POST', '/report-outcome', body))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.outcome.reports_count).toBe(1);
    });

    it('rejects invalid status', async () => {
      const body = {
        introduction_id: introId,
        status: 'maybe',
        evidence_type: 'requester_report',
      };

      const res = await request(app)
        .post('/report-outcome')
        .set('Authorization', authFor('POST', '/report-outcome', body))
        .send(body);

      expect(res.status).toBe(400);
    });

    it('rejects invalid evidence_type', async () => {
      const body = {
        introduction_id: introId,
        status: 'successful',
        evidence_type: 'magic',
      };

      const res = await request(app)
        .post('/report-outcome')
        .set('Authorization', authFor('POST', '/report-outcome', body))
        .send(body);

      expect(res.status).toBe(400);
    });
  });

  describe('GET /outcomes/:id', () => {
    it('returns 400 for unknown introduction', async () => {
      const res = await request(app)
        .get('/outcomes/nonexistent')
        .set('Authorization', authFor('GET', '/outcomes/nonexistent'));

      expect(res.status).toBe(400);
    });

    it('returns outcome after creation', async () => {
      const introId = uniqueId('intro-get');
      const body = {
        introduction_id: introId,
        requester_id: AGENT_ID,
        broker_id: 'broker-001',
        target_id: 'target-001',
      };
      await request(app)
        .post('/outcomes')
        .set('Authorization', authFor('POST', '/outcomes', body))
        .send(body);

      const res = await request(app)
        .get(`/outcomes/${introId}`)
        .set('Authorization', authFor('GET', `/outcomes/${introId}`));

      expect(res.status).toBe(200);
      expect(res.body.outcome.introduction_id).toBe(introId);
    });
  });

  describe('GET /outcomes/agent/:agentId/stats', () => {
    it('returns stats', async () => {
      const res = await request(app)
        .get(`/outcomes/agent/${AGENT_ID}/stats`)
        .set('Authorization', authFor('GET', `/outcomes/agent/${AGENT_ID}/stats`));

      expect(res.status).toBe(200);
      expect(res.body.stats).toBeDefined();
      expect(typeof res.body.stats.total).toBe('number');
    });
  });

  describe('GET /outcomes/pending', () => {
    it('returns pending outcomes list', async () => {
      const res = await request(app)
        .get('/outcomes/pending')
        .set('Authorization', authFor('GET', '/outcomes/pending'));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.pending)).toBe(true);
      expect(typeof res.body.count).toBe('number');
    });
  });
});

describe('Rate Limiting', () => {
  it('returns rate limit headers on public endpoints', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('public endpoints use public tier (limit=60)', async () => {
    // Use a unique endpoint for this test to avoid shared bucket issues
    const res = await request(app).get('/.well-known/jwks.json');

    expect(res.headers['x-ratelimit-limit']).toBe('60');
  });

  it('authenticated endpoints include rate limit headers', async () => {
    const res = await request(app)
      .get('/consent')
      .set('Authorization', authFor('GET', '/consent'));

    // Should have rate limit headers regardless of tier
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(parseInt(res.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
  });
});
