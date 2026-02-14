"""
Type definitions for MoltBridge SDK responses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class BrokerResult:
    """A broker candidate from a discovery query."""

    broker_agent_id: str
    broker_name: str
    broker_trust_score: float
    path_hops: int
    via_clusters: list[str] = field(default_factory=list)
    composite_score: float = 0.0


@dataclass
class BrokerDiscoveryResponse:
    """Response from broker discovery."""

    results: list[BrokerResult]
    query_time_ms: int
    path_found: bool
    message: Optional[str] = None
    discovery_hint: Optional[str] = None


@dataclass
class CapabilityMatch:
    """An agent matching capability requirements."""

    agent_id: str
    agent_name: str
    trust_score: float
    matched_capabilities: list[str] = field(default_factory=list)
    match_score: float = 0.0


@dataclass
class CapabilityMatchResponse:
    """Response from capability matching."""

    results: list[CapabilityMatch]
    query_time_ms: int
    discovery_hint: Optional[str] = None


@dataclass
class CredibilityPacket:
    """A JWT-signed credibility proof."""

    packet: str
    expires_in: int
    verify_url: str


@dataclass
class VerificationResult:
    """Result of proof-of-AI verification."""

    verified: bool
    token: Optional[str] = None
    agent_id: Optional[str] = None
    level: Optional[str] = None


@dataclass
class VerificationChallenge:
    """A proof-of-AI challenge to solve."""

    challenge_id: str
    difficulty: int
    nonce: str
    challenge_type: str = ""
    expires_at: str = ""
    target_prefix: str = ""


@dataclass
class ConsentRecord:
    """A single consent record."""

    purpose: str
    granted: bool
    granted_at: Optional[str] = None
    withdrawn_at: Optional[str] = None
    mechanism: Optional[str] = None


@dataclass
class ConsentStatus:
    """Current consent status for all purposes."""

    consents: dict[str, ConsentRecord]
    descriptions: dict[str, str]


@dataclass
class AgentBalance:
    """Agent payment account balance."""

    agent_id: str
    balance: float
    broker_tier: str
    commission_rate: float


@dataclass
class LedgerEntry:
    """A single payment ledger entry."""

    id: str
    agent_id: str
    type: str
    amount: float
    description: str
    timestamp: str
    balance_after: float


@dataclass
class IQSResult:
    """Introduction Quality Score result (band-based, anti-oracle)."""

    band: str  # "low", "medium", "high"
    recommendation: str
    threshold_used: float
    components_received: bool


@dataclass
class WebhookRegistration:
    """A registered webhook endpoint."""

    endpoint_url: str
    event_types: list[str]
    active: bool
    secret: Optional[str] = None  # Only returned on creation


@dataclass
class AttestationResult:
    """Result of submitting an attestation."""

    source: str
    target: str
    type: str
    confidence: float
    created_at: str
    valid_until: str
    target_trust_score: float = 0.0
