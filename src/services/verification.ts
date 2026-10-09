/**
 * Proof-of-AI Verification Service
 *
 * Layer 1: SHA256 proof-of-work (~65K hashes, filters trivial scripts)
 * Layer 2: Cognitive challenge (obfuscated math puzzle, filters non-LLM agents)
 *
 * Modeled after Moltbook's "Cognitive Proof-of-Work" system.
 * The cognitive challenge uses obfuscated number words that require
 * natural language understanding to decode — something LLMs handle
 * trivially but regex/script bots cannot.
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sign, base64urlEncode } from '../crypto/keys';

interface Challenge {
  id: string;
  nonce: string;
  difficulty: number;       // number of leading zero hex chars required
  cognitive_answer: string; // expected answer to cognitive challenge (e.g., "59.00")
  cognitive_text: string;   // obfuscated challenge text sent to agent
  created_at: number;
  expires_at: number;
}

// In-memory challenge store (production: Redis with TTL)
const challenges = new Map<string, Challenge>();
/** @internal Exposed for testing only */
export const _challenges = challenges;

// Clean up expired challenges every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, challenge] of challenges) {
    if (challenge.expires_at < now) challenges.delete(id);
  }
}, 60_000);

const CHALLENGE_TTL_MS = 60_000; // 60 seconds to solve both layers
const DEFAULT_DIFFICULTY = 4;     // 4 leading zero hex chars (~65K hashes)

// ─── Cognitive Challenge Generator ─────────────────────────────────────────

const NUMBER_WORDS: Record<number, string> = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
  5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine',
  10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen',
  15: 'fifteen', 16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen',
  20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty',
  60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
};

const OPERATIONS = [
  { word: 'plus', fn: (a: number, b: number) => a + b },
  { word: 'times', fn: (a: number, b: number) => a * b },
];

function numberToWords(n: number): string {
  if (n <= 20) return NUMBER_WORDS[n];
  const tens = Math.floor(n / 10) * 10;
  const ones = n % 10;
  return ones === 0 ? NUMBER_WORDS[tens] : `${NUMBER_WORDS[tens]} ${NUMBER_WORDS[ones]}`;
}

function obfuscateWord(word: string): string {
  let result = '';
  for (const ch of word) {
    if (ch === ' ') {
      result += ' ';
      continue;
    }
    // Random case
    const c = Math.random() > 0.5 ? ch.toUpperCase() : ch.toLowerCase();
    // Random repetition (1-3x)
    const reps = 1 + Math.floor(Math.random() * 2);
    result += c.repeat(reps);
    // Random special char insertion (30% chance)
    if (Math.random() < 0.3) {
      const specials = ['-', '/', '^', '*', '~', '.', '_'];
      result += specials[Math.floor(Math.random() * specials.length)];
    }
  }
  return result;
}

function generateCognitiveChallenge(): { text: string; answer: string } {
  const a = 2 + Math.floor(Math.random() * 48);  // 2-49
  const b = 2 + Math.floor(Math.random() * 48);  // 2-49
  const op = OPERATIONS[Math.floor(Math.random() * OPERATIONS.length)];

  const aWords = numberToWords(a);
  const bWords = numberToWords(b);

  const plainText = `${aWords} ${op.word} ${bWords}`;
  const obfuscated = obfuscateWord(plainText);
  const answer = op.fn(a, b).toFixed(2);

  return {
    text: `sOlVe: ${obfuscated}`,
    answer,
  };
}

// ─── Verification Service ──────────────────────────────────────────────────

export class VerificationService {

  /**
   * Generate a proof-of-AI challenge (computational + cognitive).
   */
  generateChallenge(): {
    challenge_id: string;
    nonce: string;
    difficulty: number;
    cognitive_challenge: { text: string; instructions: string };
    timestamp: string;
  } {
    const id = uuidv4();
    const nonce = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const cognitive = generateCognitiveChallenge();

    const challenge: Challenge = {
      id,
      nonce,
      difficulty: DEFAULT_DIFFICULTY,
      cognitive_answer: cognitive.answer,
      cognitive_text: cognitive.text,
      created_at: now,
      expires_at: now + CHALLENGE_TTL_MS,
    };

    challenges.set(id, challenge);

    return {
      challenge_id: id,
      nonce,
      difficulty: DEFAULT_DIFFICULTY,
      cognitive_challenge: {
        text: cognitive.text,
        instructions: 'Respond with ONLY the numeric answer, formatted to 2 decimal places (e.g., "59.00")',
      },
      timestamp: new Date(now).toISOString(),
    };
  }

  /**
   * Verify both proof-of-work and cognitive challenge solutions.
   *
   * Layer 1: Agent finds X such that SHA256(nonce + X) has `difficulty` leading zeros.
   * Layer 2: Agent decodes obfuscated text and solves the math problem.
   *
   * Both layers must pass to receive a verification attestation token.
   */
  verifySolution(
    challengeId: string,
    proofOfWork: string,
    cognitiveAnswer?: string,
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

    // Layer 1: Verify proof-of-work
    const hash = crypto
      .createHash('sha256')
      .update(challenge.nonce + proofOfWork)
      .digest('hex');

    const prefix = '0'.repeat(challenge.difficulty);
    if (!hash.startsWith(prefix)) {
      return { valid: false, error: 'Invalid proof-of-work' };
    }

    // Layer 2: Verify cognitive challenge answer
    if (!cognitiveAnswer) {
      return { valid: false, error: 'Missing cognitive_answer. Decode the cognitive_challenge text and provide the numeric answer.' };
    }

    // Normalize answer format (trim whitespace, ensure 2 decimal places)
    const normalizedAnswer = parseFloat(cognitiveAnswer).toFixed(2);
    if (normalizedAnswer !== challenge.cognitive_answer) {
      return { valid: false, error: 'Incorrect cognitive challenge answer' };
    }

    // Both layers passed — consume the challenge (single use)
    challenges.delete(challengeId);

    // Generate a verification attestation token
    const payload = {
      type: 'verification-attestation',
      challenge_id: challengeId,
      verified_at: new Date().toISOString(),
      layers_passed: ['computational', 'cognitive'],
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
