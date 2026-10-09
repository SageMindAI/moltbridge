/**
 * Unit Tests: Pre-Escrow Trust Verification Gate (PROP-881)
 *
 * Every blocking path has a test that proves it fires, and every allow path
 * has a test that proves what the allow rests on. A gate with no demonstrated
 * denial is a broken input, not a clean network.
 */

import { describe, it, expect } from 'vitest';
import {
  PreEscrowGate,
  DEFAULT_POLICY,
  wilsonLowerBound,
  type OutcomeHistorySource,
} from '../../src/services/pre-escrow';

interface AgentFixture {
  successful?: number;
  failed?: number;
  disputed?: number;
  pending?: number;
  flags?: string[][];
}

/** Deterministic stand-in for OutcomeService. */
function fixtureHistory(agents: Record<string, AgentFixture>): OutcomeHistorySource {
  return {
    getAgentStats(agentId: string) {
      const a = agents[agentId] ?? {};
      const successful = a.successful ?? 0;
      const failed = a.failed ?? 0;
      const disputed = a.disputed ?? 0;
      const pending = a.pending ?? 0;
      const resolved = successful + failed + disputed;
      const total = resolved + pending;
      return {
        total,
        successful,
        failed,
        disputed,
        pending,
        success_rate: total > 0 ? successful / total : 0,
        anomaly_count: (a.flags ?? []).reduce((n, f) => n + f.length, 0),
      };
    },
    getOutcomesForAgent(agentId: string) {
      const a = agents[agentId] ?? {};
      return (a.flags ?? []).map(anomaly_flags => ({ anomaly_flags }));
    },
  };
}

const REQUESTER = 'requester-001';

describe('wilsonLowerBound', () => {
  it('returns 0 for an empty record', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('keeps a perfect 1-of-1 record well below certainty', () => {
    const lb = wilsonLowerBound(1, 1);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(0.3);
  });

  it('keeps a perfect 3-of-3 record below the naive 1.0', () => {
    expect(wilsonLowerBound(3, 3)).toBeCloseTo(0.4385, 3);
  });

  it('rises as the sample grows at the same ratio', () => {
    expect(wilsonLowerBound(40, 50)).toBeGreaterThan(wilsonLowerBound(8, 10));
  });

  it('clamps into [0, 1]', () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(1000, 1000)).toBeLessThanOrEqual(1);
  });
});

describe('PreEscrowGate — blocking paths', () => {
  it('denies self-dealing', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: REQUESTER,
    });

    expect(a.decision).toBe('deny');
    expect(a.allowed).toBe(false);
    expect(a.reasons.map(r => r.code)).toContain('self_dealing');
  });

  it('denies a counterparty whose success lower bound is under the floor', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ 'bad-agent': { successful: 1, failed: 5 } }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'bad-agent',
    });

    expect(a.decision).toBe('deny');
    expect(a.evidence_basis).toBe('behavioral');
    expect(a.reasons.map(r => r.code)).toContain('success_rate_below_floor');
    expect(a.behavioral!.success_lower_bound).toBeLessThan(DEFAULT_POLICY.min_success_lower_bound);
  });

  it('denies a counterparty whose dispute rate is over the ceiling', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ 'disputed-agent': { successful: 6, disputed: 4 } }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'disputed-agent',
    });

    expect(a.decision).toBe('deny');
    expect(a.reasons.map(r => r.code)).toContain('dispute_rate_above_ceiling');
    expect(a.behavioral!.dispute_rate).toBe(0.4);
  });

  it('holds for review on a single strong coordination pattern', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'ringy-agent': { successful: 10, flags: [['ring_pattern']] },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'ringy-agent',
    });

    expect(a.decision).toBe('review');
    expect(a.allowed).toBe(false);
    expect(a.reasons.map(r => r.code)).toContain('collusion_pattern_detected');
  });

  it('denies on two distinct strong coordination patterns', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'colluder': {
          successful: 20,
          flags: [['ring_pattern'], ['instant_sync', 'ring_pattern']],
        },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'colluder',
    });

    expect(a.decision).toBe('deny');
    expect(a.reasons.map(r => r.code)).toContain('multiple_collusion_patterns');
    expect(a.behavioral!.strong_flags).toEqual(['instant_sync', 'ring_pattern']);
  });

  it('a spotless success record does not outvote a coordination pattern', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'too-good': { successful: 50, flags: [['instant_sync']] },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'too-good',
    });

    expect(a.decision).toBe('review');
    expect(a.behavioral!.success_lower_bound).toBeGreaterThan(0.9);
  });

  it('denies a declared trust score under an explicit floor', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'thin-agent',
      declared_trust_score: 0.1,
      policy: { min_declared_trust: 0.5 },
    });

    expect(a.decision).toBe('deny');
    expect(a.reasons.map(r => r.code)).toContain('declared_trust_below_floor');
  });

  it('holds for review — not deny — when a declared floor is set but nothing can be measured', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'unknown-agent',
      declared_trust_score: null,
      policy: { min_declared_trust: 0.5 },
    });

    expect(a.decision).toBe('review');
    const codes = a.reasons.map(r => r.code);
    expect(codes).toContain('declared_trust_unavailable');
    expect(codes).not.toContain('declared_trust_below_floor');
  });

  it('holds an unmeasurable counterparty when the party demands evidence', () => {
    const gate = new PreEscrowGate(fixtureHistory({ 'new-agent': { successful: 1 } }));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'new-agent',
      policy: { require_evidence: true },
    });

    expect(a.decision).toBe('review');
    expect(a.evidence_basis).toBe('none');
    expect(a.reasons.map(r => r.code)).toContain('evidence_required_but_absent');
  });

  it('honours a stricter collusion threshold of one', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ 'flagged': { successful: 10, flags: [['instant_sync']] } }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'flagged',
      policy: { deny_on_collusion_patterns: 1 },
    });

    expect(a.decision).toBe('deny');
    expect(a.reasons.map(r => r.code)).toContain('multiple_collusion_patterns');
  });
});

