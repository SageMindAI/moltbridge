/**
 * MoltBridge SDK — Ed25519 Request Signing
 *
 * Signs every request with:
 *   Authorization: MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>
 *   Signature covers: method:path:timestamp:sha256(body)
 */

import { createHash, randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';

// noble/ed25519 v2 needs external SHA-512
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const hash = createHash('sha512');
  for (const m of msgs) hash.update(m);
  return new Uint8Array(hash.digest());
};

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Canonical JSON serialization with sorted keys at all levels.
 * Matches Python's json.dumps(obj, separators=(",", ":"), sort_keys=True).
 */
function canonicalStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return '{' + keys.map(k =>
      JSON.stringify(k) + ':' + canonicalStringify((obj as Record<string, unknown>)[k])
    ).join(',') + '}';
  }
  return JSON.stringify(obj);
}

export class Ed25519Signer {
  private readonly _seed: Uint8Array;
  private readonly _publicKey: Uint8Array;
  readonly agentId: string;

  constructor(seed: Uint8Array, agentId: string) {
    if (seed.length !== 32) {
      throw new Error('Ed25519 seed must be exactly 32 bytes');
    }
    this._seed = seed;
    this._publicKey = ed.getPublicKey(seed);
    this.agentId = agentId;
  }

  /** Create from a 32-byte hex-encoded seed. */
  static fromSeed(seedHex: string, agentId: string): Ed25519Signer {
    return new Ed25519Signer(fromHex(seedHex), agentId);
  }

  /** Create from raw 32-byte seed. */
  static fromBytes(seed: Uint8Array, agentId: string): Ed25519Signer {
    return new Ed25519Signer(seed, agentId);
  }

  /** Generate a new random keypair. */
  static generate(agentId: string): Ed25519Signer {
    const seed = randomBytes(32);
    return new Ed25519Signer(new Uint8Array(seed), agentId);
  }

  /** Public key as base64url string (for registration). */
  get publicKeyB64(): string {
    return toBase64Url(this._publicKey);
  }

  /** Private key seed as hex (for storage). */
  get seedHex(): string {
    return Buffer.from(this._seed).toString('hex');
  }

  /**
   * Sign a request and return the Authorization header value.
   *
   * @returns "MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>"
   */
  signRequest(method: string, path: string, body?: Record<string, unknown>): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const bodyStr = body ? canonicalStringify(body) : '';
    const bodyHash = createHash('sha256').update(bodyStr).digest('hex');

    const message = `${method}:${path}:${timestamp}:${bodyHash}`;
    const msgBytes = new TextEncoder().encode(message);
    const signature = ed.sign(msgBytes, this._seed);
    const sigB64 = toBase64Url(signature);

    return `MoltBridge-Ed25519 ${this.agentId}:${timestamp}:${sigB64}`;
  }
}
