/**
 * Outcome Verification Service
 *
 * Multi-layer verification architecture for introduction outcomes.
 * Layer 1: Bilateral reports (both parties report independently)
 * Layer 2: Evidence-based validation (URL/A2A proof)
 * Layer 3: Independent research (spot-check, adaptive)
 * Layer 4: Pattern analysis (graph-level anomaly detection)
 *
 * Phase 1: Layers 1 + 2, with timing analysis and basic anomaly flags.
 */

export type OutcomeStatus = 'successful' | 'failed' | 'no_response' | 'disputed';
export type EvidenceType = 'requester_report' | 'target_report' | 'url_evidence' | 'a2a_proof';

export interface OutcomeReport {
  introduction_id: string;
  reporter_agent_id: string;
  reporter_role: 'requester' | 'target' | 'broker';
  status: OutcomeStatus;
  evidence_type: EvidenceType;
  evidence_url?: string;
  reported_at: string;
}

export interface OutcomeRecord {
  introduction_id: string;
  requester_id: string;
  broker_id: string;
  target_id: string;
  created_at: string;
  reports: OutcomeReport[];
  resolved_status: OutcomeStatus | null;
  resolved_at: string | null;
  timing_analysis: TimingAnalysis | null;
  anomaly_flags: AnomalyFlag[];
  verification_layer: number; // Which layer resolved it
}

export interface TimingAnalysis {
  first_report_at: string;
  second_report_at: string | null;
  delta_seconds: number | null;
  pattern: 'normal' | 'fast_coordination' | 'suspicious_sync' | 'target_first' | 'single_report';
}

export type AnomalyFlag =
  | 'fast_bilateral_sync'     // Both parties reported within 60s
  | 'instant_sync'            // Both reported within 10s — mandatory review
  | 'requester_broker_same_ip'
  | 'high_success_rate'       // Agent has >95% success rate over 20+ intros
  | 'ring_pattern'            // Reciprocal introductions detected
  | 'velocity_spike';         // 5x normal reporting rate

export class OutcomeService {
  // In-memory stores (production: database)
  private outcomes: Map<string, OutcomeRecord> = new Map();

  /**
   * Create an outcome record when an introduction is initiated.
   */
  createOutcome(
    introductionId: string,
    requesterId: string,
    brokerId: string,
    targetId: string,
  ): OutcomeRecord {
    if (this.outcomes.has(introductionId)) {
      throw new Error(`Outcome already exists: ${introductionId}`);
    }

    const record: OutcomeRecord = {
      introduction_id: introductionId,
      requester_id: requesterId,
      broker_id: brokerId,
      target_id: targetId,
      created_at: new Date().toISOString(),
      reports: [],
      resolved_status: null,
      resolved_at: null,
      timing_analysis: null,
      anomaly_flags: [],
      verification_layer: 0,
    };

    this.outcomes.set(introductionId, record);
    return record;
  }

  /**
   * Submit a Layer 1 bilateral report.
   */
  submitReport(report: OutcomeReport): OutcomeRecord {
    const outcome = this.outcomes.get(report.introduction_id);
    if (!outcome) {
      throw new Error(`Outcome not found: ${report.introduction_id}`);
    }

    // Prevent duplicate reports from same role
    const existingFromRole = outcome.reports.find(
      r => r.reporter_role === report.reporter_role
    );
    if (existingFromRole) {
      throw new Error(`${report.reporter_role} already reported for this introduction`);
    }

    // Validate reporter is a party to this introduction
    const validReporters = [outcome.requester_id, outcome.broker_id, outcome.target_id];
    if (!validReporters.includes(report.reporter_agent_id)) {
      throw new Error('Reporter is not a party to this introduction');
    }

    outcome.reports.push(report);

    // Analyze timing after second report
    if (outcome.reports.length >= 2) {
      outcome.timing_analysis = this.analyzeTiming(outcome.reports);
      this.detectAnomalies(outcome);
    } else if (outcome.reports.length === 1) {
      outcome.timing_analysis = {
        first_report_at: report.reported_at,
        second_report_at: null,
        delta_seconds: null,
        pattern: 'single_report',
      };
    }

    // Try to resolve
    this.tryResolve(outcome);

    return outcome;
  }

  /**
   * Analyze timing between reports for coordination detection.
   */
  private analyzeTiming(reports: OutcomeReport[]): TimingAnalysis {
    const sorted = [...reports].sort(
      (a, b) => new Date(a.reported_at).getTime() - new Date(b.reported_at).getTime()
    );

    const first = sorted[0];
    const second = sorted[1];
    const deltaMs = new Date(second.reported_at).getTime() - new Date(first.reported_at).getTime();
    const deltaSeconds = Math.round(deltaMs / 1000);

    let pattern: TimingAnalysis['pattern'];
    if (deltaSeconds <= 10) {
      pattern = 'suspicious_sync';
    } else if (deltaSeconds <= 60) {
      pattern = 'fast_coordination';
    } else if (first.reporter_role === 'target') {
      pattern = 'target_first';
    } else {
      pattern = 'normal';
    }

    return {
      first_report_at: first.reported_at,
      second_report_at: second.reported_at,
      delta_seconds: deltaSeconds,
      pattern,
    };
  }

