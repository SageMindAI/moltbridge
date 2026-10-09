/**
 * Integration Tests: Pre-Escrow Trust Verification (PROP-881)
 *
 * Proves two things the unit tests cannot:
 *   1. The gate is reachable as an API, with real validation.
 *   2. The gate actually ENFORCES — a counterparty with a bad outcome record,
 *      built up through the real endpoints, is refused entry to the economic
 *      handoff at POST /outcomes.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { generateTestKeyPair, signRequest } from '../helpers/crypto';

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
const AGENT_ID = 'test-agent-preescrow';

function authFor(method: string, path: string, body: any = {}) {
  return signRequest(keyPair, AGENT_ID, method, path, body);
}

/** Auth lookups resolve; every other query returns nothing (no declared trust). */
function mockAuthAccept() {
  mockSession.run.mockImplementation(async (query: string) => {
    if (query.includes('RETURN a.pubkey')) {
      return {
        records: [{ get: (key: string) => (key === 'pubkey' ? keyPair.publicKeyB64 : null) }],
      };
    }
    return { records: [] };
  });
}

/** Auth lookups resolve AND the declared trust lookup returns a score. */
function mockWithDeclaredTrust(score: number) {
  mockSession.run.mockImplementation(async (query: string) => {
    if (query.includes('RETURN a.pubkey')) {
      return {
        records: [{ get: (key: string) => (key === 'pubkey' ? keyPair.publicKeyB64 : null) }],
      };
    }
    if (query.includes('RETURN a.trust_score')) {
      return {
        records: [{ get: (key: string) => (key === 'trust_score' ? score : null) }],
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
  mockDriver.session.mockReturnValue(mockSession);
  const neo4j = await import('../../src/db/neo4j');
  (neo4j.getDriver as any).mockReturnValue(mockDriver);
  (neo4j.verifyConnectivity as any).mockResolvedValue(true);
  mockAuthAccept();

  const { clearReplayCache } = await import('../../src/middleware/auth');
  clearReplayCache();
  const { limiter } = await import('../../src/middleware/ratelimit');
  limiter.reset();
});

let idCounter = 0;
function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${++idCounter}`;
}

async function postGate(body: any) {
  return request(app)
    .post('/trust/pre-escrow')
    .set('Authorization', authFor('POST', '/trust/pre-escrow', body))
    .send(body);
}

async function createIntroduction(body: any) {
  return request(app)
    .post('/outcomes')
    .set('Authorization', authFor('POST', '/outcomes', body))
    .send(body);
}

async function reportOutcome(body: any) {
  return request(app)
    .post('/report-outcome')
    .set('Authorization', authFor('POST', '/report-outcome', body))
    .send(body);
}

/**
 * Drive a counterparty to a disputed record through the real endpoints:
 * conflicting bilateral reports resolve to 'disputed'.
 */
async function accrueDisputedHistory(targetId: string, brokerId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const introId = uniqueId('intro-dispute');
    const createRes = await createIntroduction({
      introduction_id: introId,
      requester_id: AGENT_ID,
      broker_id: brokerId,
      target_id: targetId,
    });
    expect(createRes.status).toBe(201);

    await reportOutcome({ introduction_id: introId, status: 'successful', evidence_type: 'requester_report' });
    const second = await reportOutcome({ introduction_id: introId, status: 'failed', evidence_type: 'target_report' });
    expect(second.status).toBe(201);
    expect(second.body.outcome.resolved_status).toBe('disputed');
  }
}

describe('POST /trust/pre-escrow', () => {
  it('assesses an unknown counterparty as allowed on no evidence, and says so', async () => {
    const res = await postGate({ counterparty_agent_id: 'unknown-counterparty' });

    expect(res.status).toBe(200);
    expect(res.body.assessment.decision).toBe('allow');
    expect(res.body.assessment.evidence_basis).toBe('none');
    expect(res.body.assessment.reasons.map((r: any) => r.code)).toContain('no_history_default_allow');
    expect(res.body.enforcing).toBe(true);
  });

  it('denies self-dealing', async () => {
    const res = await postGate({ counterparty_agent_id: AGENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.assessment.decision).toBe('deny');
    expect(res.body.assessment.allowed).toBe(false);
    expect(res.body.assessment.reasons.map((r: any) => r.code)).toContain('self_dealing');
  });

  it('holds an unknown counterparty for review when the caller demands evidence', async () => {
    const res = await postGate({
      counterparty_agent_id: 'unknown-counterparty-2',
      trust_policy: { require_evidence: true },
    });

    expect(res.status).toBe(200);
    expect(res.body.assessment.decision).toBe('review');
    expect(res.body.assessment.allowed).toBe(false);
    expect(res.body.assessment.reasons.map((r: any) => r.code)).toContain('evidence_required_but_absent');
  });

  it('reads the declared trust score from the graph and applies an explicit floor', async () => {
    mockWithDeclaredTrust(0.12);
    const res = await postGate({
      counterparty_agent_id: 'low-trust-agent',
      trust_policy: { min_declared_trust: 0.6 },
    });

    expect(res.status).toBe(200);
    expect(res.body.assessment.declared_trust_score).toBeCloseTo(0.12, 4);
    expect(res.body.assessment.decision).toBe('deny');
    expect(res.body.assessment.reasons.map((r: any) => r.code)).toContain('declared_trust_below_floor');
  });

  it('distinguishes "could not measure" from "below the floor"', async () => {
    const res = await postGate({
      counterparty_agent_id: 'not-in-graph',
      trust_policy: { min_declared_trust: 0.6 },
    });

    expect(res.body.assessment.declared_trust_score).toBeNull();
    expect(res.body.assessment.decision).toBe('review');
    const codes = res.body.assessment.reasons.map((r: any) => r.code);
    expect(codes).toContain('declared_trust_unavailable');
    expect(codes).not.toContain('declared_trust_below_floor');
  });

  it('accepts a counterparty_role', async () => {
    const res = await postGate({ counterparty_agent_id: 'some-broker', counterparty_role: 'broker' });
    expect(res.status).toBe(200);
    expect(res.body.assessment.counterparty_role).toBe('broker');
  });

  describe('validation', () => {
    it('400 without counterparty_agent_id', async () => {
      const res = await postGate({});
      expect(res.status).toBe(400);
    });

    it('400 on an invalid agent id', async () => {
      const res = await postGate({ counterparty_agent_id: 'not a valid id!!' });
      expect(res.status).toBe(400);
    });

    it('400 on an unknown counterparty_role', async () => {
      const res = await postGate({ counterparty_agent_id: 'x-agent', counterparty_role: 'escrow' });
      expect(res.status).toBe(400);
    });

    it('400 on an out-of-range policy threshold', async () => {
      const res = await postGate({
        counterparty_agent_id: 'x-agent',
        trust_policy: { min_declared_trust: 4 },
      });
      expect(res.status).toBe(400);
    });

    it('400 on a non-object policy', async () => {
      const res = await postGate({ counterparty_agent_id: 'x-agent', trust_policy: 'strict' });
      expect(res.status).toBe(400);
    });

    it('400 on a fractional min_resolved_outcomes', async () => {
      const res = await postGate({
        counterparty_agent_id: 'x-agent',
        trust_policy: { min_resolved_outcomes: 2.5 },
      });
      expect(res.status).toBe(400);
    });

    // GET /trust/pre-escrow/policy advertises every DEFAULT_POLICY key as
    // overridable. This holds the validator to that advertisement — a key the
    // policy endpoint promises but parseTrustPolicy silently drops is a
    // divergence between what the API claims and what it accepts.
    it('accepts every policy field the policy endpoint advertises as overridable', async () => {
      const policyRes = await request(app).get('/trust/pre-escrow/policy');
      expect(policyRes.status).toBe(200);
      const advertised: string[] = policyRes.body.overridable_per_request;
      expect(advertised.length).toBeGreaterThan(0);

      // A value that is valid for each field's own type.
      const probes: Record<string, unknown> = {
        min_success_lower_bound: 0.9,
        max_dispute_rate: 0.1,
        min_resolved_outcomes: 7,
        min_declared_trust: 0.8,
        require_evidence: true,
        deny_on_collusion_patterns: 1,
        collusion_rate_threshold: 0.25,
      };

      for (const field of advertised) {
        expect(probes, `no probe value defined for advertised field '${field}'`)
          .toHaveProperty(field);

        const res = await postGate({
          counterparty_agent_id: 'policy-echo-agent',
          trust_policy: { [field]: probes[field] },
        });

        expect(res.status, `${field} was rejected by the validator`).toBe(200);
        // The echoed policy must show the value took effect, not the default.
        expect(res.body.assessment.policy[field], `${field} was silently dropped`)
          .toEqual(probes[field]);
      }
    });

    it('400 on an override with no stated reason', async () => {
      const res = await postGate({
        counterparty_agent_id: 'x-agent',
        trust_override: { counterparty_agent_id: 'x-agent', reason: 'ok' },
      });
      expect(res.status).toBe(400);
    });

    it('400 on an override that names no counterparty', async () => {
      const res = await postGate({
        counterparty_agent_id: 'x-agent',
        trust_override: { reason: 'a sufficiently long reason' },
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('GET /trust/pre-escrow/policy', () => {
  it('publishes the policy and which fields are overridable', async () => {
    const res = await request(app).get('/trust/pre-escrow/policy');

    expect(res.status).toBe(200);
    expect(res.body.enforcing).toBe(true);
    expect(res.body.default_policy.min_resolved_outcomes).toBe(3);
    expect(res.body.overridable_per_request).toContain('require_evidence');
    expect(res.body.overridable_per_request).toContain('collusion_rate_threshold');
  });
});

describe('GET /trust/pre-escrow/stats', () => {
  it('reports the decision distribution and flags a never-blocking gate', async () => {
    await postGate({ counterparty_agent_id: 'stats-probe-agent' });

    const res = await request(app)
      .get('/trust/pre-escrow/stats')
      .set('Authorization', authFor('GET', '/trust/pre-escrow/stats'));

    expect(res.status).toBe(200);
    expect(res.body.stats.total).toBeGreaterThan(0);
    expect(res.body.enforcing).toBe(true);
    expect(typeof res.body.interpretation).toBe('string');
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it('requires auth', async () => {
    const res = await request(app).get('/trust/pre-escrow/stats');
    expect(res.status).toBe(401);
  });
});

describe('POST /outcomes — gate enforcement', () => {
  it('carries the gate assessment on a clean introduction', async () => {
    const body = {
      introduction_id: uniqueId('intro-clean'),
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-clean'),
      target_id: uniqueId('target-clean'),
    };
    const res = await createIntroduction(body);

    expect(res.status).toBe(201);
    expect(res.body.gate.decision).toBe('allow');
    expect(res.body.gate.allowed).toBe(true);
    // Both counterparties judged: the broker takes a commission too.
    expect(res.body.gate.assessments).toHaveLength(2);
    expect(res.body.gate.assessments.map((a: any) => a.counterparty_role).sort())
      .toEqual(['broker', 'target']);
  });

  it('refuses the handoff when the target has a disputed record', async () => {
    const badTarget = uniqueId('target-bad');
    const broker = uniqueId('broker-for-bad');
    await accrueDisputedHistory(badTarget, broker, 3);

    const res = await createIntroduction({
      introduction_id: uniqueId('intro-blocked'),
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-fresh'),
      target_id: badTarget,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TRUST_GATE_BLOCKED');
    expect(res.body.gate.decision).toBe('deny');

    const targetAssessment = res.body.gate.assessments.find((a: any) => a.counterparty_role === 'target');
    expect(targetAssessment.evidence_basis).toBe('behavioral');
    expect(targetAssessment.behavioral.disputed).toBe(3);
    expect(targetAssessment.reasons.map((r: any) => r.code)).toContain('dispute_rate_above_ceiling');
  });

  it('does not create the outcome record when the gate refuses', async () => {
    const badTarget = uniqueId('target-bad2');
    await accrueDisputedHistory(badTarget, uniqueId('broker-for-bad2'), 3);

    const blockedIntroId = uniqueId('intro-never-created');
    const blocked = await createIntroduction({
      introduction_id: blockedIntroId,
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-fresh2'),
      target_id: badTarget,
    });
    expect(blocked.status).toBe(403);

    // No economic record exists for a refused handoff. Note this route reports
    // a missing outcome as 400, not 404 — pre-existing behaviour, asserted as-is.
    const lookup = await request(app)
      .get(`/outcomes/${blockedIntroId}`)
      .set('Authorization', authFor('GET', `/outcomes/${blockedIntroId}`));
    expect(lookup.status).toBe(400);
    expect(lookup.body.outcome).toBeUndefined();
  });

  it('refuses when the BROKER is the party with the bad record', async () => {
    const badBroker = uniqueId('broker-bad');
    await accrueDisputedHistory(uniqueId('target-for-badbroker'), badBroker, 3);

    const res = await createIntroduction({
      introduction_id: uniqueId('intro-badbroker'),
      requester_id: AGENT_ID,
      broker_id: badBroker,
      target_id: uniqueId('target-fresh'),
    });

    expect(res.status).toBe(403);
    const brokerAssessment = res.body.gate.assessments.find((a: any) => a.counterparty_role === 'broker');
    expect(brokerAssessment.decision).toBe('deny');
  });

  it('refuses self-brokering', async () => {
    const res = await createIntroduction({
      introduction_id: uniqueId('intro-selfbroker'),
      requester_id: AGENT_ID,
      broker_id: AGENT_ID,
      target_id: uniqueId('target-sb'),
    });

    expect(res.status).toBe(403);
    const brokerAssessment = res.body.gate.assessments.find((a: any) => a.counterparty_role === 'broker');
    expect(brokerAssessment.reasons.map((r: any) => r.code)).toContain('self_dealing');
  });

  it('honours require_evidence supplied per introduction', async () => {
    const res = await createIntroduction({
      introduction_id: uniqueId('intro-strict'),
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-strict'),
      target_id: uniqueId('target-strict'),
      trust_policy: { require_evidence: true },
    });

    expect(res.status).toBe(403);
    expect(res.body.gate.decision).toBe('review');
    expect(res.body.gate.assessments[0].reasons.map((r: any) => r.code))
      .toContain('evidence_required_but_absent');
  });

  it('an override carries the handoff through but leaves the decision dirty', async () => {
    const badTarget = uniqueId('target-override');
    await accrueDisputedHistory(badTarget, uniqueId('broker-for-override'), 3);

    const freshBroker = uniqueId('broker-fresh3');
    const res = await createIntroduction({
      introduction_id: uniqueId('intro-overridden'),
      requester_id: AGENT_ID,
      broker_id: freshBroker,
      target_id: badTarget,
      trust_override: {
        counterparty_agent_id: badTarget,
        reason: 'prior off-network relationship, accepting the risk',
      },
    });

    expect(res.status).toBe(201);
    const targetAssessment = res.body.gate.assessments.find((a: any) => a.counterparty_role === 'target');
    expect(targetAssessment.allowed).toBe(true);
    expect(targetAssessment.overridden).toBe(true);
    // The blocking decision survives the override — the record stays dirty.
    expect(targetAssessment.decision).toBe('deny');
    expect(targetAssessment.override.approved_by).toBe(AGENT_ID);
    expect(targetAssessment.reasons.map((r: any) => r.code)).toContain('override_applied');
    expect(res.body.gate.decision).toBe('deny');
    expect(res.body.outcome).toBeDefined();
  });

  it('an override naming a different agent does not unblock the refused party', async () => {
    const badTarget = uniqueId('target-wrongoverride');
    await accrueDisputedHistory(badTarget, uniqueId('broker-for-wrong'), 3);

    const res = await createIntroduction({
      introduction_id: uniqueId('intro-wrongoverride'),
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-fresh4'),
      target_id: badTarget,
      trust_override: {
        counterparty_agent_id: 'some-unrelated-agent',
        reason: 'this override names the wrong counterparty',
      },
    });

    expect(res.status).toBe(403);
  });

  it('still validates required fields before reaching the gate', async () => {
    const res = await createIntroduction({ introduction_id: uniqueId('intro-incomplete') });
    expect(res.status).toBe(400);
  });
});

describe('decision audit log', () => {
  // The docs claim every assessment is appended to data/pre-escrow-decisions.jsonl.
  // That claim has two halves: the sink writes that file (verified separately against
  // MetricsStore), and the route actually calls the sink. This is the second half.
  it('appends every assessment under the documented log name', async () => {
    const { getMetricsStore } = await import('../../src/services/metrics');
    const spy = vi.spyOn(getMetricsStore(), 'appendLog');

    const body = {
      introduction_id: uniqueId('intro-logged'),
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-logged'),
      target_id: uniqueId('target-logged'),
    };
    const res = await createIntroduction(body);
    expect(res.status).toBe(201);

    const gateRows = spy.mock.calls.filter(c => c[0] === 'pre-escrow-decisions');
    // One row per counterparty judged: target and broker.
    expect(gateRows).toHaveLength(2);

    const row = gateRows[0][1] as Record<string, unknown>;
    expect(row.endpoint).toBe('POST /outcomes');
    expect(row.decision).toBe('allow');
    expect(row.evidence_basis).toBe('none');
    expect(row.enforcing).toBe(true);
    expect(row.reason_codes).toContain('no_history_default_allow');
    expect(row.blocking_reason_codes).toEqual([]);
    expect(row.introduction_id).toBe(body.introduction_id);

    spy.mockRestore();
  });

  it('records a refused handoff with its blocking reason codes', async () => {
    const badTarget = uniqueId('target-logged-bad');
    await accrueDisputedHistory(badTarget, uniqueId('broker-logged-bad'), 3);

    const { getMetricsStore } = await import('../../src/services/metrics');
    const spy = vi.spyOn(getMetricsStore(), 'appendLog');

    const res = await createIntroduction({
      introduction_id: uniqueId('intro-logged-blocked'),
      requester_id: AGENT_ID,
      broker_id: uniqueId('broker-logged-fresh'),
      target_id: badTarget,
    });
    expect(res.status).toBe(403);

    const gateRows = spy.mock.calls
      .filter(c => c[0] === 'pre-escrow-decisions')
      .map(c => c[1] as Record<string, unknown>);
    const targetRow = gateRows.find(r => r.counterparty_agent_id === badTarget);

    expect(targetRow).toBeDefined();
    expect(targetRow!.decision).toBe('deny');
    expect(targetRow!.allowed).toBe(false);
    expect(targetRow!.blocking_reason_codes).toContain('dispute_rate_above_ceiling');
    expect(targetRow!.resolved_outcomes).toBe(3);
    expect(targetRow!.dispute_rate).toBe(1);

    spy.mockRestore();
  });

  it('logs the evaluate-only endpoint too', async () => {
    const { getMetricsStore } = await import('../../src/services/metrics');
    const spy = vi.spyOn(getMetricsStore(), 'appendLog');

    await postGate({ counterparty_agent_id: 'logged-probe-agent' });

    const gateRows = spy.mock.calls.filter(c => c[0] === 'pre-escrow-decisions');
    expect(gateRows).toHaveLength(1);
    expect((gateRows[0][1] as Record<string, unknown>).endpoint).toBe('POST /trust/pre-escrow');

    spy.mockRestore();
  });
});

describe('GET /status — gate visibility', () => {
  it('reports whether the gate is enforcing', async () => {
    const res = await request(app).get('/status');

    // Localhost-only; supertest connects over loopback.
    expect(res.status).toBe(200);
    expect(res.body.pre_escrow_gate).toBeDefined();
    expect(res.body.pre_escrow_gate.enforcing).toBe(true);
    expect(typeof res.body.pre_escrow_gate.block_rate).toBe('number');
  });
});