describe('PreEscrowGate — allow paths state what they rest on', () => {
  it('allows a clean behavioural record on behavioural basis', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ 'good-agent': { successful: 18, failed: 2 } }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'good-agent',
    });

    expect(a.decision).toBe('allow');
    expect(a.allowed).toBe(true);
    expect(a.evidence_basis).toBe('behavioral');
    expect(a.reasons.map(r => r.code)).toContain('behavioral_record_clean');
  });

  it('labels a no-history allow as unknown, not as a verified pass', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'brand-new-agent',
    });

    expect(a.decision).toBe('allow');
    expect(a.evidence_basis).toBe('none');
    expect(a.behavioral).toBeNull();
    expect(a.reasons.map(r => r.code)).toContain('no_history_default_allow');
    expect(a.reasons.map(r => r.code)).not.toContain('behavioral_record_clean');
  });

  it('labels a declared-trust-only allow as declared_only', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'attested-agent',
      declared_trust_score: 0.82,
    });

    expect(a.decision).toBe('allow');
    expect(a.evidence_basis).toBe('declared_only');
    expect(a.reasons.map(r => r.code)).toContain('declared_trust_only');
  });

  it('surfaces advisory patterns without blocking on them', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'fast-agent': { successful: 12, failed: 1, flags: [['fast_bilateral_sync', 'high_success_rate']] },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'fast-agent',
    });

    expect(a.decision).toBe('allow');
    const advisory = a.reasons.find(r => r.code === 'advisory_pattern');
    expect(advisory).toBeDefined();
    expect(advisory!.blocking).toBe(false);
    expect(a.behavioral!.advisory_flags).toEqual(['fast_bilateral_sync', 'high_success_rate']);
  });

  it('every assessment carries at least one reason', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ a: { successful: 5 }, b: { disputed: 5 } }),
    );
    for (const id of ['a', 'b', 'c']) {
      const a = gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: id });
      expect(a.reasons.length).toBeGreaterThan(0);
    }
  });

  it('does not treat a thin record as a behavioural verdict', () => {
    // 1 success out of 1 would be a 100% naive rate — and is still not a verdict.
    const gate = new PreEscrowGate(fixtureHistory({ thin: { successful: 1 } }));
    const a = gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'thin' });

    expect(a.evidence_basis).toBe('none');
    expect(a.behavioral!.success_rate_observed).toBe(1);
    expect(a.reasons.map(r => r.code)).toContain('no_history_default_allow');
  });
});

