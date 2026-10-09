/**
 * Pre-Escrow Trust Verification Gate — PROP-881
 *
 * The bottleneck agents keep naming across thecolony/moltchan is not payments,
 * it is trust verification BEFORE the economic handoff. This gate is the
 * decision point that runs first.
 *
 * Two design commitments, both load-bearing:
 *
 * 1. BEHAVIOUR OVER DECLARATION. The convergent finding across five harvest
 *    cycles is "trust from behaviour, not declaration". So the primary signal
 *    is the counterparty's own outcome record — resolved introductions,
 *    disputes, and coordination anomalies — and the declared/attested
 *    trust_score is only a fallback when no behavioural record exists.
 *
 * 2. "COULD NOT MEASURE" IS NOT "BLOCKED". A thin record returns an explicit
 *    insufficient-evidence basis with its own reason code. It never silently
 *    becomes a denial, and a denial never silently becomes a clean pass.
 *
 * Small records are handled with a Wilson 95% lower bound rather than a raw
 * success ratio: one self-dealt introduction scores 1.0 on a naive ratio, and
 * that is precisely the gaming this gate is supposed to catch.
 */

export type GateDecision = 'allow' | 'review' | 'deny';

/** What the decision actually rests on. Never inferred from the decision. */
export type EvidenceBasis = 'behavioral' | 'declared_only' | 'none';

export type GateReasonCode =
  // blocking
  | 'self_dealing'
  | 'multiple_collusion_patterns'
  | 'collusion_pattern_detected'
  | 'success_rate_below_floor'
  | 'dispute_rate_above_ceiling'
  | 'declared_trust_below_floor'
  | 'declared_trust_unavailable'
  | 'evidence_required_but_absent'
  // non-blocking
  | 'behavioral_record_clean'
  | 'declared_trust_only'
  | 'no_history_default_allow'
  | 'advisory_pattern'
  | 'override_applied';

export interface GateReason {
  code: GateReasonCode;
  detail: string;
  blocking: boolean;
}

/**
 * STRUCTURAL anomalies: a single occurrence is evidence on its own, because the
 * shape itself is the problem. A reciprocal introduction ring does not happen
 * by accident. Sourced from OutcomeService's AnomalyFlag union.
 */
export const STRUCTURAL_COLLUSION_FLAGS = [
  'ring_pattern',
  'requester_broker_same_ip',
] as const;

/**
 * RATE-BASED anomalies: these describe timing or volume, and one occurrence
 * proves nothing. Instantaneous bilateral confirmation is what a well-built A2A
 * integration looks like — two agents auto-reporting within seconds is normal
 * machine behaviour, not collusion. It only becomes a signal when it is the
 * agent's consistent pattern, so these are judged as a share of the record.
 */
export const RATE_COLLUSION_FLAGS = [
  'instant_sync',
  'velocity_spike',
] as const;

/**
 * Anomalies that are worth seeing but have ordinary explanations. Surfaced on
 * the assessment so a party can tighten policy, never blocking on their own.
 */
export const ADVISORY_FLAGS = [
  'fast_bilateral_sync',
  'high_success_rate',
] as const;

export interface BehavioralRecord {
  total: number;
  resolved: number;
  successful: number;
  failed: number;
  disputed: number;
  pending: number;
  /** Raw ratio. Display only — policy never reads this. */
  success_rate_observed: number;
  /** Wilson 95% lower bound on the success ratio. This is what policy reads. */
  success_lower_bound: number;
  dispute_rate: number;
  /** Outcomes inspected for anomaly flags. Denominator for the rate flags. */
  outcomes_inspected: number;
  /** Raw occurrence count per anomaly flag across the record. */
  flag_counts: Record<string, number>;
  /** Flags that reached blocking strength: structural, or rate-based and prevalent. */
  strong_flags: string[];
  /** Flags observed but not blocking — including rate flags below prevalence. */
  advisory_flags: string[];
}

export interface PreEscrowPolicy {
  /** Minimum Wilson lower bound on the success ratio. */
  min_success_lower_bound: number;
  /** Maximum share of resolved outcomes that ended disputed. */
  max_dispute_rate: number;
  /** Resolved outcomes needed before a behavioural verdict is possible. */
  min_resolved_outcomes: number;
  /** The PROP's "optional attestation-score threshold". null = not applied. */
  min_declared_trust: number | null;
  /** When true, an unmeasurable counterparty is held for review, not allowed. */
  require_evidence: boolean;
  /** Distinct strong collusion flags that escalate review to deny. */
  deny_on_collusion_patterns: number;
  /**
   * Share of a counterparty's outcomes a rate-based flag must appear on before
   * it counts as blocking. Below this it stays advisory.
   */
  collusion_rate_threshold: number;
}

