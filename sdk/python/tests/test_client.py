"""Tests for MoltBridge client — mocked HTTP responses."""

import json
from unittest.mock import patch, MagicMock

import httpx
import pytest

from moltbridge.client import MoltBridge
from moltbridge.errors import (
    AuthenticationError,
    MoltBridgeError,
    NotFoundError,
    ValidationError,
)


@pytest.fixture
def mb():
    """Create a client with test credentials."""
    return MoltBridge(
        base_url="http://localhost:3040",
        agent_id="test-agent-001",
        signing_key="a" * 64,  # 32 bytes of 0xAA
    )


class TestHealth:
    def test_health_returns_status(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={"name": "MoltBridge", "status": "healthy", "uptime": 100},
            )
            result = mb.health()
            assert result["status"] == "healthy"

    def test_pricing_no_auth(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={"pricing": {"broker_discovery": 0.02}},
            )
            result = mb.pricing()
            assert "pricing" in result


class TestDiscovery:
    def test_discover_broker_success(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "broker_agent_id": "broker-001",
                            "broker_name": "BridgeBot",
                            "broker_trust_score": 0.85,
                            "path_hops": 2,
                            "via_clusters": ["AI Research"],
                            "composite_score": 0.72,
                        }
                    ],
                    "query_time_ms": 45,
                    "path_found": True,
                    "discovery_hint": "Share with agents",
                },
            )
            result = mb.discover_broker(target="peter-d")
            assert result.path_found is True
            assert len(result.results) == 1
            assert result.results[0].broker_name == "BridgeBot"
            assert result.results[0].broker_trust_score == 0.85

    def test_discover_broker_no_path(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "results": [],
                    "query_time_ms": 30,
                    "path_found": False,
                    "message": "No path exists",
                },
            )
            result = mb.discover_broker(target="unreachable")
            assert result.path_found is False
            assert len(result.results) == 0

    def test_discover_capability(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "agent_id": "agent-007",
                            "agent_name": "SpaceAgent",
                            "trust_score": 0.9,
                            "matched_capabilities": ["space-tech"],
                            "match_score": 0.85,
                        }
                    ],
                    "query_time_ms": 20,
                },
            )
            result = mb.discover_capability(needs=["space-tech"])
            assert len(result.results) == 1
            assert result.results[0].agent_name == "SpaceAgent"


class TestAttestation:
    def test_attest(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                201,
                json={
                    "attestation": {
                        "source": "test-agent-001",
                        "target": "agent-002",
                        "type": "INTERACTION",
                        "confidence": 0.8,
                        "created_at": "2026-01-01T00:00:00Z",
                        "valid_until": "2026-07-01T00:00:00Z",
                    },
                    "target_trust_score": 0.75,
                },
            )
            result = mb.attest("agent-002", confidence=0.8)
            assert result.source == "test-agent-001"
            assert result.target_trust_score == 0.75


class TestConsent:
    def test_consent_status(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "consents": {
                        "iqs_scoring": {"granted": True, "granted_at": "2026-01-01"},
                        "data_sharing": {"granted": False},
                    },
                    "descriptions": {"iqs_scoring": "Allow IQS scoring"},
                },
            )
            result = mb.consent_status()
            assert result.consents["iqs_scoring"].granted is True
            assert result.consents["data_sharing"].granted is False

    def test_grant_consent(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "consent": {
                        "purpose": "iqs_scoring",
                        "granted": True,
                        "granted_at": "2026-01-01",
                        "mechanism": "api-grant",
                    },
                },
            )
            result = mb.grant_consent("iqs_scoring")
            assert result.granted is True
            assert result.purpose == "iqs_scoring"


class TestPayments:
    def test_balance(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "balance": {
                        "agent_id": "test-agent-001",
                        "balance": 25.50,
                        "broker_tier": "founding",
                        "commission_rate": 0.5,
                    },
                },
            )
            result = mb.balance()
            assert result.balance == 25.50
            assert result.broker_tier == "founding"

    def test_deposit(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "entry": {
                        "id": "entry-001",
                        "agent_id": "test-agent-001",
                        "type": "credit",
                        "amount": 10.0,
                        "description": "Deposit",
                        "timestamp": "2026-01-01",
                        "balance_after": 35.50,
                    },
                },
            )
            result = mb.deposit(10.0)
            assert result.amount == 10.0
            assert result.balance_after == 35.50


class TestIQS:
    def test_evaluate_iqs(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                200,
                json={
                    "band": "high",
                    "recommendation": "Proceed with introduction",
                    "threshold_used": 0.7,
                    "components_received": True,
                },
            )
            result = mb.evaluate_iqs("target-001")
            assert result.band == "high"
            assert result.components_received is True


class TestWebhooks:
    def test_register_webhook(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                201,
                json={
                    "registration": {
                        "endpoint_url": "https://example.com/webhook",
                        "event_types": ["introduction_request"],
                        "active": True,
                    },
                    "secret": "whsec_test123",
                },
            )
            result = mb.register_webhook(
                "https://example.com/webhook",
                ["introduction_request"],
            )
            assert result.active is True
            assert result.secret == "whsec_test123"


class TestErrors:
    def test_auth_error(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                401,
                json={"error": {"code": "UNAUTHORIZED", "message": "Invalid signature"}},
            )
            with pytest.raises(AuthenticationError) as exc_info:
                mb.health()
            assert "Invalid signature" in str(exc_info.value)

    def test_validation_error(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                400,
                json={"error": {"code": "VALIDATION_ERROR", "message": "Missing field"}},
            )
            with pytest.raises(ValidationError):
                mb.discover_broker(target="")

    def test_not_found_error(self, mb: MoltBridge):
        with patch.object(mb._client, "request") as mock_req:
            mock_req.return_value = httpx.Response(
                404,
                json={"error": {"code": "NOT_FOUND", "message": "Agent not found"}},
            )
            with pytest.raises(NotFoundError):
                mb.attest("nonexistent-agent")

    def test_no_auth_configured(self):
        mb = MoltBridge(base_url="http://localhost:3040")
        with pytest.raises(MoltBridgeError, match="Authentication required"):
            mb.discover_broker(target="test")


class TestClientLifecycle:
    def test_context_manager(self):
        with MoltBridge(
            base_url="http://localhost:3040",
            agent_id="test",
            signing_key="a" * 64,
        ) as mb:
            assert mb.agent_id == "test"
        # Client should be closed after context manager exits

    def test_public_key_available(self):
        mb = MoltBridge(
            base_url="http://localhost:3040",
            agent_id="test",
            signing_key="a" * 64,
        )
        assert mb.public_key is not None
        assert len(mb.public_key) > 0