describe('PreEscrowGate — override leaves the record dirty', () => {
  it('carries the handoff through but keeps the blocking decision', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ 'bad-agent': { successful: 1, failed: 9 } }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'bad-agent',
      override: { reason: 'prior off-network relationship', approved_by: REQUESTER },
    });

    expect(a.allowed).toBe(true);
    expect(a.overridden).toBe(true);
    expect(a.decision).toBe('deny'); // NOT rewritten to 'allow'
    expect(a.override!.approved_by).toBe(REQUESTER);
    expect(a.reasons.map(r => r.code)).toContain('override_applied');
    expect(a.reasons.some(r => r.blocking)).toBe(true);
  });

  it('does not mark a passing assessment as overridden', () => {
    const gate = new PreEscrowGate(fixtureHistory({ good: { successful: 20 } }));
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'good',
      override: { reason: 'unnecessary', approved_by: REQUESTER },
    });

    expect(a.decision).toBe('allow');
    expect(a.overridden).toBe(false);
    expect(a.override).toBeNull();
    expect(a.reasons.map(r => r.code)).not.toContain('override_applied');
  });

  it('counts overrides separately from clean allows in the stats', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ bad: { disputed: 8, successful: 2 }, good: { successful: 20 } }),
    );
    gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'bad',
      override: { reason: 'manual', approved_by: 'ops' },
    });
    gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'good' });

    const stats = gate.getDecisionStats();
    expect(stats.allow).toBe(1);
    expect(stats.deny).toBe(1);
    expect(stats.overridden).toBe(1);
  });
});

describe('PreEscrowGate — handoff evaluation', () => {
  it('takes the worst decision across the parties', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        target: { successful: 20 },
        broker: { successful: 1, failed: 9 },
      }),
    );
    const result = gate.evaluateHandoff([
      { requester_agent_id: REQUESTER, counterparty_agent_id: 'target', counterparty_role: 'target' },
      { requester_agent_id: REQUESTER, counterparty_agent_id: 'broker', counterparty_role: 'broker' },
    ]);

    expect(result.decision).toBe('deny');
    expect(result.allowed).toBe(false);
    expect(result.assessments).toHaveLength(2);
    expect(result.assessments.find(a => a.counterparty_role === 'broker')!.decision).toBe('deny');
    expect(result.assessments.find(a => a.counterparty_role === 'target')!.decision).toBe('allow');
  });

  it('allows a handoff only when every party is allowed', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ target: { successful: 20 }, broker: { successful: 15, failed: 1 } }),
    );
    const result = gate.evaluateHandoff([
      { requester_agent_id: REQUESTER, counterparty_agent_id: 'target', counterparty_role: 'target' },
      { requester_agent_id: REQUESTER, counterparty_agent_id: 'broker', counterparty_role: 'broker' },
    ]);

    expect(result.decision).toBe('allow');
    expect(result.allowed).toBe(true);
  });

  it('an override on the blocked party carries the handoff', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ target: { successful: 20 }, broker: { successful: 1, failed: 9 } }),
    );
    const result = gate.evaluateHandoff([
      { requester_agent_id: REQUESTER, counterparty_agent_id: 'target', counterparty_role: 'target' },
      {
        requester_agent_id: REQUESTER,
        counterparty_agent_id: 'broker',
        counterparty_role: 'broker',
        override: { reason: 'known broker', approved_by: 'ops' },
      },
    ]);

    expect(result.allowed).toBe(true);
    expect(result.decision).toBe('deny'); // worst decision survives the override
  });
});

describe('PreEscrowGate — decision log and observability', () => {
  it('records every evaluation with its reasons and basis', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ bad: { successful: 1, failed: 9 }, good: { successful: 20 } }),
    );
    gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'bad' });
    gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'good' });
    gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'unknown' });

    const stats = gate.getDecisionStats();
    expect(stats.total).toBe(3);
    expect(stats.deny).toBe(1);
    expect(stats.allow).toBe(2);
    expect(stats.block_rate).toBeCloseTo(0.3333, 3);
    expect(stats.by_reason['success_rate_below_floor']).toBe(1);
    expect(stats.by_evidence_basis.behavioral).toBe(2);
    expect(stats.by_evidence_basis.none).toBe(1);
  });

  it('reports a zero block rate on an empty log without claiming health', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    const stats = gate.getDecisionStats();
    expect(stats.total).toBe(0);
    expect(stats.block_rate).toBe(0);
  });

  it('bounds the decision ring', () => {
    const gate = new PreEscrowGate(fixtureHistory({}), {}, 5);
    for (let i = 0; i < 20; i++) {
      gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: `agent-${i}` });
    }
    expect(gate.getRecentDecisions(100)).toHaveLength(5);
    expect(gate.getDecisionStats().total).toBe(5);
  });

  it('exposes the base policy it was constructed with', () => {
    const gate = new PreEscrowGate(fixtureHistory({}), { require_evidence: true });
    expect(gate.getPolicy().require_evidence).toBe(true);
    expect(gate.getPolicy().min_success_lower_bound).toBe(DEFAULT_POLICY.min_success_lower_bound);
  });

  it('a per-request policy does not leak into the base policy', () => {
    const gate = new PreEscrowGate(fixtureHistory({}));
    gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'x',
      policy: { require_evidence: true, min_declared_trust: 0.9 },
    });
    expect(gate.getPolicy().require_evidence).toBe(false);
    expect(gate.getPolicy().min_declared_trust).toBeNull();
  });
});