export const DEFAULT_POLICY: PreEscrowPolicy = {
  min_success_lower_bound: 0.35,
  max_dispute_rate: 0.34,
  min_resolved_outcomes: 3,
  min_declared_trust: null,
  require_evidence: false,
  deny_on_collusion_patterns: 2,
  collusion_rate_threshold: 0.5,
};

export interface GateOverride {
  reason: string;
  approved_by: string;
}

export interface PreEscrowRequest {
  requester_agent_id: string;
  counterparty_agent_id: string;
  /** Which side of the handoff the counterparty is on. Recorded, not scored. */
  counterparty_role?: 'target' | 'broker' | 'requester';
  introduction_id?: string | null;
  /** Declared/attested trust score, if the caller already resolved it. */
  declared_trust_score?: number | null;
  policy?: Partial<PreEscrowPolicy>;
  override?: GateOverride;
}

export interface PreEscrowAssessment {
  decision: GateDecision;
  /** Whether the handoff may proceed. True for 'allow', or for an override. */
  allowed: boolean;
  /**
   * True when an override carried a blocking decision through. `decision`
   * deliberately keeps its blocking value so the record stays dirty.
   */
  overridden: boolean;
  override: GateOverride | null;
  evidence_basis: EvidenceBasis;
  /** Always non-empty. Every decision states what produced it. */
  reasons: GateReason[];
  behavioral: BehavioralRecord | null;
  declared_trust_score: number | null;
  policy: PreEscrowPolicy;
  requester_agent_id: string;
  counterparty_agent_id: string;
  counterparty_role: 'target' | 'broker' | 'requester';
  introduction_id: string | null;
  evaluated_at: string;
}

/**
 * The slice of OutcomeService this gate needs. Declared structurally so the
 * gate can be unit-tested against a fixture without a graph or a server.
 */
export interface OutcomeHistorySource {
  getAgentStats(agentId: string): {
    total: number;
    successful: number;
    failed: number;
    disputed: number;
    pending: number;
    success_rate: number;
    anomaly_count: number;
  };
  getOutcomesForAgent(agentId: string): Array<{ anomaly_flags: string[] }>;
}

export interface DecisionStats {
  total: number;
  allow: number;
  review: number;
  deny: number;
  overridden: number;
  /** Share of evaluations that produced a blocking decision. */
  block_rate: number;
  by_reason: Record<string, number>;
  by_evidence_basis: Record<EvidenceBasis, number>;
}

const WILSON_Z = 1.96; // 95%

/**
 * Wilson score lower bound. Keeps a 1/1 record from reading as certainty.
 */
export function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = WILSON_Z * WILSON_Z;
  const denominator = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin =
    WILSON_Z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const lb = (center - margin) / denominator;
  return Math.max(0, Math.min(1, parseFloat(lb.toFixed(4))));
}

export class PreEscrowGate {
  private history: OutcomeHistorySource;
  private basePolicy: PreEscrowPolicy;
  private decisions: PreEscrowAssessment[] = [];
  private maxDecisions: number;

  constructor(
    history: OutcomeHistorySource,
    basePolicy: Partial<PreEscrowPolicy> = {},
    maxDecisions = 1000,
  ) {
    this.history = history;
    this.basePolicy = { ...DEFAULT_POLICY, ...basePolicy };
    this.maxDecisions = maxDecisions;
  }

  getPolicy(): PreEscrowPolicy {
    return { ...this.basePolicy };
  }

