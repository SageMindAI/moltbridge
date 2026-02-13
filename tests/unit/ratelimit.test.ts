/**
 * Unit Tests: Rate Limiting Middleware
 *
 * Tests token-bucket rate limiting, tiers, cleanup, and middleware.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../src/middleware/ratelimit';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe('check()', () => {
    it('allows first request', () => {
      const result = limiter.check('agent-1', 'standard');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
      expect(result.retryAfter).toBeNull();
    });

    it('decrements remaining tokens', () => {
      const first = limiter.check('agent-1', 'standard');
      const second = limiter.check('agent-1', 'standard');
      expect(second.remaining).toBe(first.remaining - 1);
    });

    it('rejects when tokens exhausted', () => {
      // Public tier has burst of 10
      for (let i = 0; i < 10; i++) {
        const result = limiter.check('agent-pub', 'public');
        expect(result.allowed).toBe(true);
      }

      const blocked = limiter.check('agent-pub', 'public');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfter).toBeGreaterThan(0);
    });

    it('isolates keys from each other', () => {
      // Exhaust agent-1's tokens
      for (let i = 0; i < 10; i++) {
        limiter.check('agent-1', 'public');
      }
      expect(limiter.check('agent-1', 'public').allowed).toBe(false);

      // agent-2 should still be fine
      expect(limiter.check('agent-2', 'public').allowed).toBe(true);
    });

    it('returns correct limit per tier', () => {
      expect(limiter.check('a', 'public').limit).toBe(60);
      expect(limiter.check('b', 'standard').limit).toBe(120);
      expect(limiter.check('c', 'founding').limit).toBe(300);
    });

    it('defaults to standard for unknown tier', () => {
      const result = limiter.check('agent-1', 'nonexistent');
      expect(result.limit).toBe(120);
    });

    it('founding tier has higher burst', () => {
      // Founding has burst of 50
      let lastResult;
      for (let i = 0; i < 50; i++) {
        lastResult = limiter.check('founder', 'founding');
        expect(lastResult.allowed).toBe(true);
      }

      const blocked = limiter.check('founder', 'founding');
      expect(blocked.allowed).toBe(false);
    });
  });

  describe('cleanup()', () => {
    it('removes expired buckets', () => {
      limiter.check('agent-1');
      limiter.check('agent-2');
      expect(limiter.size).toBe(2);

      // cleanup with very short max age should remove all
      const cleaned = limiter.cleanup(0);
      expect(cleaned).toBe(2);
      expect(limiter.size).toBe(0);
    });

    it('preserves recent buckets', () => {
      limiter.check('agent-1');
      limiter.check('agent-2');

      // cleanup with long max age should keep all
      const cleaned = limiter.cleanup(999_999_999);
      expect(cleaned).toBe(0);
      expect(limiter.size).toBe(2);
    });
  });
});
