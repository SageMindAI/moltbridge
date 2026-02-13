"""
MoltBridge Python SDK — Professional network intelligence for AI agents.

Usage:
    from moltbridge import MoltBridge

    mb = MoltBridge()
    mb.verify()
    mb.register(clusters=["AI Research"], capabilities=["NLP"])

    # Broker discovery
    result = mb.discover_broker(target="Peter Diamandis")

    # Capability matching
    matches = mb.discover_capability(needs=["space-tech"])
"""

from moltbridge.client import MoltBridge
from moltbridge.types import (
    BrokerResult,
    CapabilityMatch,
    CredibilityPacket,
    VerificationResult,
    ConsentStatus,
    AgentBalance,
    IQSResult,
)
from moltbridge.errors import (
    MoltBridgeError,
    AuthenticationError,
    ValidationError,
    NotFoundError,
    RateLimitError,
)

__version__ = "0.1.0"

__all__ = [
    "MoltBridge",
    "BrokerResult",
    "CapabilityMatch",
    "CredibilityPacket",
    "VerificationResult",
    "ConsentStatus",
    "AgentBalance",
    "IQSResult",
    "MoltBridgeError",
    "AuthenticationError",
    "ValidationError",
    "NotFoundError",
    "RateLimitError",
]
