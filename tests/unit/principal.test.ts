/**
 * Unit Tests: PrincipalService
 *
 * Tests principal onboarding, profile updates, enrichment level calculation,
 * and visibility controls. Neo4j is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Neo4j
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

import { PrincipalService } from '../../src/services/principal';

describe('PrincipalService', () => {
  let service: PrincipalService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PrincipalService();
  });

  describe('onboard', () => {
    it('requires at least one meaningful field', async () => {
      await expect(service.onboard('agent-001', {})).rejects.toThrow(
        'At least one of industry, role, or expertise is required'
      );
    });

    it('validates expertise tags format', async () => {
      await expect(
        service.onboard('agent-001', { expertise: ['Invalid Tag!'] })
      ).rejects.toThrow('Invalid expertise tag');
    });

    it('validates bio length', async () => {
      await expect(
        service.onboard('agent-001', { role: 'CEO', bio: 'x'.repeat(501) })
      ).rejects.toThrow('Bio must be 500 characters or less');
    });

    it('creates profile with basic enrichment for industry only', async () => {
      // Agent check → found
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001' }],
      });
      // Onboarding check → not onboarded
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // SET human node
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const profile = await service.onboard('agent-001', {
        industry: 'technology',
      });

      expect(profile.agent_id).toBe('agent-001');
      expect(profile.industry).toBe('technology');
      expect(profile.enrichment_level).toBe('basic');
      expect(profile.onboarded_at).toBeTruthy();
    });

    it('creates profile with detailed enrichment when fully specified', async () => {
      // Agent check → found
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001' }],
      });
      // Onboarding check → not onboarded
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // SET human node
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // 3x expertise cluster connections
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const profile = await service.onboard('agent-001', {
        industry: 'venture-capital',
        role: 'managing-partner',
        expertise: ['ai-infrastructure', 'defi', 'saas-b2b'],
        bio: 'Focused on AI infrastructure investments.',
        interests: ['ai-agents', 'network-effects'],
        looking_for: ['ai-founders'],
        can_offer: ['funding', 'advisory'],
      });

      expect(profile.enrichment_level).toBe('detailed');
      expect(profile.expertise).toHaveLength(3);
      expect(profile.expertise[0]).toEqual({
        tag: 'ai-infrastructure',
        verified: false,
        source: 'agent-declared',
        attestation_count: 0,
      });
    });

    it('rejects if agent not found', async () => {
      // Agent check → not found
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await expect(
        service.onboard('nonexistent-agent', { industry: 'tech' })
      ).rejects.toThrow();
    });

    it('rejects if already onboarded', async () => {
      // Agent check → found
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001' }],
      });
      // Onboarding check → already onboarded
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001-human' }],
      });

      await expect(
        service.onboard('agent-001', { industry: 'tech' })
      ).rejects.toThrow('Principal already onboarded');
    });

    it('creates project nodes when provided', async () => {
      // Agent check → found
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001' }],
      });
      // Onboarding check → not onboarded
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // SET human node
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // Project creation
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const profile = await service.onboard('agent-001', {
        industry: 'tech',
        projects: [{
          name: 'AI Agent Fund',
          description: '$50M fund',
          status: 'active',
          visibility: 'public',
        }],
      });

      expect(profile.projects).toHaveLength(1);
      expect(profile.projects[0].name).toBe('AI Agent Fund');
      // Should have called session.run for the project creation
      expect(mockSession.run).toHaveBeenCalledTimes(4);
    });
  });

  describe('enrichment level calculation', () => {
    it('returns none when no fields provided', async () => {
      // This is tested indirectly — the validation will throw before we get
      // to enrichment calculation. The private method handles the edge case.
      await expect(service.onboard('agent-001', {})).rejects.toThrow();
    });

    it('returns basic for role only', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001' }],
      });
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const profile = await service.onboard('agent-001', { role: 'engineer' });
      expect(profile.enrichment_level).toBe('basic');
    });

    it('returns basic for single expertise', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'agent-001' }],
      });
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] }); // cluster connection

      const profile = await service.onboard('agent-001', {
        expertise: ['ai-research'],
      });
      expect(profile.enrichment_level).toBe('basic');
    });
  });

  describe('getProfile', () => {
    it('returns full profile from graph', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            if (key === 'h') return {
              properties: {
                industry: 'tech',
                role: 'cto',
                organization: 'Acme',
                bio: 'Building things',
                location: 'SF',
                looking_for: ['engineers'],
                can_offer: ['mentorship'],
                interests: ['ai', 'web3'],
                expertise_tags: ['backend', 'infra'],
                enrichment_level: 'detailed',
                onboarded_at: '2026-02-14T00:00:00Z',
                last_updated: '2026-02-14T01:00:00Z',
              },
            };
            if (key === 'expertise') return [
              { tag: 'backend', verified: true, source: 'peer-attested', attestation_count: 2 },
              { tag: 'infra', verified: false, source: 'agent-declared', attestation_count: 0 },
            ];
            if (key === 'projects') return [
              { name: 'Widget', description: 'A widget', status: 'active', visibility: 'public' },
            ];
            return null;
          },
        }],
      });

      const profile = await service.getProfile('agent-001');
      expect(profile.industry).toBe('tech');
      expect(profile.expertise).toHaveLength(2);
      expect(profile.expertise[0].verified).toBe(true);
      expect(profile.projects).toHaveLength(1);
    });

    it('throws when agent not found', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });
      await expect(service.getProfile('nonexistent')).rejects.toThrow();
    });
  });

  describe('getVisibility', () => {
    it('filters out private projects', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            if (key === 'h') return {
              properties: {
                industry: 'tech',
                enrichment_level: 'basic',
                onboarded_at: '2026-02-14T00:00:00Z',
                last_updated: '2026-02-14T00:00:00Z',
                looking_for: [],
                can_offer: [],
                interests: [],
              },
            };
            if (key === 'expertise') return [];
            if (key === 'projects') return [
              { name: 'Public Project', status: 'active', visibility: 'public' },
              { name: 'Secret Project', status: 'active', visibility: 'private' },
            ];
            return null;
          },
        }],
      });

      const visible = await service.getVisibility('agent-001');
      expect(visible.projects).toHaveLength(1);
      expect(visible.projects![0].name).toBe('Public Project');
    });
  });
});
