/**
 * Unit Tests: Error Handling (src/middleware/errors.ts)
 *
 * Tests error utilities and global error handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { MoltBridgeError, Errors, globalErrorHandler } from '../../src/middleware/errors';
import type { Request, Response, NextFunction } from 'express';

describe('Error Handling', () => {
  describe('MoltBridgeError', () => {
    it('creates error with correct properties', () => {
      const err = new MoltBridgeError('TEST_CODE', 'test message', 418);
      expect(err.code).toBe('TEST_CODE');
      expect(err.message).toBe('test message');
      expect(err.status).toBe(418);
      expect(err.name).toBe('MoltBridgeError');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('Errors factory', () => {
    it('agentNotFound returns 404', () => {
      const err = Errors.agentNotFound('dawn-001');
      expect(err.status).toBe(404);
      expect(err.code).toBe('AGENT_NOT_FOUND');
      expect(err.message).toContain('dawn-001');
    });

    it('unauthorized returns 401', () => {
      const err = Errors.unauthorized('bad token');
      expect(err.status).toBe(401);
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.message).toBe('bad token');
    });

    it('unauthorized with no detail uses default message', () => {
      const err = Errors.unauthorized();
      expect(err.message).toBe('Missing or invalid authentication');
    });

    it('rateLimited returns 429', () => {
      const err = Errors.rateLimited();
      expect(err.status).toBe(429);
      expect(err.code).toBe('RATE_LIMITED');
    });

    it('validationError returns 400', () => {
      const err = Errors.validationError('bad input');
      expect(err.status).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('serviceUnavailable returns 503', () => {
      const err = Errors.serviceUnavailable();
      expect(err.status).toBe(503);
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('conflict returns 409', () => {
      const err = Errors.conflict('already exists');
      expect(err.status).toBe(409);
      expect(err.code).toBe('CONFLICT');
    });
  });

  describe('globalErrorHandler', () => {
    function createMockRes(): Response {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as unknown as Response;
      return res;
    }

    it('handles MoltBridgeError with correct status and body', () => {
      const err = new MoltBridgeError('TEST', 'test error', 422);
      const res = createMockRes();

      globalErrorHandler(err, {} as Request, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'TEST',
          message: 'test error',
          status: 422,
        },
      });
    });

    it('handles unexpected errors with 500', () => {
      const err = new Error('unexpected');
      const res = createMockRes();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      globalErrorHandler(err, {} as Request, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          status: 500,
        },
      });

      consoleSpy.mockRestore();
    });
  });
});
