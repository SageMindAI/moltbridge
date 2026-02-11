/**
 * Input Validation Middleware
 *
 * Regex allowlist for user-provided strings.
 * Body size limits. Capability tag validation.
 */

import { Request, Response, NextFunction } from 'express';
import { Errors } from './errors';

// Safe string pattern: alphanumeric, spaces, hyphens, underscores, dots
const SAFE_STRING_PATTERN = /^[a-zA-Z0-9\s\-_.]{1,200}$/;

// Agent ID pattern: alphanumeric, hyphens, underscores (no spaces)
const AGENT_ID_PATTERN = /^[a-zA-Z0-9\-_]{1,100}$/;

// Capability tag pattern: lowercase, hyphens only
const CAPABILITY_TAG_PATTERN = /^[a-z0-9\-]{1,50}$/;

/**
 * Validate a string against the safe pattern.
 */
export function isSafeString(value: string): boolean {
  return SAFE_STRING_PATTERN.test(value);
}

/**
 * Validate an agent ID.
 */
export function isValidAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}

/**
 * Validate a capability tag.
 */
export function isValidCapabilityTag(value: string): boolean {
  return CAPABILITY_TAG_PATTERN.test(value);
}

/**
 * Validate an array of capability tags.
 */
export function validateCapabilities(capabilities: unknown): string[] | null {
  if (!Array.isArray(capabilities)) return null;
  if (capabilities.length > 20) return null;

  for (const tag of capabilities) {
    if (typeof tag !== 'string' || !isValidCapabilityTag(tag)) {
      return null;
    }
  }

  return capabilities as string[];
}

/**
 * Body size limit middleware.
 * Express json() already has a default 100kb limit, but we enforce a tighter one.
 */
export function bodySizeLimit(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxBytes) {
      throw Errors.validationError(`Request body too large (max ${maxBytes} bytes)`);
    }
    next();
  };
}

/**
 * Validate required fields in request body.
 */
export function requireFields(...fields: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const field of fields) {
      if (req.body[field] === undefined || req.body[field] === null) {
        throw Errors.validationError(`Missing required field: ${field}`);
      }
    }
    next();
  };
}
