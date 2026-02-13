/**
 * Tests for Ed25519 request signing.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { Ed25519Signer } from '../src/auth.js';

// Setup SHA-512 for noble
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const hash = createHash('sha512');
  for (const m of msgs) hash.update(m);
  return new Uint8Array(hash.digest());
};

describe('Ed25519Signer', () => {
  describe('generate()', () => {
    it('creates a valid keypair', () => {
      const signer = Ed25519Signer.generate('test-agent');
      expect(signer.agentId).toBe('test-agent');
      expect(signer.publicKeyB64.length).toBeGreaterThan(0);
      expect(signer.seedHex.length).toBe(64); // 32 bytes as hex
    });
  });

  describe('fromSeed()', () => {
    it('roundtrips seed to same public key', () => {
      const original = Ed25519Signer.generate('test-agent');
      const seed = original.seedHex;
      const restored = Ed25519Signer.fromSeed(seed, 'test-agent');
      expect(restored.publicKeyB64).toBe(original.publicKeyB64);
    });

    it('rejects invalid seed length', () => {
      expect(() => Ed25519Signer.fromSeed('abcd', 'agent')).toThrow('32 bytes');
    });
  });

  describe('fromBytes()', () => {
    it('creates signer from raw bytes', () => {
      const seed = new Uint8Array(32);
      seed.fill(0xaa);
      const signer = Ed25519Signer.fromBytes(seed, 'agent-bytes');
      expect(signer.agentId).toBe('agent-bytes');
      expect(signer.seedHex).toBe('aa'.repeat(32));
    });
  });

  describe('signRequest()', () => {
    it('produces correct header format', () => {
      const signer = Ed25519Signer.generate('agent-001');
      const header = signer.signRequest('POST', '/discover-broker', { target: 'test' });

      expect(header).toMatch(/^MoltBridge-Ed25519 /);
      const parts = header.split(' ', 2)[1].split(':');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('agent-001');
      expect(Number(parts[1])).toBeGreaterThan(0); // timestamp
      expect(parts[2].length).toBeGreaterThan(0); // signature
    });

    it('signature is verifiable', () => {
      const signer = Ed25519Signer.generate('agent-001');
      const body = { target: 'peter-d' };

      const header = signer.signRequest('POST', '/discover-broker', body);
      const parts = header.split(' ', 2)[1].split(':');
      const timestamp = parts[1];
      const sigB64 = parts[2];

      // Reconstruct message
      const bodyStr = JSON.stringify(body, Object.keys(body).sort());
      const bodyHash = createHash('sha256').update(bodyStr).digest('hex');
      const message = `POST:/discover-broker:${timestamp}:${bodyHash}`;

      // Verify with public key
      const sigBytes = Buffer.from(sigB64, 'base64url');
      const pubBytes = Buffer.from(signer.publicKeyB64, 'base64url');
      const msgBytes = new TextEncoder().encode(message);

      const valid = ed.verify(sigBytes, msgBytes, pubBytes);
      expect(valid).toBe(true);
    });

    it('different bodies produce different signatures', () => {
      const signer = Ed25519Signer.generate('agent-001');

      const header1 = signer.signRequest('POST', '/test', { a: 1 });
      const header2 = signer.signRequest('POST', '/test', { b: 2 });

      const sig1 = header1.split(':').pop();
      const sig2 = header2.split(':').pop();
      expect(sig1).not.toBe(sig2);
    });

    it('handles empty body (GET requests)', () => {
      const signer = Ed25519Signer.generate('agent-001');
      const header = signer.signRequest('GET', '/health');
      expect(header).toContain('agent-001');
    });

    it('different methods produce different signatures', () => {
      const signer = Ed25519Signer.generate('agent-001');
      const body = { test: true };

      const header1 = signer.signRequest('GET', '/test', body);
      const header2 = signer.signRequest('POST', '/test', body);

      const sig1 = header1.split(':').pop();
      const sig2 = header2.split(':').pop();
      expect(sig1).not.toBe(sig2);
    });

    it('different paths produce different signatures', () => {
      const signer = Ed25519Signer.generate('agent-001');
      const body = { test: true };

      const header1 = signer.signRequest('POST', '/path-a', body);
      const header2 = signer.signRequest('POST', '/path-b', body);

      const sig1 = header1.split(':').pop();
      const sig2 = header2.split(':').pop();
      expect(sig1).not.toBe(sig2);
    });
  });
});