  /**
   * Detect anomaly patterns on this outcome.
   */
  private detectAnomalies(outcome: OutcomeRecord): void {
    const flags: AnomalyFlag[] = [];

    if (outcome.timing_analysis) {
      if (outcome.timing_analysis.pattern === 'suspicious_sync') {
        flags.push('instant_sync');
      } else if (outcome.timing_analysis.pattern === 'fast_coordination') {
        flags.push('fast_bilateral_sync');
      }
    }

    // Check success rate anomaly for requester
    const requesterOutcomes = this.getOutcomesForAgent(outcome.requester_id);
    if (requesterOutcomes.length >= 20) {
      const successCount = requesterOutcomes.filter(
        o => o.resolved_status === 'successful'
      ).length;
      if (successCount / requesterOutcomes.length > 0.95) {
        flags.push('high_success_rate');
      }
    }

    // Check for ring patterns (A introduces to B, B introduces to A)
    const reverseIntros = this.findReverseIntroductions(
      outcome.requester_id, outcome.target_id
    );
    if (reverseIntros.length > 0) {
      flags.push('ring_pattern');
    }

    outcome.anomaly_flags = flags;
  }

  /**
   * Try to resolve the outcome based on available reports.
   */
  private tryResolve(outcome: OutcomeRecord): void {
    if (outcome.resolved_status) return;

    const reports = outcome.reports;
    if (reports.length < 2) return;

    // Get requester and target/broker reports
    const requesterReport = reports.find(r => r.reporter_role === 'requester');
    const otherReport = reports.find(r => r.reporter_role !== 'requester');

    if (!requesterReport || !otherReport) return;

    // Both agree → resolved at Layer 1
    if (requesterReport.status === otherReport.status) {
      outcome.resolved_status = requesterReport.status;
      outcome.resolved_at = new Date().toISOString();
      outcome.verification_layer = 1;

      // If instant sync flagged, upgrade to Layer 3 (mandatory review)
      if (outcome.anomaly_flags.includes('instant_sync')) {
        outcome.verification_layer = 3;
        // In production, this would queue for researcher investigation
      }
      return;
    }

    // Disagreement → disputed, needs resolution
    outcome.resolved_status = 'disputed';
    outcome.resolved_at = new Date().toISOString();
    outcome.verification_layer = 2;
  }

  /**
   * Get an outcome by introduction ID.
   */
  getOutcome(introductionId: string): OutcomeRecord | null {
    return this.outcomes.get(introductionId) ?? null;
  }

  /**
   * Get all outcomes involving a specific agent (any role).
   */
  getOutcomesForAgent(agentId: string): OutcomeRecord[] {
    const results: OutcomeRecord[] = [];
    for (const outcome of this.outcomes.values()) {
      if (
        outcome.requester_id === agentId ||
        outcome.broker_id === agentId ||
        outcome.target_id === agentId
      ) {
        results.push(outcome);
      }
    }
    return results;
  }

  /**
   * Find reverse introductions (B→A when we have A→B).
   */
  private findReverseIntroductions(agentA: string, agentB: string): OutcomeRecord[] {
    const results: OutcomeRecord[] = [];
    for (const outcome of this.outcomes.values()) {
      if (outcome.requester_id === agentB && outcome.target_id === agentA) {
        results.push(outcome);
      }
    }
    return results;
  }

  /**
   * Get outcomes pending resolution (Layer 2+ needed).
   */
  getPendingResolution(): OutcomeRecord[] {
    const results: OutcomeRecord[] = [];
    for (const outcome of this.outcomes.values()) {
      if (
        outcome.resolved_status === 'disputed' ||
        outcome.anomaly_flags.includes('instant_sync')
      ) {
        results.push(outcome);
      }
    }
    return results;
  }

  /**
   * Get aggregate stats for an agent's outcome history.
   */
  getAgentStats(agentId: string): {
    total: number;
    successful: number;
    failed: number;
    disputed: number;
    pending: number;
    success_rate: number;
    anomaly_count: number;
  } {
    const outcomes = this.getOutcomesForAgent(agentId);
    const total = outcomes.length;
    const successful = outcomes.filter(o => o.resolved_status === 'successful').length;
    const failed = outcomes.filter(o => o.resolved_status === 'failed').length;
    const disputed = outcomes.filter(o => o.resolved_status === 'disputed').length;
    const pending = outcomes.filter(o => o.resolved_status === null).length;
    const anomalyCount = outcomes.reduce((sum, o) => sum + o.anomaly_flags.length, 0);

    return {
      total,
      successful,
      failed,
      disputed,
      pending,
      success_rate: total > 0 ? successful / total : 0,
      anomaly_count: anomalyCount,
    };
  }
}
