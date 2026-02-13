/**
 * Unit Tests: BrokerService
 *
 * Tests broker discovery and capability matching with mocked Neo4j.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { BrokerService } from '../../src/services/broker';

describe('BrokerService', () => {
  let service: BrokerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BrokerService();
  });

  describe('findBrokerToPerson', () => {
    it('returns broker results when path exists', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => {
              switch (key) {
                case 'broker_id': return 'broker-001';
                case 'broker_name': return 'Connector Bot';
                case 'trust_score': return 0.85;
                case 'hops': return 2;
                case 'clusters': return ['ai-founders'];
                case 'composite_score': return 12.5;
                default: return null;
              }
            },
          },
        ],
      });

      const result = await service.findBrokerToPerson({
        source_agent_id: 'dawn-001',
        target_identifier: 'target-001',
      });

      expect(result.path_found).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].broker_agent_id).toBe('broker-001');
      expect(result.results[0].broker_name).toBe('Connector Bot');
      expect(result.results[0].broker_trust_score).toBe(0.85);
      expect(result.results[0].path_hops).toBe(2);
      expect(result.results[0].via_clusters).toEqual(['ai-founders']);
      expect(result.query_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns "source not found" when source does not exist', async () => {
      // First query: path finding → no results
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // Second query: existence check
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'sourceExists': return false;
              case 'targetExists': return true;
              default: return null;
            }
          },
        }],
      });

      const result = await service.findBrokerToPerson({
        source_agent_id: 'nonexistent',
        target_identifier: 'target-001',
      });

      expect(result.path_found).toBe(false);
      expect(result.results).toEqual([]);
      expect(result.message).toContain('nonexistent');
      expect(result.message).toContain('not found');
    });

    it('returns "target not found" when target does not exist', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'sourceExists': return true;
              case 'targetExists': return false;
              default: return null;
            }
          },
        }],
      });

      const result = await service.findBrokerToPerson({
        source_agent_id: 'dawn-001',
        target_identifier: 'unknown-target',
      });

      expect(result.path_found).toBe(false);
      expect(result.message).toContain('unknown-target');
      expect(result.message).toContain('not found');
    });

    it('returns "no path" when both exist but no connection', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'sourceExists': return true;
              case 'targetExists': return true;
              default: return null;
            }
          },
        }],
      });

      const result = await service.findBrokerToPerson({
        source_agent_id: 'dawn-001',
        target_identifier: 'isolated-001',
      });

      expect(result.path_found).toBe(false);
      expect(result.message).toContain('No connection path');
    });

    it('respects max_hops parameter', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => true,
        }],
      });

      await service.findBrokerToPerson({
        source_agent_id: 'source',
        target_identifier: 'target',
        max_hops: 2,
      });

      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain('*1..2');
    });

    it('respects max_results parameter', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => true,
        }],
      });

      await service.findBrokerToPerson({
        source_agent_id: 'source',
        target_identifier: 'target',
        max_results: 5,
      });

      const params = mockSession.run.mock.calls[0][1];
      expect(params.maxResults).toBe(5);
    });

    it('defaults to max_hops=4, max_results=3', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => true,
        }],
      });

      await service.findBrokerToPerson({
        source_agent_id: 'source',
        target_identifier: 'target',
      });

      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain('*1..4');
      expect(mockSession.run.mock.calls[0][1].maxResults).toBe(3);
    });

    it('handles Neo4j Integer objects for hops and composite_score', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'broker_id': return 'broker-x';
              case 'broker_name': return 'X Bot';
              case 'trust_score': return 0.5;
              case 'hops': return { toNumber: () => 3 };
              case 'clusters': return [];
              case 'composite_score': return { toNumber: () => 8.1234 };
              default: return null;
            }
          },
        }],
      });

      const result = await service.findBrokerToPerson({
        source_agent_id: 'source',
        target_identifier: 'target',
      });

      expect(result.results[0].path_hops).toBe(3);
      expect(result.results[0].composite_score).toBeCloseTo(8.1234, 3);
    });

    it('handles null clusters gracefully', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'broker_id': return 'broker-1';
              case 'broker_name': return 'Bot';
              case 'trust_score': return 0.5;
              case 'hops': return 1;
              case 'clusters': return null;
              case 'composite_score': return 1.0;
              default: return null;
            }
          },
        }],
      });

      const result = await service.findBrokerToPerson({
        source_agent_id: 'source',
        target_identifier: 'target',
      });

      expect(result.results[0].via_clusters).toEqual([]);
    });

    it('closes session even on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('DB timeout'));

      await expect(service.findBrokerToPerson({
        source_agent_id: 'source',
        target_identifier: 'target',
      })).rejects.toThrow('DB timeout');
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('findCapabilityMatch', () => {
    it('returns matching agents ranked by match_score', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [
          {
            get: (key: string) => {
              switch (key) {
                case 'agent_id': return 'agent-a';
                case 'agent_name': return 'Agent A';
                case 'trust_score': return 0.9;
                case 'matched_capabilities': return ['ai-research', 'nlp'];
                case 'match_score': return 0.9;
                default: return null;
              }
            },
          },
          {
            get: (key: string) => {
              switch (key) {
                case 'agent_id': return 'agent-b';
                case 'agent_name': return 'Agent B';
                case 'trust_score': return 0.5;
                case 'matched_capabilities': return ['ai-research'];
                case 'match_score': return 0.25;
                default: return null;
              }
            },
          },
        ],
      });

      const result = await service.findCapabilityMatch({
        capabilities: ['ai-research', 'nlp'],
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].agent_id).toBe('agent-a');
      expect(result.results[0].match_score).toBe(0.9);
      expect(result.results[1].agent_id).toBe('agent-b');
      expect(result.results[1].match_score).toBe(0.25);
      expect(result.query_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns empty when no matches', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const result = await service.findCapabilityMatch({
        capabilities: ['quantum-computing'],
      });

      expect(result.results).toEqual([]);
    });

    it('passes min_trust_score to query', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.findCapabilityMatch({
        capabilities: ['ai'],
        min_trust_score: 0.5,
      });

      const params = mockSession.run.mock.calls[0][1];
      expect(params.minTrust).toBe(0.5);
    });

    it('defaults min_trust_score to 0', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.findCapabilityMatch({
        capabilities: ['ai'],
      });

      const params = mockSession.run.mock.calls[0][1];
      expect(params.minTrust).toBe(0);
    });

    it('respects max_results parameter', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.findCapabilityMatch({
        capabilities: ['ai'],
        max_results: 5,
      });

      const params = mockSession.run.mock.calls[0][1];
      expect(params.maxResults).toBe(5);
    });

    it('handles null trust_score gracefully', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'agent_id': return 'new-agent';
              case 'agent_name': return 'New';
              case 'trust_score': return null;
              case 'matched_capabilities': return null;
              case 'match_score': return null;
              default: return null;
            }
          },
        }],
      });

      const result = await service.findCapabilityMatch({
        capabilities: ['ai'],
      });

      expect(result.results[0].trust_score).toBe(0);
      expect(result.results[0].matched_capabilities).toEqual([]);
      expect(result.results[0].match_score).toBe(0);
    });

    it('closes session even on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('timeout'));

      await expect(service.findCapabilityMatch({
        capabilities: ['ai'],
      })).rejects.toThrow('timeout');
      expect(mockSession.close).toHaveBeenCalled();
    });
  });
});
