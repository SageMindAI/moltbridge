/**
 * Unit Tests: Outcome Verification Service
 *
 * Tests bilateral reporting, timing analysis, anomaly detection,
 * ring detection, and resolution logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OutcomeService, type OutcomeReport } from '../../src/services/outcomes';

describe('OutcomeService', () => {
  let service: OutcomeService;

  beforeEach(() => {
    service = new OutcomeService();
  });

  describe('createOutcome()', () => {
    it('creates an outcome record', () => {
      const outcome = service.createOutcome('intro-1', 'requester-1', 'broker-1', 'target-1');

      expect(outcome.introduction_id).toBe('intro-1');
      expect(outcome.requester_id).toBe('requester-1');
      expect(outcome.broker_id).toBe('broker-1');
      expect(outcome.target_id).toBe('target-1');
      expect(outcome.reports).toHaveLength(0);
      expect(outcome.resolved_status).toBeNull();
      expect(outcome.timing_analysis).toBeNull();
      expect(outcome.anomaly_flags).toHaveLength(0);
      expect(outcome.verification_layer).toBe(0);
    });

    it('throws on duplicate introduction_id', () => {
      service.createOutcome('intro-1', 'r', 'b', 't');
      expect(() => service.createOutcome('intro-1', 'r', 'b', 't')).toThrow('already exists');
    });
  });

  describe('submitReport()', () => {
    beforeEach(() => {
      service.createOutcome('intro-1', 'requester-1', 'broker-1', 'target-1');
    });

    it('accepts a report from the requester', () => {
      const report: OutcomeReport = {
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: new Date().toISOString(),
      };

      const outcome = service.submitReport(report);
      expect(outcome.reports).toHaveLength(1);
      expect(outcome.timing_analysis!.pattern).toBe('single_report');
    });

    it('rejects report for unknown introduction', () => {
      const report: OutcomeReport = {
        introduction_id: 'nonexistent',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: new Date().toISOString(),
      };

      expect(() => service.submitReport(report)).toThrow('not found');
    });

    it('rejects duplicate report from same role', () => {
      const report: OutcomeReport = {
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: new Date().toISOString(),
      };

      service.submitReport(report);
      expect(() => service.submitReport(report)).toThrow('already reported');
    });

    it('rejects report from non-party agent', () => {
      const report: OutcomeReport = {
        introduction_id: 'intro-1',
        reporter_agent_id: 'random-agent',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: new Date().toISOString(),
      };

      expect(() => service.submitReport(report)).toThrow('not a party');
    });
  });

  describe('bilateral resolution', () => {
    beforeEach(() => {
      service.createOutcome('intro-1', 'requester-1', 'broker-1', 'target-1');
    });

    it('resolves when both parties agree on success', () => {
      const now = new Date();

      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const later = new Date(now.getTime() + 3600_000); // 1 hour later
      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: later.toISOString(),
      });

      expect(outcome.resolved_status).toBe('successful');
      expect(outcome.verification_layer).toBe(1);
    });

    it('resolves as disputed when parties disagree', () => {
      const now = new Date();

      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const later = new Date(now.getTime() + 7200_000);
      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'failed',
        evidence_type: 'target_report',
        reported_at: later.toISOString(),
      });

      expect(outcome.resolved_status).toBe('disputed');
      expect(outcome.verification_layer).toBe(2);
    });

    it('resolves when both agree on failure', () => {
      const now = new Date();

      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'failed',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'broker-1',
        reporter_role: 'broker',
        status: 'failed',
        evidence_type: 'requester_report',
        reported_at: new Date(now.getTime() + 120_000).toISOString(),
      });

      expect(outcome.resolved_status).toBe('failed');
    });
  });

  describe('timing analysis', () => {
    beforeEach(() => {
      service.createOutcome('intro-1', 'requester-1', 'broker-1', 'target-1');
    });

    it('detects normal timing (hours apart)', () => {
      const now = new Date();
      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: new Date(now.getTime() + 7200_000).toISOString(), // 2 hours later
      });

      expect(outcome.timing_analysis!.pattern).toBe('normal');
      expect(outcome.timing_analysis!.delta_seconds).toBe(7200);
    });

    it('detects suspicious sync (within 10s)', () => {
      const now = new Date();
      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: new Date(now.getTime() + 5_000).toISOString(), // 5 seconds
      });

      expect(outcome.timing_analysis!.pattern).toBe('suspicious_sync');
      expect(outcome.anomaly_flags).toContain('instant_sync');
    });

    it('detects fast coordination (within 60s)', () => {
      const now = new Date();
      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: new Date(now.getTime() + 30_000).toISOString(), // 30 seconds
      });

      expect(outcome.timing_analysis!.pattern).toBe('fast_coordination');
      expect(outcome.anomaly_flags).toContain('fast_bilateral_sync');
    });

    it('detects target-first reporting', () => {
      const now = new Date();
      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: now.toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: new Date(now.getTime() + 86400_000).toISOString(), // 1 day later
      });

      expect(outcome.timing_analysis!.pattern).toBe('target_first');
    });

    it('flags instant sync for mandatory Layer 3 review', () => {
      const now = new Date();
      service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'requester-1',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-1',
        reporter_agent_id: 'target-1',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: new Date(now.getTime() + 3_000).toISOString(),
      });

      expect(outcome.verification_layer).toBe(3); // Escalated from 1 to 3
    });
  });

  describe('anomaly detection', () => {
    it('detects ring pattern (reciprocal introductions)', () => {
      // Create A→B introduction
      service.createOutcome('intro-ab', 'agent-a', 'broker-1', 'agent-b');
      const now = new Date();
      service.submitReport({
        introduction_id: 'intro-ab',
        reporter_agent_id: 'agent-a',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: now.toISOString(),
      });
      service.submitReport({
        introduction_id: 'intro-ab',
        reporter_agent_id: 'agent-b',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: new Date(now.getTime() + 3600_000).toISOString(),
      });

      // Create B→A introduction (reverse)
      service.createOutcome('intro-ba', 'agent-b', 'broker-2', 'agent-a');
      service.submitReport({
        introduction_id: 'intro-ba',
        reporter_agent_id: 'agent-b',
        reporter_role: 'requester',
        status: 'successful',
        evidence_type: 'requester_report',
        reported_at: new Date(now.getTime() + 7200_000).toISOString(),
      });

      const outcome = service.submitReport({
        introduction_id: 'intro-ba',
        reporter_agent_id: 'agent-a',
        reporter_role: 'target',
        status: 'successful',
        evidence_type: 'target_report',
        reported_at: new Date(now.getTime() + 10800_000).toISOString(),
      });

      expect(outcome.anomaly_flags).toContain('ring_pattern');
    });
  });

  describe('getOutcome()', () => {
    it('returns null for unknown introduction', () => {
      expect(service.getOutcome('nonexistent')).toBeNull();
    });

    it('returns the outcome record', () => {
      service.createOutcome('intro-1', 'r', 'b', 't');
      const outcome = service.getOutcome('intro-1');
      expect(outcome).not.toBeNull();
      expect(outcome!.introduction_id).toBe('intro-1');
    });
  });

  describe('getOutcomesForAgent()', () => {
    it('returns outcomes where agent is requester', () => {
      service.createOutcome('intro-1', 'agent-1', 'broker', 'target');
      service.createOutcome('intro-2', 'other', 'broker', 'target');

      const outcomes = service.getOutcomesForAgent('agent-1');
      expect(outcomes).toHaveLength(1);
    });

    it('returns outcomes where agent is broker', () => {
      service.createOutcome('intro-1', 'req', 'agent-1', 'target');

      const outcomes = service.getOutcomesForAgent('agent-1');
      expect(outcomes).toHaveLength(1);
    });

    it('returns outcomes where agent is target', () => {
      service.createOutcome('intro-1', 'req', 'broker', 'agent-1');

      const outcomes = service.getOutcomesForAgent('agent-1');
      expect(outcomes).toHaveLength(1);
    });

    it('returns all roles combined', () => {
      service.createOutcome('intro-1', 'agent-1', 'broker', 'target');
      service.createOutcome('intro-2', 'other', 'agent-1', 'target');
      service.createOutcome('intro-3', 'other', 'broker', 'agent-1');

      const outcomes = service.getOutcomesForAgent('agent-1');
      expect(outcomes).toHaveLength(3);
    });
  });

  describe('getAgentStats()', () => {
    it('returns zeroes for unknown agent', () => {
      const stats = service.getAgentStats('nobody');
      expect(stats.total).toBe(0);
      expect(stats.success_rate).toBe(0);
    });

    it('calculates correct stats', () => {
      // Create 3 outcomes for agent-1
      service.createOutcome('intro-1', 'agent-1', 'b', 't1');
      service.createOutcome('intro-2', 'agent-1', 'b', 't2');
      service.createOutcome('intro-3', 'agent-1', 'b', 't3');

      const now = new Date();

      // Resolve intro-1 as successful
      service.submitReport({ introduction_id: 'intro-1', reporter_agent_id: 'agent-1', reporter_role: 'requester', status: 'successful', evidence_type: 'requester_report', reported_at: now.toISOString() });
      service.submitReport({ introduction_id: 'intro-1', reporter_agent_id: 't1', reporter_role: 'target', status: 'successful', evidence_type: 'target_report', reported_at: new Date(now.getTime() + 3600_000).toISOString() });

      // Resolve intro-2 as failed
      service.submitReport({ introduction_id: 'intro-2', reporter_agent_id: 'agent-1', reporter_role: 'requester', status: 'failed', evidence_type: 'requester_report', reported_at: now.toISOString() });
      service.submitReport({ introduction_id: 'intro-2', reporter_agent_id: 't2', reporter_role: 'target', status: 'failed', evidence_type: 'target_report', reported_at: new Date(now.getTime() + 3600_000).toISOString() });

      // Leave intro-3 pending (only 1 report)
      service.submitReport({ introduction_id: 'intro-3', reporter_agent_id: 'agent-1', reporter_role: 'requester', status: 'successful', evidence_type: 'requester_report', reported_at: now.toISOString() });

      const stats = service.getAgentStats('agent-1');
      expect(stats.total).toBe(3);
      expect(stats.successful).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.success_rate).toBeCloseTo(1 / 3, 2);
    });
  });

  describe('getPendingResolution()', () => {
    it('returns disputed outcomes', () => {
      service.createOutcome('intro-1', 'r', 'b', 't');
      const now = new Date();

      service.submitReport({ introduction_id: 'intro-1', reporter_agent_id: 'r', reporter_role: 'requester', status: 'successful', evidence_type: 'requester_report', reported_at: now.toISOString() });
      service.submitReport({ introduction_id: 'intro-1', reporter_agent_id: 't', reporter_role: 'target', status: 'failed', evidence_type: 'target_report', reported_at: new Date(now.getTime() + 3600_000).toISOString() });

      const pending = service.getPendingResolution();
      expect(pending).toHaveLength(1);
      expect(pending[0].resolved_status).toBe('disputed');
    });
  });
});