describe('PreEscrowGate — structural flags act on one occurrence, rate flags need prevalence', () => {
  it('does NOT block on a single instant_sync — automated bilateral reporting is normal', () => {
    // The case that motivated the split: two agents whose A2A integrations both
    // auto-confirm within seconds. Honest machine behaviour, not collusion.
    const gate = new PreEscrowGate(
      fixtureHistory({ 'a2a-agent': { successful: 1, flags: [['instant_sync']] } }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'a2a-agent',
    });

    expect(a.decision).toBe('allow');
    expect(a.behavioral!.strong_flags).toEqual([]);
    expect(a.behavioral!.advisory_flags).toEqual(['instant_sync']);
  });

  it('leaves a rate flag advisory when it is a small share of the record', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'mostly-normal': {
          successful: 10,
          flags: [['instant_sync'], [], [], [], [], [], [], [], [], []],
        },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'mostly-normal',
    });

    expect(a.decision).toBe('allow');
    expect(a.behavioral!.advisory_flags).toEqual(['instant_sync']);
    expect(a.behavioral!.flag_counts['instant_sync']).toBe(1);
    expect(a.behavioral!.outcomes_inspected).toBe(10);
  });

  it('escalates a rate flag to blocking once it is the agent’s consistent pattern', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'always-instant': {
          successful: 10,
          flags: [
            ['instant_sync'], ['instant_sync'], ['instant_sync'], ['instant_sync'],
            ['instant_sync'], ['instant_sync'], ['instant_sync'], ['instant_sync'],
            [], [],
          ],
        },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'always-instant',
    });

    expect(a.decision).toBe('review');
    expect(a.behavioral!.strong_flags).toEqual(['instant_sync']);
    expect(a.reasons.map(r => r.code)).toContain('collusion_pattern_detected');
  });

  it('blocks on a single ring_pattern regardless of prevalence', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        'ring-once': {
          successful: 30,
          flags: [['ring_pattern'], [], [], [], [], [], [], [], [], []],
        },
      }),
    );
    const a = gate.evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'ring-once',
    });

    expect(a.decision).toBe('review');
    expect(a.behavioral!.strong_flags).toEqual(['ring_pattern']);
  });

  it('holds a rate flag advisory while the record is still too thin to judge', () => {
    // 2 of 2 outcomes is 100% prevalence, but 2 resolved is below the floor
    // for any behavioural verdict, so prevalence is not yet meaningful.
    const gate = new PreEscrowGate(
      fixtureHistory({ thin: { successful: 2, flags: [['instant_sync'], ['instant_sync']] } }),
    );
    const a = gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'thin' });

    expect(a.decision).toBe('allow');
    expect(a.behavioral!.advisory_flags).toEqual(['instant_sync']);
  });

  it('honours a lowered collusion_rate_threshold', () => {
    const history = fixtureHistory({
      'some-instant': {
        successful: 10,
        flags: [['instant_sync'], ['instant_sync'], [], [], [], [], [], [], [], []],
      },
    });

    const lenient = new PreEscrowGate(history).evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'some-instant',
    });
    expect(lenient.decision).toBe('allow');

    const strict = new PreEscrowGate(history).evaluate({
      requester_agent_id: REQUESTER,
      counterparty_agent_id: 'some-instant',
      policy: { collusion_rate_threshold: 0.2 },
    });
    expect(strict.decision).toBe('review');
    expect(strict.behavioral!.strong_flags).toEqual(['instant_sync']);
  });

  it('counts a flag once per outcome even when listed twice', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({
        dupes: { successful: 5, flags: [['instant_sync', 'instant_sync']] },
      }),
    );
    const a = gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'dupes' });
    expect(a.behavioral!.flag_counts['instant_sync']).toBe(1);
  });

  it('ignores anomaly flags it does not recognise rather than guessing', () => {
    const gate = new PreEscrowGate(
      fixtureHistory({ odd: { successful: 10, flags: [['some_future_flag']] } }),
    );
    const a = gate.evaluate({ requester_agent_id: REQUESTER, counterparty_agent_id: 'odd' });

    expect(a.decision).toBe('allow');
    expect(a.behavioral!.strong_flags).toEqual([]);
    expect(a.behavioral!.advisory_flags).toEqual([]);
    expect(a.behavioral!.flag_counts['some_future_flag']).toBe(1);
  });
});
