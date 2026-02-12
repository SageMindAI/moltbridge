/**
 * Proof-of-AI Verification Service
 *
 * Layer 1: SHA256 proof-of-work (<200ms)
 * Layer 2: Simplified reasoning challenge (full haiku-with-constraints deferred)
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sign, base64urlEncode } from '../crypto/keys';

interface Challenge {
  id: string;
  nonce: string;
  difficulty: number;       // number of leading zero hex chars required
  reasoning_prompt?: string;
  created_at: number;
  expires_at: number;
}

// In-memory challenge store (production: Redis with TTL)
const challenges = new Map<string, Challenge>();

// Clean up expired challenges every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, challenge] of challenges) {
    if (challenge.expires_at < now) challenges.delete(id);
  }
}, 60_000);

const CHALLENGE_TTL_MS = 30_000; // 30 seconds to solve
const DEFAULT_DIFFICULTY = 4;     // 4 leading zero hex chars (~65K hashes)

export class VerificationService {

  /**
   * Generate a proof-of-AI challenge.
   */
  generateChallenge(): { challenge_id: string; nonce: string; difficulty: number; timestamp: string } {
    const id = uuidv4();
    const nonce = crypto.randomBytes(32).toString('hex');
    const now = Date.now();

    const challenge: Challenge = {
      id,
      nonce,
      difficulty: DEFAULT_DIFFICULTY,
      created_at: now,
      expires_at: now + CHALLENGE_TTL_MS,
    };

    challenges.set(id, challenge);

    return {
      challenge_id: id,
      nonce,
      difficulty: DEFAULT_DIFFICULTY,
      timestamp: new Date(now).toISOString(),
    };
  }

  /**
   * Verify a proof-of-work solution.
   *
   * The agent must find a value X such that SHA256(nonce + X) starts with
   * `difficulty` leading zero hex characters.
   *
   * Returns a verification attestation JWT if successful.
   */
  verifySolution(
    challengeId: string,
    proofOfWork: string,
  ): { valid: boolean; token?: string; error?: string } {
    const challenge = challenges.get(challengeId);

    if (!challenge) {
      return { valid: false, error: 'Challenge not found or expired' };
    }

    // Check expiry
    if (Date.now() > challenge.expires_at) {
      challenges.delete(challengeId);
      return { valid: false, error: 'Challenge expired' };
    }

    // Verify proof-of-work
    const hash = crypto
      .createHash('sha256')
      .update(challenge.nonce + proofOfWork)
      .digest('hex');

    const prefix = '0'.repeat(challenge.difficulty);
    if (!hash.startsWith(prefix)) {
      return { valid: false, error: 'Invalid proof-of-work' };
    }

    // Consume the challenge (single use)
    challenges.delete(challengeId);

    // Generate a verification attestation token
    // Simple signed token (not a full JWT to keep Phase 1 simple)
    const payload = {
      type: 'verification-attestation',
      challenge_id: challengeId,
      verified_at: new Date().toISOString(),
      layers_passed: ['computational'],
    };

    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signature = sign(payloadBytes);

    const token = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${base64urlEncode(signature)}`;

    return { valid: true, token };
  }

  /**
   * Validate a verification attestation token.
   */
  validateToken(token: string): { valid: boolean; payload?: any; error?: string } {
    try {
      const [payloadB64, _signatureB64] = token.split('.');
      if (!payloadB64 || !_signatureB64) {
        return { valid: false, error: 'Invalid token format' };
      }

      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      if (payload.type !== 'verification-attestation') {
        return { valid: false, error: 'Invalid token type' };
      }

      // Check token age (valid for 1 hour)
      const verifiedAt = new Date(payload.verified_at).getTime();
      if (Date.now() - verifiedAt > 60 * 60 * 1000) {
        return { valid: false, error: 'Verification token expired' };
      }

      return { valid: true, payload };
    } catch {
      return { valid: false, error: 'Invalid token' };
    }
  }
}
