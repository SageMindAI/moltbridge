/**
 * Unit Tests: Validation Middleware (src/middleware/validate.ts)
 *
 * Tests input validation patterns for security.
 * Coverage target: 100% (security boundary)
 */

import { describe, it, expect } from 'vitest';
import {
  isSafeString,
  isValidAgentId,
  isValidCapabilityTag,
  validateCapabilities,
} from '../../src/middleware/validate';

describe('Validation', () => {
  describe('isSafeString()', () => {
    it('accepts valid alphanumeric strings', () => {
      expect(isSafeString('hello')).toBe(true);
      expect(isSafeString('Hello World')).toBe(true);
      expect(isSafeString('test-123')).toBe(true);
      expect(isSafeString('foo_bar')).toBe(true);
      expect(isSafeString('v1.2.3')).toBe(true);
    });

    it('rejects injection attempts', () => {
      expect(isSafeString('<script>alert(1)</script>')).toBe(false);
      expect(isSafeString("'; DROP TABLE agents;--")).toBe(false);
      expect(isSafeString('${jndi:ldap://evil}')).toBe(false);
      expect(isSafeString('../../etc/passwd')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isSafeString('')).toBe(false);
    });

    it('rejects strings > 200 chars', () => {
      const long = 'a'.repeat(201);
      expect(isSafeString(long)).toBe(false);
    });

    it('accepts strings exactly 200 chars', () => {
      const exact = 'a'.repeat(200);
      expect(isSafeString(exact)).toBe(true);
    });

    it('rejects special characters', () => {
      expect(isSafeString('hello@world')).toBe(false);
      expect(isSafeString('test#123')).toBe(false);
      expect(isSafeString('foo&bar')).toBe(false);
      expect(isSafeString('a(b)')).toBe(false);
    });
  });

  describe('isValidAgentId()', () => {
    it('accepts valid agent IDs', () => {
      expect(isValidAgentId('agent-123')).toBe(true);
      expect(isValidAgentId('dawn_001')).toBe(true);
      expect(isValidAgentId('BridgeBot')).toBe(true);
      expect(isValidAgentId('a')).toBe(true);
      expect(isValidAgentId('test123')).toBe(true);
    });

    it('rejects path traversal attempts', () => {
      expect(isValidAgentId('../path/traversal')).toBe(false);
      expect(isValidAgentId('../../etc/passwd')).toBe(false);
      expect(isValidAgentId('/etc/passwd')).toBe(false);
    });

    it('rejects spaces', () => {
      expect(isValidAgentId('agent 123')).toBe(false);
      expect(isValidAgentId(' leading')).toBe(false);
    });

    it('rejects injection characters', () => {
      expect(isValidAgentId("'; DELETE n;")).toBe(false);
      expect(isValidAgentId('<script>')).toBe(false);
      expect(isValidAgentId('agent@evil')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidAgentId('')).toBe(false);
    });

    it('rejects strings > 100 chars', () => {
      const long = 'a'.repeat(101);
      expect(isValidAgentId(long)).toBe(false);
    });

    it('accepts strings exactly 100 chars', () => {
      const exact = 'a'.repeat(100);
      expect(isValidAgentId(exact)).toBe(true);
    });
  });

  describe('isValidCapabilityTag()', () => {
    it('accepts valid capability tags', () => {
      expect(isValidCapabilityTag('ai-research')).toBe(true);
      expect(isValidCapabilityTag('web3')).toBe(true);
      expect(isValidCapabilityTag('data-analysis')).toBe(true);
      expect(isValidCapabilityTag('nlp')).toBe(true);
    });

    it('rejects uppercase', () => {
      expect(isValidCapabilityTag('AI-Research')).toBe(false);
      expect(isValidCapabilityTag('NLP')).toBe(false);
    });

    it('rejects XSS attempts', () => {
      expect(isValidCapabilityTag('<script>')).toBe(false);
      expect(isValidCapabilityTag('on click')).toBe(false);
    });

    it('rejects spaces', () => {
      expect(isValidCapabilityTag('ai research')).toBe(false);
    });

    it('rejects underscores', () => {
      expect(isValidCapabilityTag('ai_research')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidCapabilityTag('')).toBe(false);
    });

    it('rejects strings > 50 chars', () => {
      const long = 'a'.repeat(51);
      expect(isValidCapabilityTag(long)).toBe(false);
    });
  });

  describe('validateCapabilities()', () => {
    it('accepts valid capability array', () => {
      const result = validateCapabilities(['ai-research', 'web3', 'nlp']);
      expect(result).toEqual(['ai-research', 'web3', 'nlp']);
    });

    it('accepts empty array', () => {
      const result = validateCapabilities([]);
      expect(result).toEqual([]);
    });

    it('accepts array with 20 tags (max)', () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
      const result = validateCapabilities(tags);
      expect(result).toEqual(tags);
    });

    it('rejects array with 21 tags (over limit)', () => {
      const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
      const result = validateCapabilities(tags);
      expect(result).toBeNull();
    });

    it('rejects non-array input', () => {
      expect(validateCapabilities('not-an-array')).toBeNull();
      expect(validateCapabilities(123)).toBeNull();
      expect(validateCapabilities(null)).toBeNull();
      expect(validateCapabilities(undefined)).toBeNull();
      expect(validateCapabilities({})).toBeNull();
    });

    it('rejects array with invalid tags', () => {
      expect(validateCapabilities(['valid', '<script>'])).toBeNull();
      expect(validateCapabilities(['valid', 'UPPERCASE'])).toBeNull();
      expect(validateCapabilities(['valid', 123])).toBeNull();
    });
  });
});
