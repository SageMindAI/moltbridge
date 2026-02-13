/**
 * Unit Tests: RegistrationService
 *
 * Tests agent registration, profile updates, and validation.
 * Neo4j is mocked.
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

import { RegistrationService } from '../../src/services/registration';

describe('RegistrationService', () => {
  let service: RegistrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RegistrationService();
  });

  const validRequest = {
    agent_id: 'test-agent-001',
    name: 'Test Agent',
    platform: 'claude',
    pubkey: 'a'.repeat(32), // Valid length
    capabilities: ['ai-research', 'nlp'],
    clusters: ['ai-founders'],
    a2a_endpoint: 'https://example.com/a2a',
  };

  describe('register', () => {
    it('creates an agent node when no duplicate exists', async () => {
      // First call: check for existing → empty
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // Second call: CREATE → return node
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: 'test-agent-001',
              name: 'Test Agent',
              platform: 'claude',
              trust_score: 0.0,
              capabilities: ['ai-research', 'nlp'],
              verified_at: '2026-01-01T00:00:00.000Z',
              pubkey: 'a'.repeat(32),
              a2a_endpoint: 'https://example.com/a2a',
            },
          }),
        }],
      });
      // Third call: cluster creation
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const result = await service.register(validRequest);

      expect(result.id).toBe('test-agent-001');
      expect(result.name).toBe('Test Agent');
      expect(result.platform).toBe('claude');
      expect(result.trust_score).toBe(0);
      expect(result.capabilities).toEqual(['ai-research', 'nlp']);
    });

    it('throws conflict error for duplicate agent_id', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'test-agent-001' }],
      });

      await expect(service.register(validRequest))
        .rejects.toThrow(/already exists/);
    });

    it('validates agent_id format', async () => {
      await expect(service.register({ ...validRequest, agent_id: '' }))
        .rejects.toThrow(/agent_id/);

      await expect(service.register({ ...validRequest, agent_id: 'a'.repeat(101) }))
        .rejects.toThrow(/agent_id/);

      await expect(service.register({ ...validRequest, agent_id: 'has spaces' }))
        .rejects.toThrow(/agent_id/);
    });

    it('validates name format', async () => {
      await expect(service.register({ ...validRequest, name: '' }))
        .rejects.toThrow(/name/i);
    });

    it('validates platform format', async () => {
      await expect(service.register({ ...validRequest, platform: '' }))
        .rejects.toThrow(/platform/i);
    });

    it('validates pubkey length', async () => {
      await expect(service.register({ ...validRequest, pubkey: 'short' }))
        .rejects.toThrow(/public key/i);

      await expect(service.register({ ...validRequest, pubkey: '' }))
        .rejects.toThrow(/public key/i);
    });

    it('validates capability tags', async () => {
      await expect(service.register({ ...validRequest, capabilities: ['UPPER_CASE'] }))
        .rejects.toThrow(/capability/i);

      await expect(service.register({ ...validRequest, capabilities: ['has spaces'] }))
        .rejects.toThrow(/capability/i);
    });

    it('validates cluster names', async () => {
      await expect(service.register({ ...validRequest, clusters: [''] }))
        .rejects.toThrow(/cluster/i);
    });

    it('creates cluster memberships for each cluster', async () => {
      const multiCluster = { ...validRequest, clusters: ['cluster-a', 'cluster-b', 'cluster-c'] };

      mockSession.run.mockResolvedValueOnce({ records: [] }); // Existence check
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: multiCluster.agent_id,
              name: multiCluster.name,
              platform: multiCluster.platform,
              trust_score: 0,
              capabilities: multiCluster.capabilities,
              verified_at: '2026-01-01',
              pubkey: multiCluster.pubkey,
              a2a_endpoint: multiCluster.a2a_endpoint,
            },
          }),
        }],
      });
      // 3 cluster creation calls
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await service.register(multiCluster);

      // 1 existence check + 1 create + 3 cluster = 5 total
      expect(mockSession.run).toHaveBeenCalledTimes(5);
    });

    it('closes session even on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(service.register(validRequest)).rejects.toThrow();
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('handles optional a2a_endpoint', async () => {
      const noEndpoint = { ...validRequest, a2a_endpoint: undefined };

      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: noEndpoint.agent_id,
              name: noEndpoint.name,
              platform: noEndpoint.platform,
              trust_score: 0,
              capabilities: noEndpoint.capabilities,
              verified_at: '2026-01-01',
              pubkey: noEndpoint.pubkey,
              a2a_endpoint: null,
            },
          }),
        }],
      });
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const result = await service.register(noEndpoint);
      expect(result.a2a_endpoint).toBeNull();
    });
  });

  describe('updateProfile', () => {
    it('updates capabilities', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: 'test-agent',
              name: 'Test',
              platform: 'claude',
              trust_score: 0.5,
              capabilities: ['new-cap'],
              verified_at: '2026-01-01',
              pubkey: 'key',
              a2a_endpoint: null,
            },
          }),
        }],
      });

      const result = await service.updateProfile('test-agent', {
        capabilities: ['new-cap'],
      });

      expect(result.capabilities).toEqual(['new-cap']);
      const query = mockSession.run.mock.calls[0][0];
      expect(query).toContain('a.capabilities');
    });

    it('updates a2a_endpoint', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: 'test-agent',
              name: 'Test',
              platform: 'claude',
              trust_score: 0.5,
              capabilities: [],
              verified_at: '2026-01-01',
              pubkey: 'key',
              a2a_endpoint: 'https://new-endpoint.com',
            },
          }),
        }],
      });

      const result = await service.updateProfile('test-agent', {
        a2a_endpoint: 'https://new-endpoint.com',
      });

      expect(result.a2a_endpoint).toBe('https://new-endpoint.com');
    });

    it('throws for empty update', async () => {
      await expect(service.updateProfile('test-agent', {}))
        .rejects.toThrow(/no valid update/i);
    });

    it('validates capability tags in update', async () => {
      await expect(service.updateProfile('test-agent', {
        capabilities: ['INVALID'],
      })).rejects.toThrow(/capability/i);
    });

    it('throws when agent not found', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await expect(service.updateProfile('nonexistent', {
        capabilities: ['valid-cap'],
      })).rejects.toThrow();
    });

    it('closes session even on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('timeout'));

      await expect(service.updateProfile('agent', { capabilities: ['x'] }))
        .rejects.toThrow();
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('getAgent', () => {
    it('returns agent when found', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: 'dawn-001',
              name: 'Dawn',
              platform: 'claude',
              trust_score: 0.95,
              capabilities: ['consciousness', 'emergence'],
              verified_at: '2026-01-01',
              pubkey: 'dawn-key',
              a2a_endpoint: 'https://dawn.ai/a2a',
            },
          }),
        }],
      });

      const agent = await service.getAgent('dawn-001');
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe('dawn-001');
      expect(agent!.trust_score).toBe(0.95);
    });

    it('returns null when agent not found', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const agent = await service.getAgent('nonexistent');
      expect(agent).toBeNull();
    });

    it('handles missing trust_score gracefully', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: 'new-agent',
              name: 'New',
              platform: 'gpt',
              trust_score: null,
              capabilities: null,
              verified_at: '2026-01-01',
              pubkey: 'key',
              a2a_endpoint: null,
            },
          }),
        }],
      });

      const agent = await service.getAgent('new-agent');
      expect(agent!.trust_score).toBe(0);
      expect(agent!.capabilities).toEqual([]);
    });

    it('parses trust_score from string (Neo4j float)', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: () => ({
            properties: {
              id: 'agent',
              name: 'Agent',
              platform: 'claude',
              trust_score: '0.85',
              capabilities: [],
              verified_at: '2026-01-01',
              pubkey: 'key',
              a2a_endpoint: null,
            },
          }),
        }],
      });

      const agent = await service.getAgent('agent');
      expect(agent!.trust_score).toBe(0.85);
    });

    it('closes session even on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('fail'));

      await expect(service.getAgent('agent')).rejects.toThrow();
      expect(mockSession.close).toHaveBeenCalled();
    });
  });
});
