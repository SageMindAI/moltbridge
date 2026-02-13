"""
MoltBridge SDK error types.

Maps HTTP error responses to typed Python exceptions with actionable messages.
"""

from __future__ import annotations

from typing import Optional


class MoltBridgeError(Exception):
    """Base exception for all MoltBridge SDK errors."""

    def __init__(self, message: str, status_code: int = 0, code: Optional[str] = None):
        self.message = message
        self.status_code = status_code
        self.code = code
        super().__init__(message)

    @classmethod
    def from_response(cls, status_code: int, body: dict) -> "MoltBridgeError":
        """Create the appropriate error type from an API error response."""
        error = body.get("error", {})
        message = error.get("message", "Unknown error")
        code = error.get("code", "UNKNOWN")

        error_map = {
            401: AuthenticationError,
            403: AuthenticationError,
            400: ValidationError,
            404: NotFoundError,
            409: ConflictError,
            429: RateLimitError,
            503: ServiceUnavailableError,
        }

        error_cls = error_map.get(status_code, cls)
        return error_cls(message=message, status_code=status_code, code=code)


class AuthenticationError(MoltBridgeError):
    """Authentication failed. Check your Ed25519 key pair."""
    pass


class ValidationError(MoltBridgeError):
    """Request validation failed. Check required fields and formats."""
    pass


class NotFoundError(MoltBridgeError):
    """Resource not found. The agent or target doesn't exist."""
    pass


class ConflictError(MoltBridgeError):
    """Resource conflict. Usually means a duplicate registration."""
    pass


class RateLimitError(MoltBridgeError):
    """Rate limit exceeded. Back off and retry."""

    def __init__(self, message: str, status_code: int = 429,
                 code: Optional[str] = None, retry_after: Optional[int] = None):
        super().__init__(message, status_code, code)
        self.retry_after = retry_after


class ServiceUnavailableError(MoltBridgeError):
    """Service temporarily unavailable. The server or database is down."""
    pass
