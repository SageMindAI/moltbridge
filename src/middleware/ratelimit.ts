/**
 * Rate Limiting Middleware
 *
 * Token-bucket rate limiting per agent, with different tiers.
 * Phase 1: In-memory. Production: Redis.
 */

import { Request, Response, NextFunction } from 'express';

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimitConfig {
  /** Requests per window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Maximum burst size */
  burst: number;
}

// Rate limit tiers
const TIERS: Record<string, RateLimitConfig> = {
  // Unauthenticated endpoints (health, verify, JWKS)
  public: {
    limit: 60,
    windowMs: 60_000,
    burst: 10,
  },
  // Authenticated agents — standard
  standard: {
    limit: 120,
    windowMs: 60_000,
    burst: 20,
  },
  // Founding agents
  founding: {
    limit: 300,
    windowMs: 60_000,
    burst: 50,
  },
};

export class RateLimiter {
  private buckets: Map<string, RateBucket> = new Map();

  /**
   * Check and consume a token for the given key.
   * Returns { allowed, remaining, retryAfter }.
   */
  check(key: string, tier: string = 'standard'): {
    allowed: boolean;
    remaining: number;
    retryAfter: number | null;
    limit: number;
  } {
    const config = TIERS[tier] ?? TIERS.standard;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: config.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor((elapsed / config.windowMs) * config.limit);
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(config.burst, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return {
        allowed: true,
        remaining: bucket.tokens,
        retryAfter: null,
        limit: config.limit,
      };
    }

    // Calculate retry-after
    const msUntilRefill = config.windowMs - elapsed;
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(msUntilRefill / 1000),
      limit: config.limit,
    };
  }

  /**
   * Clean up expired buckets (call periodically).
   */
  cleanup(maxAgeMs: number = 300_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill >= maxAgeMs) {
        this.buckets.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Get bucket count (for monitoring). */
  get size(): number {
    return this.buckets.size;
  }

  /** Reset all buckets (for testing). */
  reset(): void {
    this.buckets.clear();
  }
}

// Singleton instance
const limiter = new RateLimiter();

/**
 * Express middleware factory for rate limiting.
 */
export function rateLimit(tier: string = 'standard') {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Auth middleware stores agent_id at req.auth.agent_id
    const agentId = (req as any).auth?.agent_id as string | undefined;
    const key = agentId ?? req.ip ?? 'unknown';
    const effectiveTier = agentId ? tier : 'public';

    const result = limiter.check(key, effectiveTier);

    // Set rate limit headers
    res.set('X-RateLimit-Limit', result.limit.toString());
    res.set('X-RateLimit-Remaining', result.remaining.toString());

    if (!result.allowed) {
      res.set('Retry-After', result.retryAfter!.toString());
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please retry after the specified time.',
          status: 429,
        },
        retry_after: result.retryAfter,
      });
      return;
    }

    next();
  };
}

export { limiter };