  /**
   * Evaluate one counterparty. Pure with respect to the network — the only
   * side effect is appending to this gate's own decision ring.
   */
  evaluate(request: PreEscrowRequest): PreEscrowAssessment {
    const policy: PreEscrowPolicy = { ...this.basePolicy, ...(request.policy ?? {}) };
    const declared = request.declared_trust_score ?? null;
    const role = request.counterparty_role ?? 'target';
    const reasons: GateReason[] = [];

    const behavioral = this.buildBehavioralRecord(request.counterparty_agent_id, policy);
    const hasBehavioralVerdict = behavioral.resolved >= policy.min_resolved_outcomes;

    const evidence_basis: EvidenceBasis = hasBehavioralVerdict
      ? 'behavioral'
      : declared !== null
        ? 'declared_only'
        : 'none';

    let decision: GateDecision = 'allow';
    const worsen = (next: GateDecision) => {
      const rank: Record<GateDecision, number> = { allow: 0, review: 1, deny: 2 };
      if (rank[next] > rank[decision]) decision = next;
    };

    // --- Always-on checks, independent of how much evidence exists ---

    if (request.counterparty_agent_id === request.requester_agent_id) {
      reasons.push({
        code: 'self_dealing',
        detail: 'Requester and counterparty are the same agent',
        blocking: true,
      });
      worsen('deny');
    }

    const strongCount = behavioral.strong_flags.length;
    if (strongCount >= policy.deny_on_collusion_patterns) {
      reasons.push({
        code: 'multiple_collusion_patterns',
        detail: `${strongCount} distinct coordination patterns on record: ${behavioral.strong_flags.join(', ')}`,
        blocking: true,
      });
      worsen('deny');
    } else if (strongCount >= 1) {
      reasons.push({
        code: 'collusion_pattern_detected',
        detail: `Coordination pattern on record: ${behavioral.strong_flags.join(', ')}`,
        blocking: true,
      });
      worsen('review');
    }

    if (behavioral.advisory_flags.length > 0) {
      reasons.push({
        code: 'advisory_pattern',
        detail: `Observed but not blocking across ${behavioral.outcomes_inspected} outcome(s): ${behavioral.advisory_flags
          .map(f => `${f} x${behavioral.flag_counts[f] ?? 0}`)
          .join(', ')}`,
        blocking: false,
      });
    }

    // --- Evidence-dependent checks ---

    if (hasBehavioralVerdict) {
      if (behavioral.success_lower_bound < policy.min_success_lower_bound) {
        reasons.push({
          code: 'success_rate_below_floor',
          detail: `Success lower bound ${behavioral.success_lower_bound} is below the ${policy.min_success_lower_bound} floor over ${behavioral.resolved} resolved introduction(s)`,
          blocking: true,
        });
        worsen('deny');
      }

      if (behavioral.dispute_rate > policy.max_dispute_rate) {
        reasons.push({
          code: 'dispute_rate_above_ceiling',
          detail: `Dispute rate ${behavioral.dispute_rate} exceeds the ${policy.max_dispute_rate} ceiling (${behavioral.disputed}/${behavioral.resolved})`,
          blocking: true,
        });
        worsen('deny');
      }

      if (!reasons.some(r => r.blocking)) {
        reasons.push({
          code: 'behavioral_record_clean',
          detail: `${behavioral.resolved} resolved introduction(s), success lower bound ${behavioral.success_lower_bound}, dispute rate ${behavioral.dispute_rate}`,
          blocking: false,
        });
      }
    } else {
      // Not enough behaviour to judge. Say so in its own words.
      if (policy.require_evidence) {
        reasons.push({
          code: 'evidence_required_but_absent',
          detail: `Policy requires behavioural evidence; counterparty has ${behavioral.resolved} resolved introduction(s), ${policy.min_resolved_outcomes} needed`,
          blocking: true,
        });
        worsen('review');
      }

      if (policy.min_declared_trust !== null) {
        if (declared === null) {
          reasons.push({
            code: 'declared_trust_unavailable',
            detail: `Policy sets a declared-trust floor of ${policy.min_declared_trust} but no declared score is available — this is "could not measure", not "below the floor"`,
            blocking: true,
          });
          worsen('review');
        } else if (declared < policy.min_declared_trust) {
          reasons.push({
            code: 'declared_trust_below_floor',
            detail: `Declared trust ${declared} is below the ${policy.min_declared_trust} floor`,
            blocking: true,
          });
          worsen('deny');
        }
      }

      if (!reasons.some(r => r.blocking)) {
        if (evidence_basis === 'declared_only') {
          reasons.push({
            code: 'declared_trust_only',
            detail: `No behavioural record (${behavioral.resolved} resolved). Allowed on declared trust ${declared} alone — this is not a verified pass`,
            blocking: false,
          });
        } else {
          reasons.push({
            code: 'no_history_default_allow',
            detail: 'Nothing is known about this counterparty, for or against. Allowed by default policy; set require_evidence to hold instead',
            blocking: false,
          });
        }
      }
    }

    // --- Override: carries the handoff through, leaves the record dirty ---

    const override = request.override ?? null;
    const blocked = decision !== 'allow';
    const overridden = blocked && override !== null;

    if (overridden && override) {
      reasons.push({
        code: 'override_applied',
        detail: `${override.approved_by} overrode a '${decision}' decision: ${override.reason}`,
        blocking: false,
      });
    }

    const assessment: PreEscrowAssessment = {
      decision, // deliberately unchanged by the override
      allowed: !blocked || overridden,
      overridden,
      override: overridden ? override : null,
      evidence_basis,
      reasons,
      behavioral: behavioral.total > 0 ? behavioral : null,
      declared_trust_score: declared,
      policy,
      requester_agent_id: request.requester_agent_id,
      counterparty_agent_id: request.counterparty_agent_id,
      counterparty_role: role,
      introduction_id: request.introduction_id ?? null,
      evaluated_at: new Date().toISOString(),
    };

    this.record(assessment);
    return assessment;
  }

