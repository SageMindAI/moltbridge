/**
 * Global Error Handler + Error Utilities
 */

import { Request, Response, NextFunction } from 'express';
import type { ApiError } from '../types';
import { getMetricsStore, getErrorTracker, type ErrorEntry } from '../services/metrics';

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
    // Categorize and track the error
    const errorType = categorizeError(err);
    const errorEntry: ErrorEntry = {
      timestamp: new Date().toISOString(),
      type: errorType,
      code: err.code,
      message: err.message,
      path: _req.path,
      method: _req.method,
      agentId: (_req as any).auth?.agent_id,
      ip: _req.ip,
    };
    getErrorTracker().record(errorEntry);
    getMetricsStore().appendLog('errors', errorEntry);

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
  const errorEntry: ErrorEntry = {
    timestamp: new Date().toISOString(),
    type: 'server_error',
    code: 'INTERNAL_ERROR',
    message: err.message,
    path: _req.path,
    method: _req.method,
    agentId: (_req as any).auth?.agent_id,
    ip: _req.ip,
  };
  getErrorTracker().record(errorEntry);
  getMetricsStore().appendLog('errors', errorEntry);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      status: 500,
    },
  });
}

function categorizeError(err: MoltBridgeError): ErrorEntry['type'] {
  switch (err.status) {
    case 401: return 'auth_failure';
    case 429: return 'rate_limit';
    case 400: return 'validation';
    case 404: return 'not_found';
    default: return err.status >= 500 ? 'server_error' : 'validation';
  }
}
