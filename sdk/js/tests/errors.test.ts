/**
 * Tests for error types and fromResponse factory.
 */

import { describe, it, expect } from 'vitest';
import {
  MoltBridgeError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
} from '../src/errors.js';

describe('MoltBridgeError', () => {
  it('stores message, statusCode, and code', () => {
    const err = new MoltBridgeError('test error', 500, 'INTERNAL');
    expect(err.message).toBe('test error');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL');
    expect(err.name).toBe('MoltBridgeError');
  });

  it('defaults statusCode to 0 and code to UNKNOWN', () => {
    const err = new MoltBridgeError('test');
    expect(err.statusCode).toBe(0);
    expect(err.code).toBe('UNKNOWN');
  });

  it('is instanceof Error', () => {
    const err = new MoltBridgeError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MoltBridgeError);
  });
});

describe('fromResponse()', () => {
  it('maps 401 to AuthenticationError', () => {
    const err = MoltBridgeError.fromResponse(401, {
      error: { message: 'Invalid signature', code: 'UNAUTHORIZED' },
    });
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).toBe('Invalid signature');
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('maps 403 to AuthenticationError', () => {
    const err = MoltBridgeError.fromResponse(403, {
      error: { message: 'Forbidden', code: 'FORBIDDEN' },
    });
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('maps 400 to ValidationError', () => {
    const err = MoltBridgeError.fromResponse(400, {
      error: { message: 'Missing field', code: 'VALIDATION' },
    });
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('maps 404 to NotFoundError', () => {
    const err = MoltBridgeError.fromResponse(404, {
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('maps 409 to ConflictError', () => {
    const err = MoltBridgeError.fromResponse(409, {
      error: { message: 'Duplicate', code: 'CONFLICT' },
    });
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('maps 429 to RateLimitError', () => {
    const err = MoltBridgeError.fromResponse(429, {
      error: { message: 'Too many requests', code: 'RATE_LIMITED' },
    });
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('maps 503 to ServiceUnavailableError', () => {
    const err = MoltBridgeError.fromResponse(503, {
      error: { message: 'Down for maintenance', code: 'UNAVAILABLE' },
    });
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it('returns MoltBridgeError for unknown status codes', () => {
    const err = MoltBridgeError.fromResponse(500, {
      error: { message: 'Internal error', code: 'INTERNAL' },
    });
    expect(err).toBeInstanceOf(MoltBridgeError);
    expect(err.constructor).toBe(MoltBridgeError);
  });

  it('handles missing error object', () => {
    const err = MoltBridgeError.fromResponse(500, {});
    expect(err.message).toBe('Unknown error');
    expect(err.code).toBe('UNKNOWN');
  });

  it('handles empty body', () => {
    const err = MoltBridgeError.fromResponse(500, {} as Record<string, unknown>);
    expect(err.message).toBe('Unknown error');
  });
});

describe('subclass hierarchy', () => {
  it('all error subclasses are instanceof MoltBridgeError', () => {
    const errors = [
      new AuthenticationError(),
      new ValidationError(),
      new NotFoundError(),
      new ConflictError(),
      new RateLimitError(),
      new ServiceUnavailableError(),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(MoltBridgeError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('each subclass has correct name', () => {
    expect(new AuthenticationError().name).toBe('AuthenticationError');
    expect(new ValidationError().name).toBe('ValidationError');
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new ConflictError().name).toBe('ConflictError');
    expect(new RateLimitError().name).toBe('RateLimitError');
    expect(new ServiceUnavailableError().name).toBe('ServiceUnavailableError');
  });
});
