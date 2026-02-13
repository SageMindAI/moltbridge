/**
 * Unit Tests: IQS (Introduction Quality Score) Service
 *
 * Tests the deterministic scoring formula, anti-oracle protections,
 * threshold adaptation, and probationary behavior.
 * Coverage target: 100% (GDPR Article 22 auditability)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  IQSService,
  IQS_WEIGHTS,
  type IQSComponents,
} from '../../src/services/iqs';

describe('IQS Service', () => {
  let service: IQSService;

  beforeEach(() => {
    service = new IQSService();
  });

  describe('IQS_WEIGHTS', () => {
    it('weights sum to 1.00', () => {
      const sum = IQS_WEIGHTS.relevance +
        IQS_WEIGHTS.requester_credibility +
        IQS_WEIGHTS.broker_confidence +
        IQS_WEIGHTS.path_proximity +
        IQS_WEIGHTS.novelty;
      expect(sum).toBeCloseTo(1.0, 10);
    });

    it('has correct individual weights', () => {
      expect(IQS_WEIGHTS.relevance).toBe(0.30);
      expect(IQS_WEIGHTS.requester_credibility).toBe(0.25);
      expect(IQS_WEIGHTS.broker_confidence).toBe(0.20);
      expect(IQS_WEIGHTS.path_proximity).toBe(0.15);
      expect(IQS_WEIGHTS.novelty).toBe(0.10);
    });
  });

  describe('computeScore()', () => {
    it('all components at 1.0 = 1.0', () => {
      const components: IQSComponents = {
        relevance_score: 1.0,
        requester_credibility: 1.0,
        broker_confidence: 1.0,
        path_proximity: 1.0,
        novelty_score: 1.0,
      };
      expect(service.computeScore(components)).toBeCloseTo(1.0, 4);
    });

    it('all components at 0.0 = 0.0', () => {
      const components: IQSComponents = {
        relevance_score: 0.0,
        requester_credibility: 0.0,
        broker_confidence: 0.0,
        path_proximity: 0.0,
        novelty_score: 0.0,
      };
      expect(service.computeScore(components)).toBe(0);
    });

    it('mixed components computed correctly', () => {
      const components: IQSComponents = {
        relevance_score: 0.8,
        requester_credibility: 0.6,
        broker_confidence: 0.7,
        path_proximity: 0.5,
        novelty_score: 1.0,
      };
      // 0.30*0.8 + 0.25*0.6 + 0.20*0.7 + 0.15*0.5 + 0.10*1.0
      // = 0.24 + 0.15 + 0.14 + 0.075 + 0.10 = 0.705
      expect(service.computeScore(components)).toBeCloseTo(0.705, 3);
    });

    it('is clamped to [0, 1]', () => {
      const overOne: IQSComponents = {
        relevance_score: 2.0,
        requester_credibility: 2.0,
        broker_confidence: 2.0,
        path_proximity: 2.0,
        novelty_score: 2.0,
      };
      expect(service.computeScore(overOne)).toBeLessThanOrEqual(1.0);

      const underZero: IQSComponents = {
        relevance_score: -1.0,
        requester_credibility: -1.0,
        broker_confidence: -1.0,
        path_proximity: -1.0,
        novelty_score: -1.0,
      };
      expect(service.computeScore(underZero)).toBeGreaterThanOrEqual(0);
    });

    it('is deterministic', () => {
      const components: IQSComponents = {
        relevance_score: 0.42,
        requester_credibility: 0.73,
        broker_confidence: 0.55,
        path_proximity: 0.81,
        novelty_score: 0.92,
      };
      const s1 = service.computeScore(components);
      const s2 = service.computeScore(components);
      expect(s1).toBe(s2);
    });
  });

  describe('computeRelevance()', () => {
    it('returns 1.0 for identical capability sets', () => {
      const caps = ['ai-research', 'nlp', 'web3'];
      expect(service.computeRelevance(caps, caps)).toBe(1.0);
    });

    it('returns 0 when no overlap', () => {
      expect(service.computeRelevance(['ai-research'], ['web3'])).toBe(0);
    });

    it('returns 0 for empty arrays', () => {
      expect(service.computeRelevance([], ['ai-research'])).toBe(0);
      expect(service.computeRelevance(['ai-research'], [])).toBe(0);
    });

    it('returns partial overlap correctly', () => {
      const requester = ['ai-research', 'nlp', 'web3'];
      const target = ['ai-research', 'robotics'];
      // intersection = 1, max(3, 2) = 3
      expect(service.computeRelevance(requester, target)).toBeCloseTo(1 / 3, 4);
    });
  });

  describe('mapCredibility()', () => {
    it('maps 0.0 trust to near-zero credibility', () => {
      expect(service.mapCredibility(0.0)).toBeLessThan(0.01);
    });

    it('maps 1.0 trust to near-one credibility', () => {
      expect(service.mapCredibility(1.0)).toBeGreaterThan(0.99);
    });

    it('maps 0.5 trust to ~0.5 credibility', () => {
      expect(service.mapCredibility(0.5)).toBeCloseTo(0.5, 1);
    });

    it('amplifies differences in 0.3-0.7 range', () => {
      const c03 = service.mapCredibility(0.3);
      const c04 = service.mapCredibility(0.4);
      const c06 = service.mapCredibility(0.6);
      const c07 = service.mapCredibility(0.7);

      // The gap between 0.4 and 0.6 should be larger than between 0.0 and 0.2
      const midGap = c06 - c04;
      expect(midGap).toBeGreaterThan(0.3);
    });
  });

  describe('computeBrokerConfidence()', () => {
    it('returns 0.5 for new brokers (no history)', () => {
      expect(service.computeBrokerConfidence(0, 0)).toBe(0.5);
    });

    it('computes success rate correctly', () => {
      expect(service.computeBrokerConfidence(8, 10)).toBe(0.8);
      expect(service.computeBrokerConfidence(5, 10)).toBe(0.5);
    });

    it('caps at 1.0', () => {
      expect(service.computeBrokerConfidence(15, 10)).toBe(1.0);
    });
  });

  describe('computePathProximity()', () => {
    it('1 hop = 1.0 (direct connection)', () => {
      expect(service.computePathProximity(1)).toBe(1.0);
    });

    it('2 hops = 0.75', () => {
      expect(service.computePathProximity(2)).toBe(0.75);
    });

    it('4 hops = 0.25', () => {
      expect(service.computePathProximity(4)).toBe(0.25);
    });

    it('0 hops = 1.0 (self)', () => {
      expect(service.computePathProximity(0)).toBe(1);
    });

    it('>maxHops = 0.0', () => {
      expect(service.computePathProximity(5, 4)).toBe(0);
    });
  });

  describe('computeNovelty()', () => {
    it('first query to target = 1.0 (fully novel)', () => {
      expect(service.computeNovelty('target-1', 'requester-1')).toBe(1.0);
    });

    it('penalizes repeated queries', () => {
      const n1 = service.computeNovelty('target-2', 'requester-1'); // 1.0
      const n2 = service.computeNovelty('target-2', 'requester-2'); // 0.84
      const n3 = service.computeNovelty('target-2', 'requester-3'); // 0.68

      expect(n1).toBe(1.0);
      expect(n2).toBeCloseTo(0.84, 2);
      expect(n3).toBeCloseTo(0.68, 2);
    });

    it('floors at 0.2 for 5+ queries', () => {
      for (let i = 0; i < 5; i++) {
        service.computeNovelty('target-3', `requester-${i}`);
      }
      const n6 = service.computeNovelty('target-3', 'requester-6');
      expect(n6).toBe(0.2);
    });
  });

  describe('getThreshold()', () => {
    it('base threshold is around 0.65', () => {
      const threshold = service.getThreshold({ noise_range: 0 });
      expect(threshold).toBeCloseTo(0.65, 1);
    });

    it('threshold never exceeds ceiling (0.90)', () => {
      // Even with high demand
      for (let i = 0; i < 100; i++) {
        const t = service.getThreshold({ demand_multiplier: 10 });
        expect(t).toBeLessThanOrEqual(0.90);
      }
    });

    it('noise stays within ±10% range', () => {
      const base = 0.65;
      const maxNoise = 0.10 * base; // ±0.065

      for (let i = 0; i < 50; i++) {
        const t = service.getThreshold({ demand_multiplier: 1 });
        expect(t).toBeGreaterThanOrEqual(base - maxNoise - 0.01);
        expect(t).toBeLessThanOrEqual(base + maxNoise + 0.01);
      }
    });

    it('demand-responsive threshold increases with query volume', () => {
      const lowDemand = service.getThreshold({ demand_multiplier: 0.5, noise_range: 0 });
      const highDemand = service.getThreshold({ demand_multiplier: 5.0, noise_range: 0 });
      expect(highDemand).toBeGreaterThan(lowDemand);
    });

    it('resets query counter after 1 hour (getDemandMultiplier internal)', () => {
      vi.useFakeTimers();
      const baseTime = Date.now();
      vi.setSystemTime(baseTime);

      // Create fresh service with fake timers
      const timedService = new IQSService();

      // Call evaluate to increment internal queryCount24h
      timedService.evaluate({
        relevance: 0.8,
        requester_credibility: 0.7,
        broker_confidence: 0.6,
        path_proximity: 0.5,
        novelty: 0.9,
      });

      // Before 1 hour: getDemandMultiplier should reflect accumulated queries
      // Get threshold without demand_multiplier to trigger getDemandMultiplier
      const before = timedService.getThreshold({ noise_range: 0 });

      // Advance past 1 hour
      vi.setSystemTime(baseTime + 61 * 60 * 1000);

      // After 1 hour: counter should reset, demand multiplier = 0
      const after = timedService.getThreshold({ noise_range: 0 });

      // After reset, demand multiplier is 0 (below 1), so no adjustment
      // The threshold should be at or near base (0.65)
      expect(after).toBeCloseTo(0.65, 2);

      vi.useRealTimers();
    });
  });

  describe('Probationary behavior', () => {
    it('days 1-3: threshold is 0.60', () => {
      service.registerProbationary('new-agent');
      const threshold = service.getProbationaryThreshold('new-agent', 0.65);
      expect(threshold).toBe(0.60);
    });

    it('day 8+: uses normal threshold', () => {
      // Register agent 8 days ago
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      (service as any).probationaryAgents.set('old-agent', eightDaysAgo);

      const threshold = service.getProbationaryThreshold('old-agent', 0.65);
      expect(threshold).toBe(0.65);
    });

    it('non-probationary agent uses normal threshold', () => {
      const threshold = service.getProbationaryThreshold('regular-agent', 0.65);
      expect(threshold).toBe(0.65);
    });

    it('days 4-7: linear decay from 0.60 to normal', () => {
      // Register agent 5.5 days ago (midpoint of decay)
      const fivePointFiveDaysAgo = Date.now() - 5.5 * 24 * 60 * 60 * 1000;
      (service as any).probationaryAgents.set('mid-agent', fivePointFiveDaysAgo);

      const normal = 0.70;
      const threshold = service.getProbationaryThreshold('mid-agent', normal);

      // At day 5.5, progress = (5.5 - 3) / 4 = 0.625
      // threshold = 0.60 + (0.70 - 0.60) * 0.625 = 0.60 + 0.0625 = 0.6625
      expect(threshold).toBeCloseTo(0.6625, 2);
    });
  });

  describe('Band classification', () => {
    it('score 0-0.40 = low band', () => {
      const result = service.classify(0.2, 'target');
      expect(result.band).toBe('low');
    });

    it('score 0.40-threshold = medium band', () => {
      // Use a known threshold to test
      const result = service.classify(0.50, 'target');
      expect(result.band).toBe('medium');
    });

    it('score above threshold = high band', () => {
      // Score of 0.95 should always be high
      const result = service.classify(0.95, 'target');
      expect(result.band).toBe('high');
    });

    it('includes recommendation text', () => {
      const low = service.classify(0.1, 'target');
      const high = service.classify(0.95, 'target');

      expect(low.recommendation).toContain('unlikely');
      expect(high.recommendation).toContain('confidence');
    });
  });

  describe('Full evaluation', () => {
    it('returns band-based result with no exact score', () => {
      const components: IQSComponents = {
        relevance_score: 0.9,
        requester_credibility: 0.8,
        broker_confidence: 0.7,
        path_proximity: 0.75,
        novelty_score: 1.0,
      };

      const result = service.evaluate(components, 'target-1', 'requester-1');

      expect(result).toHaveProperty('band');
      expect(result).toHaveProperty('recommendation');
      expect(result).toHaveProperty('threshold_used');
      expect(result.components_received).toBe(true);

      // Anti-oracle: should NOT contain exact numeric score
      expect(result).not.toHaveProperty('score');
      expect(result).not.toHaveProperty('exact_score');
    });
  });
});
