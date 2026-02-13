/**
 * Crypto test helpers
 *
 * Utilities for generating keypairs, signing requests, etc. in tests.
 */

import * as ed from '@noble/ed25519';
import * as crypto from 'crypto';

// noble/ed25519 v2 requires setting the SHA-512 hash
ed.etc.sha512Sync = (...m: Uint8Array[]) => {
  const h = crypto.createHash('sha512');
  for (const msg of m) h.update(msg);
  return new Uint8Array(h.digest());
};

export interface TestKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyB64: string;
}

/**
 * Generate a test Ed25519 keypair
 */
export function generateTestKeyPair(): TestKeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64url'),
  };
}

/**
 * Sign a request for the MoltBridge auth scheme.
 * Returns the full Authorization header value.
 */
// Counter to offset timestamps and avoid replay detection in tests.
// Stays within ±30s of real time (well within the 60s freshness window).
let _tsOffset = 0;

export function signRequest(
  keyPair: TestKeyPair,
  agentId: string,
  method: string,
  path: string,
  body?: object,
): string {
  // Each call gets a unique timestamp to prevent replay detection.
  // Offset wraps at ±25 to stay within the 60s freshness window.
  const offset = (_tsOffset++) % 50 - 25;
  const timestamp = Math.floor(Date.now() / 1000) + offset;
  const bodyStr = body ? JSON.stringify(body) : '';
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const message = `${method}:${path}:${timestamp}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = ed.sign(messageBytes, keyPair.privateKey);
  const signatureB64 = Buffer.from(signature).toString('base64url');
  return `MoltBridge-Ed25519 ${agentId}:${timestamp}:${signatureB64}`;
}

/**
 * Solve a proof-of-work challenge (for verification tests)
 */
export function solveChallenge(nonce: string, difficulty: number): string {
  const prefix = '0'.repeat(difficulty);
  for (let i = 0; i < 10_000_000; i++) {
    const candidate = i.toString();
    const hash = crypto
      .createHash('sha256')
      .update(nonce + candidate)
      .digest('hex');
    if (hash.startsWith(prefix)) {
      return candidate;
    }
  }
  throw new Error(`Could not solve challenge with difficulty ${difficulty}`);
}
