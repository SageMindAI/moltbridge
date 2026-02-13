/**
 * Unit Tests: Crypto/Keys (src/crypto/keys.ts)
 *
 * Tests Ed25519 key management, signing, verification, JWKS generation.
 * Coverage target: 100% (security-critical)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// We need to test the module with controlled env vars
// Reset module state between tests
let keys: typeof import('../../src/crypto/keys');

describe('crypto/keys', () => {
  const originalEnv = process.env.MOLTBRIDGE_SIGNING_KEY;
  const devKeyPath = path.join(process.cwd(), '.dev-keys.json');
  let devKeysExisted: boolean;

  beforeEach(async () => {
    // Track if .dev-keys.json existed before test
    devKeysExisted = fs.existsSync(devKeyPath);

    // Clear module cache to reset signingKeyPair singleton
    vi.resetModules();
    delete process.env.MOLTBRIDGE_SIGNING_KEY;

    // Re-import fresh module
    keys = await import('../../src/crypto/keys');
  });

  afterEach(() => {
    // Restore env
    if (originalEnv) {
      process.env.MOLTBRIDGE_SIGNING_KEY = originalEnv;
    } else {
      delete process.env.MOLTBRIDGE_SIGNING_KEY;
    }
  });

  describe('getSigningKeyPair()', () => {
    it('returns a keypair with privateKey and publicKey', () => {
      const kp = keys.getSigningKeyPair();
      expect(kp).toHaveProperty('privateKey');
      expect(kp).toHaveProperty('publicKey');
      expect(kp.privateKey).toBeInstanceOf(Uint8Array);
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    });

    it('returns consistent keypair on repeated calls (singleton)', () => {
      const kp1 = keys.getSigningKeyPair();
      const kp2 = keys.getSigningKeyPair();
      expect(kp1).toBe(kp2); // same reference
    });

    it('loads from MOLTBRIDGE_SIGNING_KEY env var when set', async () => {
      // Generate a known key
      const { utils, getPublicKey } = await import('@noble/ed25519');
      const privKey = utils.randomPrivateKey();
      const privKeyB64 = Buffer.from(privKey).toString('base64url');

      process.env.MOLTBRIDGE_SIGNING_KEY = privKeyB64;
      vi.resetModules();
      const freshKeys = await import('../../src/crypto/keys');

      const kp = freshKeys.getSigningKeyPair();
      expect(Buffer.from(kp.privateKey).toString('base64url')).toBe(privKeyB64);
    });
  });

  describe('sign() and verify()', () => {
    it('produces a verifiable signature', () => {
      const message = new TextEncoder().encode('test message');
      const kp = keys.getSigningKeyPair();
      const sig = keys.sign(message);

      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBe(64); // Ed25519 signature is 64 bytes

      const valid = keys.verify(sig, message, kp.publicKey);
      expect(valid).toBe(true);
    });

    it('rejects tampered payload', () => {
      const message = new TextEncoder().encode('original message');
      const kp = keys.getSigningKeyPair();
      const sig = keys.sign(message);

      const tampered = new TextEncoder().encode('tampered message');
      const valid = keys.verify(sig, tampered, kp.publicKey);
      expect(valid).toBe(false);
    });

    it('rejects wrong public key', async () => {
      const message = new TextEncoder().encode('test message');
      const sig = keys.sign(message);

      // Generate a different keypair
      const { utils, getPublicKey } = await import('@noble/ed25519');
      const wrongPriv = utils.randomPrivateKey();
      const wrongPub = getPublicKey(wrongPriv);

      const valid = keys.verify(sig, message, wrongPub);
      expect(valid).toBe(false);
    });
  });

  describe('getJWKS()', () => {
    it('returns valid JWKS structure', () => {
      const jwks = keys.getJWKS() as any;

      expect(jwks).toHaveProperty('keys');
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect(jwks.keys.length).toBe(1);

      const key = jwks.keys[0];
      expect(key.kty).toBe('OKP');
      expect(key.crv).toBe('Ed25519');
      expect(key.use).toBe('sig');
      expect(key.alg).toBe('EdDSA');
      expect(key).toHaveProperty('x');
      expect(key).toHaveProperty('kid');
    });

    it('x field is base64url encoded public key', () => {
      const kp = keys.getSigningKeyPair();
      const jwks = keys.getJWKS() as any;
      const expectedX = Buffer.from(kp.publicKey).toString('base64url');
      expect(jwks.keys[0].x).toBe(expectedX);
    });
  });

  describe('getKeyId()', () => {
    it('returns a SHA256 thumbprint string', () => {
      const kid = keys.getKeyId();
      expect(typeof kid).toBe('string');
      expect(kid.length).toBeGreaterThan(0);
    });

    it('is deterministic (same key = same kid)', () => {
      const kid1 = keys.getKeyId();
      const kid2 = keys.getKeyId();
      expect(kid1).toBe(kid2);
    });
  });

  describe('getPublicKeyBase64url()', () => {
    it('returns base64url encoded public key', () => {
      const pubB64 = keys.getPublicKeyBase64url();
      expect(typeof pubB64).toBe('string');

      // Decode and verify it matches
      const decoded = Buffer.from(pubB64, 'base64url');
      expect(decoded.length).toBe(32); // Ed25519 public key is 32 bytes
    });
  });

  describe('dev keypair generation', () => {
    it('generates and persists .dev-keys.json when no env var and no file', async () => {
      // Remove env var
      delete process.env.MOLTBRIDGE_SIGNING_KEY;

      // Mock fs to simulate no .dev-keys.json existing
      vi.resetModules();

      // Spy on fs to track file operations without actually touching the filesystem
      const mockExistsSync = vi.fn().mockReturnValue(false);
      const mockWriteFileSync = vi.fn();
      const mockReadFileSync = vi.fn();

      vi.doMock('fs', () => ({
        ...fs,
        existsSync: mockExistsSync,
        writeFileSync: mockWriteFileSync,
        readFileSync: mockReadFileSync,
      }));

      const freshKeys = await import('../../src/crypto/keys');
      const kp = freshKeys.getSigningKeyPair();

      // Should have generated a keypair
      expect(kp.privateKey).toBeInstanceOf(Uint8Array);
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.privateKey.length).toBe(32);
      expect(kp.publicKey.length).toBe(32);

      // Should have written to .dev-keys.json
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenPath = mockWriteFileSync.mock.calls[0][0];
      expect(writtenPath).toContain('.dev-keys.json');

      // Verify the written content is valid JSON with expected fields
      const writtenContent = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(writtenContent).toHaveProperty('privateKey');
      expect(writtenContent).toHaveProperty('publicKey');
      expect(writtenContent).toHaveProperty('generatedAt');
      expect(writtenContent).toHaveProperty('note');
    });

    it('loads existing .dev-keys.json when present', async () => {
      delete process.env.MOLTBRIDGE_SIGNING_KEY;

      vi.resetModules();

      // Generate a known keypair to store
      const { utils, getPublicKey } = await import('@noble/ed25519');
      const knownPriv = utils.randomPrivateKey();
      const knownPub = getPublicKey(knownPriv);
      const storedData = JSON.stringify({
        privateKey: Buffer.from(knownPriv).toString('base64url'),
        publicKey: Buffer.from(knownPub).toString('base64url'),
      });

      vi.doMock('fs', () => ({
        ...fs,
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue(storedData),
        writeFileSync: vi.fn(),
      }));

      const freshKeys = await import('../../src/crypto/keys');
      const kp = freshKeys.getSigningKeyPair();

      expect(Buffer.from(kp.privateKey).toString('base64url'))
        .toBe(Buffer.from(knownPriv).toString('base64url'));
    });
  });

  describe('base64urlEncode/base64urlDecode', () => {
    it('round-trips correctly', () => {
      const original = crypto.randomBytes(32);
      const encoded = keys.base64urlEncode(new Uint8Array(original));
      const decoded = keys.base64urlDecode(encoded);
      expect(Buffer.from(decoded)).toEqual(original);
    });
  });
});