  /**
   * Evaluate several counterparties for one handoff and return the worst
   * decision alongside every individual assessment.
   */
  evaluateHandoff(requests: PreEscrowRequest[]): {
    decision: GateDecision;
    allowed: boolean;
    assessments: PreEscrowAssessment[];
  } {
    const assessments = requests.map(r => this.evaluate(r));
    const rank: Record<GateDecision, number> = { allow: 0, review: 1, deny: 2 };
    let decision: GateDecision = 'allow';
    for (const a of assessments) {
      if (rank[a.decision] > rank[decision]) decision = a.decision;
    }
    return {
      decision,
      allowed: assessments.every(a => a.allowed),
      assessments,
    };
  }

  getRecentDecisions(limit = 50): PreEscrowAssessment[] {
    return this.decisions.slice(-limit);
  }

  /**
   * Decision distribution. A gate that has never produced a blocking decision
   * is reporting a broken input, not a clean network — this is how that
   * becomes visible without reading the log by hand.
   */
  getDecisionStats(): DecisionStats {
    const by_reason: Record<string, number> = {};
    const by_evidence_basis: Record<EvidenceBasis, number> = {
      behavioral: 0,
      declared_only: 0,
      none: 0,
    };
    let allow = 0;
    let review = 0;
    let deny = 0;
    let overridden = 0;

    for (const d of this.decisions) {
      if (d.decision === 'allow') allow++;
      else if (d.decision === 'review') review++;
      else deny++;
      if (d.overridden) overridden++;
      by_evidence_basis[d.evidence_basis]++;
      for (const r of d.reasons) {
        by_reason[r.code] = (by_reason[r.code] || 0) + 1;
      }
    }

    const total = this.decisions.length;
    return {
      total,
      allow,
      review,
      deny,
      overridden,
      block_rate: total > 0 ? parseFloat(((review + deny) / total).toFixed(4)) : 0,
      by_reason,
      by_evidence_basis,
    };
  }

  // --- Internal ---

  private buildBehavioralRecord(agentId: string, policy: PreEscrowPolicy): BehavioralRecord {
    const stats = this.history.getAgentStats(agentId);
    const resolved = stats.successful + stats.failed + stats.disputed;

    const outcomes = this.history.getOutcomesForAgent(agentId);
    const flagCounts: Record<string, number> = {};
    for (const outcome of outcomes) {
      // De-duplicate within one outcome: a flag raised twice on the same
      // introduction is one occurrence, not two.
      for (const flag of new Set(outcome.anomaly_flags ?? [])) {
        flagCounts[flag] = (flagCounts[flag] || 0) + 1;
      }
    }

    const strong = new Set<string>();
    const advisory = new Set<string>();
    const inspected = outcomes.length;

    for (const [flag, count] of Object.entries(flagCounts)) {
      if ((STRUCTURAL_COLLUSION_FLAGS as readonly string[]).includes(flag)) {
        // The shape itself is the evidence. One is enough.
        strong.add(flag);
        continue;
      }
      if ((RATE_COLLUSION_FLAGS as readonly string[]).includes(flag)) {
        const prevalence = inspected > 0 ? count / inspected : 0;
        const hasEnoughRecord = resolved >= policy.min_resolved_outcomes;
        if (hasEnoughRecord && prevalence >= policy.collusion_rate_threshold) {
          strong.add(flag);
        } else {
          advisory.add(flag);
        }
        continue;
      }
      if ((ADVISORY_FLAGS as readonly string[]).includes(flag)) {
        advisory.add(flag);
      }
    }

    return {
      total: stats.total,
      resolved,
      successful: stats.successful,
      failed: stats.failed,
      disputed: stats.disputed,
      pending: stats.pending,
      success_rate_observed:
        resolved > 0 ? parseFloat((stats.successful / resolved).toFixed(4)) : 0,
      success_lower_bound: wilsonLowerBound(stats.successful, resolved),
      dispute_rate: resolved > 0 ? parseFloat((stats.disputed / resolved).toFixed(4)) : 0,
      outcomes_inspected: inspected,
      flag_counts: flagCounts,
      strong_flags: [...strong].sort(),
      advisory_flags: [...advisory].sort(),
    };
  }

  private record(assessment: PreEscrowAssessment): void {
    this.decisions.push(assessment);
    if (this.decisions.length > this.maxDecisions) {
      this.decisions.splice(0, this.decisions.length - this.maxDecisions);
    }
  }
}
