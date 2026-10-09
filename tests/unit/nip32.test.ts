/**
 * Unit Tests: NIP-32 Label Serializer (src/services/nip32.ts)
 *
 * Tests conversion of MoltBridge attestations to Nostr NIP-32 kind 1985 events.
 * Community insight: INS-002 — Nostr NIP-32 labels for commerce-derived trust attestations.
 */

import { describe, it, expect } from 'vitest';
import {
  attestationToNIP32,
  attestationsToNIP32,
  MOLTBRIDGE_NIP32_NAMESPACE,
  type AttestationInput,
  type NIP32LabelEvent,
} from '../../src/services/nip32';

const baseInput: AttestationInput = {
  source_agent_id: 'dawn-001',
  source_pubkey: 'c291cmNlLXB1YmtleQ',
  target_agent_id: 'bro-agent-001',
  target_pubkey: 'dGFyZ2V0LXB1YmtleQ',
  attestation_type: 'CAPABILITY',
  capability_tag: 'escrow-management',
  confidence: 0.85,
  timestamp: '2026-02-25T12:00:00.000Z',
  valid_until: '2026-08-24T12:00:00.000Z',
  evidence_url: 'https://example.com/evidence/123',
  evidence_hash: 'sha256:abc123',
};

describe('NIP-32 Label Serializer', () => {
  describe('attestationToNIP32', () => {
    it('returns kind 1985 event', () => {
      const event = attestationToNIP32(baseInput);
      expect(event.kind).toBe(1985);
    });

    it('sets pubkey to source agent pubkey', () => {
      const event = attestationToNIP32(baseInput);
      expect(event.pubkey).toBe(baseInput.source_pubkey);
    });

    it('converts ISO timestamp to unix seconds', () => {
      const event = attestationToNIP32(baseInput);
      const expectedUnix = Math.floor(new Date('2026-02-25T12:00:00.000Z').getTime() / 1000);
      expect(event.created_at).toBe(expectedUnix);
    });

    it('includes namespace tag (L)', () => {
      const event = attestationToNIP32(baseInput);
      const lTag = event.tags.find((t) => t[0] === 'L');
      expect(lTag).toEqual(['L', MOLTBRIDGE_NIP32_NAMESPACE]);
    });

    it('includes label tag (l) with correct attestation type mapping', () => {
      const event = attestationToNIP32(baseInput);
      const lTags = event.tags.filter((t) => t[0] === 'l');
      const mainLabel = lTags.find((t) => t[1] === 'capability-verified');
      expect(mainLabel).toBeDefined();
      expect(mainLabel![2]).toBe(MOLTBRIDGE_NIP32_NAMESPACE);
    });

    it('includes metadata JSON in 4th position of label tag', () => {
      const event = attestationToNIP32(baseInput);
      const mainLabel = event.tags.find((t) => t[0] === 'l' && t[1] === 'capability-verified');
      expect(mainLabel).toBeDefined();
      const metadata = JSON.parse(mainLabel![3]);
      expect(metadata.confidence).toBe(0.85);
      expect(metadata.valid_until).toBe('2026-08-24T12:00:00.000Z');
      expect(metadata.evidence_url).toBe('https://example.com/evidence/123');
      expect(metadata.evidence_hash).toBe('sha256:abc123');
      expect(metadata.moltbridge_source_id).toBe('dawn-001');
    });

    it('includes target pubkey as p tag', () => {
      const event = attestationToNIP32(baseInput);
      const pTag = event.tags.find((t) => t[0] === 'p');
      expect(pTag).toEqual(['p', baseInput.target_pubkey]);
    });

    it('adds capability sub-label when capability_tag is present', () => {
      const event = attestationToNIP32(baseInput);
      const capLabel = event.tags.find(
        (t) => t[0] === 'l' && t[1] === 'capability:escrow-management'
      );
      expect(capLabel).toBeDefined();
      expect(capLabel![2]).toBe(MOLTBRIDGE_NIP32_NAMESPACE);
    });

    it('omits capability sub-label when no capability_tag', () => {
      const input = { ...baseInput, capability_tag: undefined };
      const event = attestationToNIP32(input);
      const capLabels = event.tags.filter((t) => t[0] === 'l' && t[1].startsWith('capability:'));
      expect(capLabels).toHaveLength(0);
    });

    it('builds human-readable content string', () => {
      const event = attestationToNIP32(baseInput);
      expect(event.content).toContain('MoltBridge CAPABILITY attestation');
      expect(event.content).toContain('Source: dawn-001');
      expect(event.content).toContain('Target: bro-agent-001');
      expect(event.content).toContain('Evidence: https://example.com/evidence/123');
    });

    it('omits evidence from content when not provided', () => {
      const input = { ...baseInput, evidence_url: undefined };
      const event = attestationToNIP32(input);
      expect(event.content).not.toContain('Evidence:');
    });

    it('maps IDENTITY attestation type correctly', () => {
      const input = { ...baseInput, attestation_type: 'IDENTITY' as const };
      const event = attestationToNIP32(input);
      const label = event.tags.find((t) => t[0] === 'l' && t[1] === 'identity-confirmed');
      expect(label).toBeDefined();
    });

    it('maps INTERACTION attestation type correctly', () => {
      const input = { ...baseInput, attestation_type: 'INTERACTION' as const };
      const event = attestationToNIP32(input);
      const label = event.tags.find((t) => t[0] === 'l' && t[1] === 'interaction-proven');
      expect(label).toBeDefined();
    });

    it('throws on unknown attestation type', () => {
      const input = { ...baseInput, attestation_type: 'UNKNOWN' as any };
      expect(() => attestationToNIP32(input)).toThrow('Unknown attestation type');
    });

    it('omits optional metadata fields when not provided', () => {
      const input: AttestationInput = {
        source_agent_id: 'dawn-001',
        source_pubkey: 'key1',
        target_agent_id: 'agent-002',
        target_pubkey: 'key2',
        attestation_type: 'CAPABILITY',
        confidence: 0.5,
        timestamp: '2026-01-01T00:00:00Z',
        valid_until: '',
      };
      const event = attestationToNIP32(input);
      const mainLabel = event.tags.find((t) => t[0] === 'l' && t[1] === 'capability-verified');
      const metadata = JSON.parse(mainLabel![3]);
      expect(metadata.confidence).toBe(0.5);
      expect(metadata).not.toHaveProperty('evidence_url');
      expect(metadata).not.toHaveProperty('evidence_hash');
    });
  });

  describe('attestationsToNIP32', () => {
    it('converts multiple attestations', () => {
      const inputs = [
        baseInput,
        { ...baseInput, attestation_type: 'IDENTITY' as const, target_agent_id: 'agent-003' },
      ];
      const events = attestationsToNIP32(inputs);
      expect(events).toHaveLength(2);
      expect(events[0].kind).toBe(1985);
      expect(events[1].kind).toBe(1985);
    });

    it('returns empty array for empty input', () => {
      expect(attestationsToNIP32([])).toEqual([]);
    });
  });
});
