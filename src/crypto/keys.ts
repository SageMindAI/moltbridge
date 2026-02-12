/**
 * Ed25519 Key Management
 *
 * Handles signing key loading, JWKS generation, and dev keypair auto-generation.
 * Phase 1: Keys stored in env vars. Production should use vault.
 */

import * as ed from '@noble/ed25519';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// noble/ed25519 v2 requires setting the SHA-512 hash
// Use Node's built-in crypto instead of @noble/hashes
ed.etc.sha512Sync = (...m) => {
  const h = crypto.createHash('sha512');
  for (const msg of m) h.update(msg);
  return new Uint8Array(h.digest());
};

interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

let signingKeyPair: KeyPair | null = null;

function base64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function base64urlDecode(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}

/**
 * Load or generate the MoltBridge signing keypair.
 * In dev: auto-generates and caches to a local file.
 * In prod: loads from MOLTBRIDGE_SIGNING_KEY env var.
 */
export function getSigningKeyPair(): KeyPair {
  if (signingKeyPair) return signingKeyPair;

  const envKey = process.env.MOLTBRIDGE_SIGNING_KEY;

  if (envKey) {
    const privateKey = base64urlDecode(envKey);
    const publicKey = ed.getPublicKey(privateKey);
    signingKeyPair = { privateKey, publicKey };
    return signingKeyPair;
  }

  // Dev mode: auto-generate and persist
  const devKeyPath = path.join(process.cwd(), '.dev-keys.json');

  if (fs.existsSync(devKeyPath)) {
    const stored = JSON.parse(fs.readFileSync(devKeyPath, 'utf-8'));
    const privateKey = base64urlDecode(stored.privateKey);
    const publicKey = base64urlDecode(stored.publicKey);
    signingKeyPair = { privateKey, publicKey };
    console.log('[Keys] Loaded dev signing keypair from .dev-keys.json');
    return signingKeyPair;
  }

  // Generate new keypair
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  signingKeyPair = { privateKey, publicKey };

  fs.writeFileSync(devKeyPath, JSON.stringify({
    privateKey: base64urlEncode(privateKey),
    publicKey: base64urlEncode(publicKey),
    generatedAt: new Date().toISOString(),
    note: 'Dev-only signing key. Do NOT use in production.',
  }, null, 2));

  console.log('[Keys] Generated new dev signing keypair → .dev-keys.json');
  return signingKeyPair;
}

/**
 * Sign data with the MoltBridge signing key.
 */
export function sign(message: Uint8Array): Uint8Array {
  const { privateKey } = getSigningKeyPair();
  return ed.sign(message, privateKey);
}

/**
 * Verify a signature against an arbitrary public key.
 */
export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  return ed.verify(signature, message, publicKey);
}

/**
 * Generate a Key ID (kid) as SHA256 thumbprint of the public key per RFC 7638.
 */
export function getKeyId(): string {
  const { publicKey } = getSigningKeyPair();
  // JWK thumbprint for OKP: {"crv":"Ed25519","kty":"OKP","x":"<base64url>"}
  const jwkThumbprintInput = `{"crv":"Ed25519","kty":"OKP","x":"${base64urlEncode(publicKey)}"}`;
  return crypto.createHash('sha256').update(jwkThumbprintInput).digest('base64url');
}

/**
 * Generate JWKS (JSON Web Key Set) for the /.well-known/jwks.json endpoint.
 */
export function getJWKS(): object {
  const { publicKey } = getSigningKeyPair();
  return {
    keys: [
      {
        kty: 'OKP',
        crv: 'Ed25519',
        x: base64urlEncode(publicKey),
        kid: getKeyId(),
        use: 'sig',
        alg: 'EdDSA',
      },
    ],
  };
}

/**
 * Get the public key as Base64url string.
 */
export function getPublicKeyBase64url(): string {
  const { publicKey } = getSigningKeyPair();
  return base64urlEncode(publicKey);
}

// Re-export utilities for external use
export { base64urlEncode, base64urlDecode };
