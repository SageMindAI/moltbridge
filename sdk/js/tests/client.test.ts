/**
 * Tests for MoltBridge client — mocked fetch responses.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MoltBridge } from '../src/client.js';
import {
  MoltBridgeError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
} from '../src/errors.js';

function mockFetch(status: number, body: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchSequence(responses: Array<{ status: number; body: Record<string, unknown> }>) {
  const fn = vi.fn();
  for (const [i, r] of responses.entries()) {
    fn.mockResolvedValueOnce({
      status: r.status,
      json: () => Promise.resolve(r.body),
    });
  }
  return fn;
}

describe('MoltBridge Client', () => {
  let mb: MoltBridge;

  beforeEach(() => {
    mb = new MoltBridge({
      baseUrl: 'http://localhost:3040',
      agentId: 'test-agent-001',
      signingKey: 'aa'.repeat(32),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('sets agentId and publicKey', () => {
      expect(mb.agentId).toBe('test-agent-001');
      expect(mb.publicKey).toBeTruthy();
      expect(mb.publicKey!.length).toBeGreaterThan(0);
    });

    it('handles no credentials', () => {
      const noAuth = new MoltBridge({ baseUrl: 'http://localhost:3040' });
      expect(noAuth.agentId).toBeNull();
      expect(noAuth.publicKey).toBeNull();
    });

    it('generates keypair when only agentId provided', () => {
      const autoKey = new MoltBridge({
        baseUrl: 'http://localhost:3040',
        agentId: 'auto-agent',
      });
      expect(autoKey.agentId).toBe('auto-agent');
      expect(autoKey.publicKey).toBeTruthy();
    });
  });

  describe('health()', () => {
    it('returns health status without auth', async () => {
      globalThis.fetch = mockFetch(200, {
        name: 'MoltBridge',
        status: 'healthy',
        uptime: 100,
        neo4j: { connected: true },
      });

      const result = await mb.health();
      expect(result.status).toBe('healthy');

      // Verify no Authorization header
      const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers.Authorization).toBeUndefined();
    });
  });

  describe('pricing()', () => {
    it('returns pricing info without auth', async () => {
      globalThis.fetch = mockFetch(200, {
        broker_discovery: 0.02,
        capability_match: 0.01,
        currency: 'USDC',
      });

      const result = await mb.pricing();
      expect(result.currency).toBe('USDC');
    });
  });

  describe('discoverBroker()', () => {
    it('returns broker results', async () => {
      globalThis.fetch = mockFetch(200, {
        results: [{
          broker_agent_id: 'broker-001',
          broker_name: 'BridgeBot',
          broker_trust_score: 0.85,
          path_hops: 2,
          via_clusters: ['AI Research'],
          composite_score: 0.72,
        }],
        query_time_ms: 45,
        path_found: true,
        discovery_hint: 'Share with agents',
      });

      const result = await mb.discoverBroker({ target: 'peter-d' });
      expect(result.path_found).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].broker_name).toBe('BridgeBot');
      expect(result.results[0].broker_trust_score).toBe(0.85);
    });

    it('handles no path found', async () => {
      globalThis.fetch = mockFetch(200, {
        results: [],
        query_time_ms: 30,
        path_found: false,
        message: 'No path exists',
      });

      const result = await mb.discoverBroker({ target: 'unreachable' });
      expect(result.path_found).toBe(false);
      expect(result.results).toHaveLength(0);
    });

    it('sends Authorization header', async () => {
      globalThis.fetch = mockFetch(200, { results: [], query_time_ms: 0, path_found: false });
      await mb.discoverBroker({ target: 'test' });

      const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers.Authorization).toMatch(/^MoltBridge-Ed25519 test-agent-001:/);
    });
  });

  describe('discoverCapability()', () => {
    it('returns capability matches', async () => {
      globalThis.fetch = mockFetch(200, {
        results: [{
          agent_id: 'agent-007',
          agent_name: 'SpaceAgent',
          trust_score: 0.9,
          matched_capabilities: ['space-tech'],
          match_score: 0.85,
        }],
        query_time_ms: 20,
      });

      const result = await mb.discoverCapability({ needs: ['space-tech'] });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].agent_name).toBe('SpaceAgent');
    });
  });

  describe('attest()', () => {
    it('submits attestation', async () => {
      globalThis.fetch = mockFetch(200, {
        attestation: {
          source: 'test-agent-001',
          target: 'agent-002',
          type: 'INTERACTION',
          confidence: 0.8,
          created_at: '2026-01-01T00:00:00Z',
          valid_until: '2026-07-01T00:00:00Z',
        },
        target_trust_score: 0.75,
      });

      const result = await mb.attest({
        targetAgentId: 'agent-002',
        attestationType: 'INTERACTION',
        confidence: 0.8,
      });
      expect(result.attestation.source).toBe('test-agent-001');
      expect(result.target_trust_score).toBe(0.75);
    });
  });

  describe('IQS', () => {
    it('evaluates IQS', async () => {
      globalThis.fetch = mockFetch(200, {
        band: 'high',
        recommendation: 'Proceed with introduction',
        threshold_used: 0.7,
        is_probationary: false,
        components_received: true,
      });

      const result = await mb.evaluateIqs({ targetId: 'target-001' });
      expect(result.band).toBe('high');
      expect(result.components_received).toBe(true);
    });
  });

  describe('consent', () => {
    it('gets consent status', async () => {
      globalThis.fetch = mockFetch(200, {
        agent_id: 'test-agent-001',
        consents: { iqs_scoring: true, data_sharing: false },
        last_updated: '2026-01-01',
        descriptions: { iqs_scoring: 'Allow IQS scoring' },
      });

      const result = await mb.consentStatus();
      expect(result.consents).toBeDefined();
    });

    it('grants consent', async () => {
      globalThis.fetch = mockFetch(200, {
        consent: {
          purpose: 'iqs_scoring',
          granted: true,
          granted_at: '2026-01-01',
        },
      });

      const result = await mb.grantConsent('iqs_scoring');
      expect(result.granted).toBe(true);
      expect(result.purpose).toBe('iqs_scoring');
    });

    it('withdraws consent', async () => {
      globalThis.fetch = mockFetch(200, {
        consent: {
          purpose: 'iqs_scoring',
          granted: false,
          withdrawn_at: '2026-01-01',
        },
      });

      const result = await mb.withdrawConsent('iqs_scoring');
      expect(result.granted).toBe(false);
    });
  });

  describe('payments', () => {
    it('gets balance', async () => {
      globalThis.fetch = mockFetch(200, {
        balance: {
          agent_id: 'test-agent-001',
          balance: 25.5,
          broker_tier: 'founding',
        },
      });

      const result = await mb.balance();
      expect(result.balance).toBe(25.5);
      expect(result.broker_tier).toBe('founding');
    });

    it('deposits funds', async () => {
      globalThis.fetch = mockFetch(200, {
        entry: {
          id: 'entry-001',
          type: 'credit',
          amount: 10.0,
          description: 'Deposit',
          timestamp: '2026-01-01',
        },
      });

      const result = await mb.deposit(10.0);
      expect(result.amount).toBe(10.0);
    });
  });

  describe('webhooks', () => {
    it('registers webhook', async () => {
      globalThis.fetch = mockFetch(200, {
        registration: {
          endpoint_url: 'https://example.com/webhook',
          event_types: ['introduction_request'],
          active: true,
        },
      });

      const result = await mb.registerWebhook(
        'https://example.com/webhook',
        ['introduction_request'],
      );
      expect(result.active).toBe(true);
    });

    it('lists webhooks', async () => {
      globalThis.fetch = mockFetch(200, {
        registrations: [
          { endpoint_url: 'https://a.com/wh', event_types: ['attestation_received'], active: true },
          { endpoint_url: 'https://b.com/wh', event_types: ['trust_score_changed'], active: false },
        ],
      });

      const result = await mb.listWebhooks();
      expect(result).toHaveLength(2);
    });

    it('unregisters webhook', async () => {
      globalThis.fetch = mockFetch(200, { removed: true });
      const result = await mb.unregisterWebhook('https://example.com/webhook');
      expect(result).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws AuthenticationError on 401', async () => {
      globalThis.fetch = mockFetch(401, {
        error: { code: 'UNAUTHORIZED', message: 'Invalid signature' },
      });

      await expect(mb.discoverBroker({ target: 'test' }))
        .rejects.toBeInstanceOf(AuthenticationError);
    });

    it('throws ValidationError on 400', async () => {
      globalThis.fetch = mockFetch(400, {
        error: { code: 'VALIDATION_ERROR', message: 'Missing field' },
      });

      await expect(mb.discoverBroker({ target: '' }))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it('throws NotFoundError on 404', async () => {
      globalThis.fetch = mockFetch(404, {
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      });

      await expect(mb.attest({ targetAgentId: 'none', attestationType: 'INTERACTION', confidence: 0.5 }))
        .rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws MoltBridgeError when no auth configured', async () => {
      const noAuth = new MoltBridge({ baseUrl: 'http://localhost:3040' });
      await expect(noAuth.discoverBroker({ target: 'test' }))
        .rejects.toThrow('Authentication required');
    });
  });

  describe('retry logic', () => {
    it('retries on network error', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ results: [], query_time_ms: 0, path_found: false }),
        });
      globalThis.fetch = fn;

      // Use discoverBroker which uses default retries (not health which forces retries=1)
      const fastMb = new MoltBridge({
        baseUrl: 'http://localhost:3040',
        agentId: 'test',
        signingKey: 'aa'.repeat(32),
        maxRetries: 2,
      });

      const result = await fastMb.discoverBroker({ target: 'test' });
      expect(result.path_found).toBe(false);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws after all retries exhausted', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      const fastMb = new MoltBridge({
        baseUrl: 'http://localhost:3040',
        agentId: 'test',
        signingKey: 'aa'.repeat(32),
        maxRetries: 1,
      });

      await expect(fastMb.health())
        .rejects.toThrow('Connection failed');
    });
  });

  describe('register()', () => {
    it('requires verification token', async () => {
      await expect(mb.register({
        agentId: 'test',
        name: 'Test',
        platform: 'custom',
        pubkey: 'abc',
        verificationToken: '',
      })).rejects.toThrow('verify()');
    });

    it('requires agentId', async () => {
      const noAuth = new MoltBridge({ baseUrl: 'http://localhost:3040' });
      await expect(noAuth.register({
        agentId: 'test',
        name: 'Test',
        platform: 'custom',
        pubkey: 'abc',
        verificationToken: 'tok',
      })).rejects.toThrow('no agentId');
    });
  });

  describe('verify()', () => {
    it('handles already-verified response', async () => {
      globalThis.fetch = mockFetch(200, { verified: true, token: 'already-verified-token' });

      const result = await mb.verify();
      expect(result.verified).toBe(true);
      expect(result.token).toBe('already-verified-token');
    });

    it('solves proof-of-work challenge', async () => {
      // First call returns challenge, second call verifies
      const fn = vi.fn()
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            challenge_id: 'ch-001',
            nonce: 'test-nonce-',
            difficulty: 1,
            target_prefix: '0', // Very easy — just need first char = '0'
            expires_at: '2026-12-31T23:59:59Z',
          }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            verified: true,
            token: 'verified-token-123',
          }),
        });
      globalThis.fetch = fn;

      const result = await mb.verify();
      expect(result.verified).toBe(true);
      expect(result.token).toBe('verified-token-123');
      expect(fn).toHaveBeenCalledTimes(2);

      // Second call should include proof_of_work
      const secondBody = JSON.parse(fn.mock.calls[1][1].body);
      expect(secondBody.challenge_id).toBe('ch-001');
      expect(secondBody.proof_of_work).toBeTruthy();
    });
  });

  describe('credibilityPacket()', () => {
    it('requests credibility packet', async () => {
      globalThis.fetch = mockFetch(200, {
        packet: 'jwt-token-here',
        expires_in: 3600,
        verify_url: 'https://api.moltbridge.com/verify-packet',
      });

      const result = await mb.credibilityPacket('target-001', 'broker-001');
      expect(result.packet).toBe('jwt-token-here');
      expect(result.expires_in).toBe(3600);
    });
  });

  describe('reportOutcome()', () => {
    it('reports introduction outcome', async () => {
      globalThis.fetch = mockFetch(200, { success: true });

      const result = await mb.reportOutcome('intro-001', 'successful');
      expect(result.success).toBe(true);
    });
  });

  describe('updateProfile()', () => {
    it('updates agent profile', async () => {
      globalThis.fetch = mockFetch(200, { updated: true });

      const result = await mb.updateProfile({
        capabilities: ['NLP', 'reasoning'],
        a2aEndpoint: 'https://my-agent.com/.well-known/agent.json',
      });
      expect(result.updated).toBe(true);
    });
  });
});
