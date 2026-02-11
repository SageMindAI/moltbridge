/**
 * Global Error Handler + Error Utilities
 */

import { Request, Response, NextFunction } from 'express';
import type { ApiError } from '../types';

export class MoltBridgeError extends Error {
  public code: string;
  public status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'MoltBridgeError';
  }
}

// Pre-defined errors
export const Errors = {
  agentNotFound: (id: string) =>
    new MoltBridgeError('AGENT_NOT_FOUND', `No agent with id '${id}' exists`, 404),

  unauthorized: (detail?: string) =>
    new MoltBridgeError('UNAUTHORIZED', detail || 'Missing or invalid authentication', 401),

  rateLimited: () =>
    new MoltBridgeError('RATE_LIMITED', 'Too many requests', 429),

  validationError: (detail: string) =>
    new MoltBridgeError('VALIDATION_ERROR', detail, 400),

  serviceUnavailable: (detail?: string) =>
    new MoltBridgeError('SERVICE_UNAVAILABLE', detail || 'Service temporarily unavailable', 503),

  conflict: (detail: string) =>
    new MoltBridgeError('CONFLICT', detail, 409),
};

/**
 * Global error handling middleware.
 * Must be registered AFTER all routes.
 */
export function globalErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof MoltBridgeError) {
    const errorBody: { error: ApiError } = {
      error: {
        code: err.code,
        message: err.message,
        status: err.status,
      },
    };
    res.status(err.status).json(errorBody);
    return;
  }

  // Unexpected error
  console.error('[MoltBridge] Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      status: 500,
    },
  });
}
