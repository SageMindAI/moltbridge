/**
 * MoltBridge SDK — Error Types
 *
 * Maps HTTP error responses to typed exceptions with actionable messages.
 */

export class MoltBridgeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 0, code = 'UNKNOWN') {
    super(message);
    this.name = 'MoltBridgeError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static fromResponse(statusCode: number, body: Record<string, unknown>): MoltBridgeError {
    const error = (body.error ?? {}) as Record<string, unknown>;
    const message = (error.message as string) ?? 'Unknown error';
    const code = (error.code as string) ?? 'UNKNOWN';

    const errorMap: Record<number, typeof MoltBridgeError> = {
      401: AuthenticationError,
      403: AuthenticationError,
      400: ValidationError,
      404: NotFoundError,
      409: ConflictError,
      429: RateLimitError,
      503: ServiceUnavailableError,
    };

    const ErrorClass = errorMap[statusCode] ?? MoltBridgeError;
    return new ErrorClass(message, statusCode, code);
  }
}

export class AuthenticationError extends MoltBridgeError {
  constructor(message = 'Authentication failed', statusCode = 401, code = 'AUTH_FAILED') {
    super(message, statusCode, code);
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends MoltBridgeError {
  constructor(message = 'Validation failed', statusCode = 400, code = 'VALIDATION_ERROR') {
    super(message, statusCode, code);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends MoltBridgeError {
  constructor(message = 'Not found', statusCode = 404, code = 'NOT_FOUND') {
    super(message, statusCode, code);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends MoltBridgeError {
  constructor(message = 'Conflict', statusCode = 409, code = 'CONFLICT') {
    super(message, statusCode, code);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends MoltBridgeError {
  retryAfter?: number;

  constructor(message = 'Rate limit exceeded', statusCode = 429, code = 'RATE_LIMITED') {
    super(message, statusCode, code);
    this.name = 'RateLimitError';
  }
}

export class ServiceUnavailableError extends MoltBridgeError {
  constructor(message = 'Service unavailable', statusCode = 503, code = 'UNAVAILABLE') {
    super(message, statusCode, code);
    this.name = 'ServiceUnavailableError';
  }
}
