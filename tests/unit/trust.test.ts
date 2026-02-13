/**
 * Unit Tests: Trust Service (src/services/trust.ts)
 *
 * Tests the deterministic trust formula.
 * Coverage target: 100% (core business logic)
 */

import { describe, it, expect } from 'vitest';
import { TRUST_WEIGHTS, type TrustComponents } from '../../src/types';

// We test the pure computation part of TrustService without Neo4j
// Import just the class and test computeScore() directly
// For computeComponents() we'd need integration tests

describe('Trust Score Computation', () => {
  // Create an instance to test computeScore
  // We import it dynamically to avoid the Neo4j module load at import time
  let computeScore: (components: TrustComponents) => number;

  beforeAll(async () => {
    // Mock neo4j before importing TrustService
    const { vi } = await import('vitest');
    vi.doMock('../../src/db/neo4j', () => ({
      getDriver: vi.fn(),
    }));

    const { TrustService } = await import('../../src/services/trust');
    const service = new TrustService();
    computeScore = service.computeScore.bind(service);
  });

  describe('TRUST_WEIGHTS', () => {
    it('weights sum to 1.0', () => {
      const sum = TRUST_WEIGHTS.import + TRUST_WEIGHTS.attestation + TRUST_WEIGHTS.cross_verification;
      expect(sum).toBeCloseTo(1.0, 10);
    });

    it('has correct individual weights', () => {
      expect(TRUST_WEIGHTS.import).toBe(0.17);
      expect(TRUST_WEIGHTS.attestation).toBe(0.25);
      expect(TRUST_WEIGHTS.cross_verification).toBe(0.58);
    });
  });

  describe('computeScore()', () => {
    it('all components at 1.0 → score = 1.0', () => {
      const score = computeScore({
        import_score: 1.0,
        attestation_score: 1.0,
        cross_verification_score: 1.0,
      });
      expect(score).toBeCloseTo(1.0, 4);
    });

    it('all components at 0.0 → score = 0.0', () => {
      const score = computeScore({
        import_score: 0.0,
        attestation_score: 0.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBe(0);
    });

    it('import_score only → weighted correctly', () => {
      const score = computeScore({
        import_score: 1.0,
        attestation_score: 0.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBeCloseTo(0.17, 4);
    });

    it('attestation_score only → weighted correctly', () => {
      const score = computeScore({
        import_score: 0.0,
        attestation_score: 1.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBeCloseTo(0.25, 4);
    });

    it('cross_verification_score only → weighted correctly', () => {
      const score = computeScore({
        import_score: 0.0,
        attestation_score: 0.0,
        cross_verification_score: 1.0,
      });
      expect(score).toBeCloseTo(0.58, 4);
    });

    it('mixed components computed correctly', () => {
      const score = computeScore({
        import_score: 0.75,
        attestation_score: 0.5,
        cross_verification_score: 0.3,
      });
      // 0.17*0.75 + 0.25*0.5 + 0.58*0.3 = 0.1275 + 0.125 + 0.174 = 0.4265
      expect(score).toBeCloseTo(0.4265, 4);
    });

    it('result is clamped to [0.0, 1.0]', () => {
      // Even with components > 1.0, result shouldn't exceed 1.0
      const score = computeScore({
        import_score: 2.0,
        attestation_score: 2.0,
        cross_verification_score: 2.0,
      });
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('negative components clamped to 0', () => {
      const score = computeScore({
        import_score: -1.0,
        attestation_score: -1.0,
        cross_verification_score: -1.0,
      });
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('is deterministic (same inputs = same output)', () => {
      const components: TrustComponents = {
        import_score: 0.6,
        attestation_score: 0.4,
        cross_verification_score: 0.8,
      };
      const score1 = computeScore(components);
      const score2 = computeScore(components);
      expect(score1).toBe(score2);
    });

    it('new agent with minimal data gets low score', () => {
      // New agent: just has name/platform (import_score=0.5), no attestations
      const score = computeScore({
        import_score: 0.5,
        attestation_score: 0.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBeCloseTo(0.085, 4); // 0.17 * 0.5 = 0.085
      expect(score).toBeLessThan(0.2);
    });
  });
});
