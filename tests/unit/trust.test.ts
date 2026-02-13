/**
 * Unit Tests: Trust Service (src/services/trust.ts)
 *
 * Tests the deterministic trust formula AND Neo4j-backed methods.
 * Coverage target: 100% (core business logic)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Neo4j — vi.mock is hoisted, so use vi.hoisted() for shared state
const { mockSession, mockDriver } = vi.hoisted(() => {
  const mockSession = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockDriver = {
    session: vi.fn().mockReturnValue(mockSession),
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { mockSession, mockDriver };
});

vi.mock('../../src/db/neo4j', () => ({
  getDriver: vi.fn().mockReturnValue(mockDriver),
  verifyConnectivity: vi.fn().mockResolvedValue(true),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

import { TrustService } from '../../src/services/trust';
import { TRUST_WEIGHTS, type TrustComponents } from '../../src/types';

describe('TrustService', () => {
  let service: TrustService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TrustService();
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

  describe('computeScore', () => {
    it('all components at 1.0 → score = 1.0', () => {
      const score = service.computeScore({
        import_score: 1.0,
        attestation_score: 1.0,
        cross_verification_score: 1.0,
      });
      expect(score).toBeCloseTo(1.0, 4);
    });

    it('all components at 0.0 → score = 0.0', () => {
      const score = service.computeScore({
        import_score: 0.0,
        attestation_score: 0.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBe(0);
    });

    it('import_score only → weighted correctly', () => {
      const score = service.computeScore({
        import_score: 1.0,
        attestation_score: 0.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBeCloseTo(0.17, 4);
    });

    it('attestation_score only → weighted correctly', () => {
      const score = service.computeScore({
        import_score: 0.0,
        attestation_score: 1.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBeCloseTo(0.25, 4);
    });

    it('cross_verification_score only → weighted correctly', () => {
      const score = service.computeScore({
        import_score: 0.0,
        attestation_score: 0.0,
        cross_verification_score: 1.0,
      });
      expect(score).toBeCloseTo(0.58, 4);
    });

    it('mixed components computed correctly', () => {
      const score = service.computeScore({
        import_score: 0.75,
        attestation_score: 0.5,
        cross_verification_score: 0.3,
      });
      // 0.17*0.75 + 0.25*0.5 + 0.58*0.3 = 0.1275 + 0.125 + 0.174 = 0.4265
      expect(score).toBeCloseTo(0.4265, 4);
    });

    it('clamps score above 1.0', () => {
      const score = service.computeScore({
        import_score: 2.0,
        attestation_score: 2.0,
        cross_verification_score: 2.0,
      });
      expect(score).toBe(1.0);
    });

    it('clamps negative scores to 0', () => {
      const score = service.computeScore({
        import_score: -1.0,
        attestation_score: -1.0,
        cross_verification_score: -1.0,
      });
      expect(score).toBe(0);
    });

    it('is deterministic (same inputs = same output)', () => {
      const components: TrustComponents = {
        import_score: 0.6,
        attestation_score: 0.4,
        cross_verification_score: 0.8,
      };
      expect(service.computeScore(components)).toBe(service.computeScore(components));
    });

    it('new agent with minimal data gets low score', () => {
      const score = service.computeScore({
        import_score: 0.5,
        attestation_score: 0.0,
        cross_verification_score: 0.0,
      });
      expect(score).toBeCloseTo(0.085, 4);
      expect(score).toBeLessThan(0.2);
    });

    it('rounds to 4 decimal places', () => {
      const score = service.computeScore({
        import_score: 0.333,
        attestation_score: 0.666,
        cross_verification_score: 0.999,
      });
      const str = score.toString();
      const decimals = str.split('.')[1] || '';
      expect(decimals.length).toBeLessThanOrEqual(4);
    });
  });

  describe('computeComponents', () => {
    it('returns components from Neo4j query', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'import_score': return 0.75;
              case 'attestation_score': return 0.5;
              case 'cross_verification_score': return 0.3;
              default: return null;
            }
          },
        }],
      });

      const components = await service.computeComponents('test-agent');

      expect(components.import_score).toBe(0.75);
      expect(components.attestation_score).toBe(0.5);
      expect(components.cross_verification_score).toBe(0.3);
    });

    it('returns zero components when agent not found', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const components = await service.computeComponents('nonexistent');

      expect(components.import_score).toBe(0);
      expect(components.attestation_score).toBe(0);
      expect(components.cross_verification_score).toBe(0);
    });

    it('handles null values from Neo4j', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => null,
        }],
      });

      const components = await service.computeComponents('agent');

      expect(components.import_score).toBe(0);
      expect(components.attestation_score).toBe(0);
      expect(components.cross_verification_score).toBe(0);
    });

    it('parses string values from Neo4j floats', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'import_score': return '0.9';
              case 'attestation_score': return '0.5';
              case 'cross_verification_score': return '0.7';
              default: return null;
            }
          },
        }],
      });

      const components = await service.computeComponents('agent');

      expect(components.import_score).toBe(0.9);
      expect(components.attestation_score).toBe(0.5);
      expect(components.cross_verification_score).toBe(0.7);
    });

    it('passes agentId to the Cypher query', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.computeComponents('dawn-001');

      expect(mockSession.run).toHaveBeenCalledWith(
        expect.stringContaining('MATCH (a:Agent {id: $agentId})'),
        { agentId: 'dawn-001' },
      );
    });

    it('closes session even on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.computeComponents('agent')).rejects.toThrow('DB error');
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('recalculate', () => {
    it('computes and persists trust score', async () => {
      // First call: computeComponents query
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'import_score': return 1.0;
              case 'attestation_score': return 0.5;
              case 'cross_verification_score': return 0.8;
              default: return null;
            }
          },
        }],
      });
      // Second call: persist score (SET query)
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const score = await service.recalculate('test-agent');

      // 0.17*1.0 + 0.25*0.5 + 0.58*0.8 = 0.17 + 0.125 + 0.464 = 0.759
      expect(score).toBeCloseTo(0.759, 3);

      // Verify the SET query was called with correct params
      const lastCall = mockSession.run.mock.calls[1];
      expect(lastCall[0]).toContain('SET a.trust_score');
      expect(lastCall[1].agentId).toBe('test-agent');
      expect(lastCall[1].score).toBeCloseTo(0.759, 3);
    });

    it('returns 0 for unknown agent (no components)', async () => {
      // computeComponents returns zeros (agent not found)
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // persist
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const score = await service.recalculate('unknown');
      expect(score).toBe(0);
    });

    it('closes session even on persist error', async () => {
      // computeComponents succeeds
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => 0.5,
        }],
      });
      // persist fails
      mockSession.run.mockRejectedValueOnce(new Error('write failed'));

      await expect(service.recalculate('agent')).rejects.toThrow('write failed');
      expect(mockSession.close).toHaveBeenCalled();
    });
  });
});
