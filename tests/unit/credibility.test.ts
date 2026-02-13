/**
 * Unit Tests: CredibilityService
 *
 * Tests JWT generation and verification for credibility packets.
 * Neo4j is mocked — these test the signing/verification flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as jose from 'jose';

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

import { CredibilityService } from '../../src/services/credibility';
import { getSigningKeyPair, base64urlEncode } from '../../src/crypto/keys';

describe('CredibilityService', () => {
  let service: CredibilityService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CredibilityService();
  });

  describe('generatePacket', () => {
    it('generates a valid signed JWT when graph data is found', async () => {
      // Mock Neo4j to return realistic data
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return 0.75;
              case 'requester_caps': return ['ai-research', 'nlp'];
              case 'broker_trust': return 0.85;
              case 'broker_caps': return ['ai-research', 'venture-capital'];
              case 'broker_clusters': return ['ai-founders', 'silicon-valley'];
              case 'attestation_count': return 5;
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('requester-001', 'target-001', 'broker-001');

      expect(typeof jwt).toBe('string');
      expect(jwt.split('.')).toHaveLength(3); // JWT has 3 parts

      // Decode without verification to check structure
      const decoded = jose.decodeJwt(jwt);
      expect(decoded.iss).toBe('moltbridge');
      expect(decoded.sub).toBe('credibility-packet');
      expect(decoded.aud).toBe('target-001');
      expect(decoded.jti).toBeDefined();
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
      expect((decoded as any).requester.agent_id).toBe('requester-001');
      expect((decoded as any).broker.agent_id).toBe('broker-001');
      expect((decoded as any).relevance.shared_interests).toContain('ai-research');
      expect((decoded as any).relevance.complementary_expertise).toContain('venture-capital');
      expect((decoded as any).attestation_count).toBe(5);
    });

    it('throws when requester or broker not found in graph', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [] });

      await expect(service.generatePacket('unknown', 'target', 'broker'))
        .rejects.toThrow('Requester or broker not found');
    });

    it('handles missing optional fields gracefully', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return null;
              case 'requester_caps': return null;
              case 'broker_trust': return null;
              case 'broker_caps': return null;
              case 'broker_clusters': return null;
              case 'attestation_count': return null;
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('req', 'target', 'broker');
      const decoded = jose.decodeJwt(jwt);
      expect((decoded as any).requester.trust_score).toBe(0);
      expect((decoded as any).relevance.shared_interests).toEqual([]);
      expect((decoded as any).attestation_count).toBe(0);
    });

    it('handles Neo4j integer objects for attestation_count', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return 0.5;
              case 'requester_caps': return [];
              case 'broker_trust': return 0.5;
              case 'broker_caps': return [];
              case 'broker_clusters': return [];
              case 'attestation_count': return { toNumber: () => 42 }; // Neo4j Integer object
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('req', 'target', 'broker');
      const decoded = jose.decodeJwt(jwt);
      expect((decoded as any).attestation_count).toBe(42);
    });

    it('closes the session even when an error occurs', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('Neo4j timeout'));

      await expect(service.generatePacket('req', 'target', 'broker'))
        .rejects.toThrow('Neo4j timeout');
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('verifyPacket', () => {
    it('verifies a packet generated by generatePacket (round-trip)', async () => {
      // Generate a packet first
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return 0.8;
              case 'requester_caps': return ['ai'];
              case 'broker_trust': return 0.9;
              case 'broker_caps': return ['ai', 'robotics'];
              case 'broker_clusters': return ['tech'];
              case 'attestation_count': return 3;
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('req-001', 'target-001', 'broker-001');

      // Now verify it
      const payload = await service.verifyPacket(jwt);
      expect(payload.iss).toBe('moltbridge');
      expect(payload.requester.agent_id).toBe('req-001');
      expect(payload.broker.agent_id).toBe('broker-001');
    });

    it('rejects a tampered JWT', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return 0.5;
              case 'requester_caps': return [];
              case 'broker_trust': return 0.5;
              case 'broker_caps': return [];
              case 'broker_clusters': return [];
              case 'attestation_count': return 0;
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('req', 'target', 'broker');

      // Tamper with the payload
      const parts = jwt.split('.');
      const tampered = parts[0] + '.' + parts[1] + 'TAMPERED.' + parts[2];

      await expect(service.verifyPacket(tampered)).rejects.toThrow();
    });

    it('rejects an expired JWT', async () => {
      // Create a manually crafted expired JWT
      const { privateKey, publicKey } = getSigningKeyPair();
      const privateKeyObj = await jose.importJWK({
        kty: 'OKP',
        crv: 'Ed25519',
        d: base64urlEncode(privateKey),
        x: base64urlEncode(publicKey),
      }, 'EdDSA');

      const expiredJwt = await new jose.SignJWT({
        iss: 'moltbridge',
        sub: 'credibility-packet',
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(privateKeyObj);

      await expect(service.verifyPacket(expiredJwt)).rejects.toThrow();
    });
  });

  describe('packet structure', () => {
    it('sets TTL to 30 days from issuance', async () => {
      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return 0.5;
              case 'requester_caps': return [];
              case 'broker_trust': return 0.5;
              case 'broker_caps': return [];
              case 'broker_clusters': return [];
              case 'attestation_count': return 0;
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('req', 'target', 'broker');
      const decoded = jose.decodeJwt(jwt);

      const ttlDays = ((decoded.exp as number) - (decoded.iat as number)) / (24 * 60 * 60);
      expect(ttlDays).toBe(30);
    });

    it('limits cluster and capability arrays to reasonable sizes', async () => {
      const manyCaps = Array.from({ length: 20 }, (_, i) => `cap-${i}`);
      const manyClusters = Array.from({ length: 10 }, (_, i) => `cluster-${i}`);

      mockSession.run.mockResolvedValueOnce({
        records: [{
          get: (key: string) => {
            switch (key) {
              case 'requester_trust': return 0.5;
              case 'requester_caps': return manyCaps;
              case 'broker_trust': return 0.5;
              case 'broker_caps': return manyCaps.slice(5); // Overlap on 5-19
              case 'broker_clusters': return manyClusters;
              case 'attestation_count': return 0;
              default: return null;
            }
          },
        }],
      });

      const jwt = await service.generatePacket('req', 'target', 'broker');
      const decoded = jose.decodeJwt(jwt);

      // shared_interests limited to 5
      expect((decoded as any).relevance.shared_interests.length).toBeLessThanOrEqual(5);
      // complementary limited to 5
      expect((decoded as any).relevance.complementary_expertise.length).toBeLessThanOrEqual(5);
      // clusters limited to 3
      expect((decoded as any).path_summary.via_clusters.length).toBeLessThanOrEqual(3);
    });
  });
});
