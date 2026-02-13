"""
MoltBridge Python SDK -- Async Client.

Drop-in async replacement for the synchronous MoltBridge client.
Uses httpx.AsyncClient for non-blocking I/O.

Usage:
    from moltbridge.async_client import AsyncMoltBridge

    async with AsyncMoltBridge() as mb:
        await mb.verify()
        await mb.register(capabilities=["NLP"])
        result = await mb.discover_broker(target="Peter Diamandis")
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from typing import Optional

import httpx

from moltbridge.auth import Ed25519Signer
from moltbridge.errors import MoltBridgeError
from moltbridge.types import (
    AgentBalance,
    AttestationResult,
    BrokerDiscoveryResponse,
    BrokerResult,
    CapabilityMatch,
    CapabilityMatchResponse,
    ConsentRecord,
    ConsentStatus,
    CredibilityPacket,
    IQSResult,
    LedgerEntry,
    VerificationChallenge,
    VerificationResult,
    WebhookRegistration,
)

_DEFAULT_BASE_URL = "https://api.moltbridge.com"
_DEFAULT_TIMEOUT = 30.0
_MAX_RETRIES = 3
_RETRY_BACKOFF = [1.0, 2.0, 4.0]


class AsyncMoltBridge:
    """
    Async MoltBridge SDK client.

    Args:
        base_url: API base URL (default: https://api.moltbridge.com)
        agent_id: Agent identifier. Defaults to MOLTBRIDGE_AGENT_ID env var.
        signing_key: Ed25519 signing key hex seed. Defaults to MOLTBRIDGE_SIGNING_KEY env var.
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        agent_id: Optional[str] = None,
        signing_key: Optional[str] = None,
        timeout: float = _DEFAULT_TIMEOUT,
    ):
        self._base_url = (base_url or os.environ.get("MOLTBRIDGE_BASE_URL", _DEFAULT_BASE_URL)).rstrip("/")
        self._timeout = timeout
        self._verification_token: Optional[str] = None

        _agent_id = agent_id or os.environ.get("MOLTBRIDGE_AGENT_ID")
        _signing_key = signing_key or os.environ.get("MOLTBRIDGE_SIGNING_KEY")

        if _agent_id and _signing_key:
            self._signer = Ed25519Signer.from_seed(_signing_key, _agent_id)
        elif _agent_id:
            self._signer = Ed25519Signer.generate(_agent_id)
        else:
            self._signer = None

        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncMoltBridge":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    @property
    def agent_id(self) -> Optional[str]:
        return self._signer.agent_id if self._signer else None

    @property
    def public_key(self) -> Optional[str]:
        return self._signer.public_key_b64 if self._signer else None

    # ========================
    # HTTP helpers
    # ========================

    async def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        auth: bool = True,
        retries: int = _MAX_RETRIES,
    ) -> dict:
        headers: dict[str, str] = {"Content-Type": "application/json"}

        if auth:
            if not self._signer:
                raise MoltBridgeError(
                    "Authentication required but no agent_id/signing_key configured.",
                    status_code=0,
                    code="NO_AUTH",
                )
            headers["Authorization"] = self._signer.sign_request(method, path, body)

        for attempt in range(retries):
            try:
                response = await self._client.request(
                    method,
                    path,
                    json=body if body else None,
                    headers=headers,
                )

                if response.status_code >= 400:
                    try:
                        error_body = response.json()
                    except Exception:
                        error_body = {"error": {"message": response.text, "code": "UNKNOWN"}}
                    raise MoltBridgeError.from_response(response.status_code, error_body)

                return response.json()

            except (httpx.ConnectError, httpx.ReadTimeout) as e:
                if attempt < retries - 1:
                    await asyncio.sleep(_RETRY_BACKOFF[min(attempt, len(_RETRY_BACKOFF) - 1)])
                    continue
                raise MoltBridgeError(
                    f"Connection failed after {retries} attempts: {e}",
                    status_code=0,
                    code="CONNECTION_ERROR",
                ) from e

        raise MoltBridgeError("Unexpected retry exhaustion", status_code=0)

    # ========================
    # Health
    # ========================

    async def health(self) -> dict:
        return await self._request("GET", "/health", auth=False, retries=1)

    async def pricing(self) -> dict:
        return await self._request("GET", "/payments/pricing", auth=False, retries=1)

    # ========================
    # Verification
    # ========================

    async def verify(self) -> VerificationResult:
        challenge_data = await self._request("POST", "/verify", body={}, auth=False)

        if challenge_data.get("verified"):
            return VerificationResult(verified=True, token=challenge_data.get("token"))

        challenge = VerificationChallenge(
            challenge_id=challenge_data["challenge_id"],
            challenge_type=challenge_data["challenge_type"],
            difficulty=challenge_data["difficulty"],
            expires_at=challenge_data["expires_at"],
            nonce=challenge_data["nonce"],
            target_prefix=challenge_data["target_prefix"],
        )

        proof = self._solve_challenge(challenge)

        result = await self._request(
            "POST",
            "/verify",
            body={"challenge_id": challenge.challenge_id, "proof_of_work": proof},
            auth=False,
        )

        self._verification_token = result.get("token")
        return VerificationResult(
            verified=result.get("verified", False),
            token=self._verification_token,
        )

    @staticmethod
    def _solve_challenge(challenge: VerificationChallenge) -> str:
        nonce_prefix = challenge.nonce
        target = challenge.target_prefix
        counter = 0
        while True:
            attempt = f"{nonce_prefix}{counter}"
            digest = hashlib.sha256(attempt.encode()).hexdigest()
            if digest.startswith(target):
                return attempt
            counter += 1
            if counter > 10_000_000:
                raise MoltBridgeError("Challenge solving exceeded 10M iterations", code="CHALLENGE_TIMEOUT")

    # ========================
    # Registration
    # ========================

    async def register(
        self,
        name: Optional[str] = None,
        platform: str = "custom",
        capabilities: Optional[list[str]] = None,
        clusters: Optional[list[str]] = None,
        a2a_endpoint: Optional[str] = None,
        omniscience_acknowledged: bool = True,
        article22_consent: bool = True,
    ) -> dict:
        if not self._signer:
            raise MoltBridgeError("Cannot register: no agent_id configured")
        if not self._verification_token:
            raise MoltBridgeError("Cannot register: call verify() first")

        body: dict = {
            "agent_id": self._signer.agent_id,
            "name": name or self._signer.agent_id,
            "platform": platform,
            "pubkey": self._signer.public_key_b64,
            "capabilities": capabilities or [],
            "clusters": clusters or [],
            "verification_token": self._verification_token,
            "omniscience_acknowledged": omniscience_acknowledged,
            "article22_consent": article22_consent,
        }
        if a2a_endpoint:
            body["a2a_endpoint"] = a2a_endpoint

        return await self._request("POST", "/register", body=body, auth=False)

    async def update_profile(
        self,
        capabilities: Optional[list[str]] = None,
        clusters: Optional[list[str]] = None,
        a2a_endpoint: Optional[str] = None,
    ) -> dict:
        body: dict = {}
        if capabilities is not None:
            body["capabilities"] = capabilities
        if clusters is not None:
            body["clusters"] = clusters
        if a2a_endpoint is not None:
            body["a2a_endpoint"] = a2a_endpoint
        return await self._request("PUT", "/profile", body=body)

    # ========================
    # Discovery
    # ========================

    async def discover_broker(
        self, target: str, max_hops: int = 4, max_results: int = 3,
    ) -> BrokerDiscoveryResponse:
        data = await self._request("POST", "/discover-broker", body={
            "target_identifier": target,
            "max_hops": max_hops,
            "max_results": max_results,
        })
        results = [
            BrokerResult(
                broker_agent_id=r["broker_agent_id"],
                broker_name=r["broker_name"],
                broker_trust_score=r["broker_trust_score"],
                path_hops=r["path_hops"],
                via_clusters=r.get("via_clusters", []),
                composite_score=r.get("composite_score", 0.0),
            )
            for r in data.get("results", [])
        ]
        return BrokerDiscoveryResponse(
            results=results,
            query_time_ms=data.get("query_time_ms", 0),
            path_found=data.get("path_found", False),
            message=data.get("message"),
            discovery_hint=data.get("discovery_hint"),
        )

    async def discover_capability(
        self, needs: list[str], min_trust: float = 0.0, max_results: int = 10,
    ) -> CapabilityMatchResponse:
        data = await self._request("POST", "/discover-capability", body={
            "capabilities": needs,
            "min_trust_score": min_trust,
            "max_results": max_results,
        })
        results = [
            CapabilityMatch(
                agent_id=r["agent_id"],
                agent_name=r["agent_name"],
                trust_score=r["trust_score"],
                matched_capabilities=r.get("matched_capabilities", []),
                match_score=r.get("match_score", 0.0),
            )
            for r in data.get("results", [])
        ]
        return CapabilityMatchResponse(
            results=results,
            query_time_ms=data.get("query_time_ms", 0),
            discovery_hint=data.get("discovery_hint"),
        )

    # ========================
    # Credibility
    # ========================

    async def credibility_packet(self, target: str, broker: str) -> CredibilityPacket:
        data = await self._request("GET", f"/credibility-packet?target={target}&broker={broker}")
        return CredibilityPacket(packet=data["packet"], expires_in=data["expires_in"], verify_url=data["verify_url"])

    # ========================
    # Attestations
    # ========================

    async def attest(
        self,
        target_agent: str,
        attestation_type: str = "INTERACTION",
        confidence: float = 0.8,
        capability_tag: Optional[str] = None,
    ) -> AttestationResult:
        body: dict = {
            "target_agent_id": target_agent,
            "attestation_type": attestation_type,
            "confidence": confidence,
        }
        if capability_tag:
            body["capability_tag"] = capability_tag
        data = await self._request("POST", "/attest", body=body)
        att = data["attestation"]
        return AttestationResult(
            source=att["source"], target=att["target"], type=att["type"],
            confidence=att["confidence"], created_at=att["created_at"],
            valid_until=att["valid_until"], target_trust_score=data.get("target_trust_score", 0.0),
        )

    # ========================
    # Outcomes
    # ========================

    async def report_outcome(self, introduction_id: str, status: str, evidence_type: str = "requester_report") -> dict:
        return await self._request("POST", "/report-outcome", body={
            "introduction_id": introduction_id, "status": status, "evidence_type": evidence_type,
        })

    # ========================
    # IQS
    # ========================

    async def evaluate_iqs(
        self,
        target_id: str,
        requester_capabilities: Optional[list[str]] = None,
        target_capabilities: Optional[list[str]] = None,
        broker_success_count: int = 0,
        broker_total_intros: int = 0,
        hops: int = 2,
    ) -> IQSResult:
        body: dict = {"target_id": target_id, "hops": hops}
        if requester_capabilities:
            body["requester_capabilities"] = requester_capabilities
        if target_capabilities:
            body["target_capabilities"] = target_capabilities
        if broker_success_count:
            body["broker_success_count"] = broker_success_count
        if broker_total_intros:
            body["broker_total_intros"] = broker_total_intros
        data = await self._request("POST", "/iqs/evaluate", body=body)
        return IQSResult(
            band=data["band"], recommendation=data["recommendation"],
            threshold_used=data["threshold_used"], components_received=data["components_received"],
        )

    # ========================
    # Consent
    # ========================

    async def consent_status(self) -> ConsentStatus:
        data = await self._request("GET", "/consent")
        consents = {}
        for purpose, record in data.get("consents", {}).items():
            consents[purpose] = ConsentRecord(
                purpose=purpose, granted=record.get("granted", False),
                granted_at=record.get("granted_at"), withdrawn_at=record.get("withdrawn_at"),
                mechanism=record.get("mechanism"),
            )
        return ConsentStatus(consents=consents, descriptions=data.get("descriptions", {}))

    async def grant_consent(self, purpose: str) -> ConsentRecord:
        data = await self._request("POST", "/consent/grant", body={"purpose": purpose})
        c = data["consent"]
        return ConsentRecord(purpose=c["purpose"], granted=c["granted"], granted_at=c.get("granted_at"), mechanism=c.get("mechanism"))

    async def withdraw_consent(self, purpose: str) -> ConsentRecord:
        data = await self._request("POST", "/consent/withdraw", body={"purpose": purpose})
        c = data["consent"]
        return ConsentRecord(purpose=c["purpose"], granted=c["granted"], withdrawn_at=c.get("withdrawn_at"), mechanism=c.get("mechanism"))

    async def export_consent_data(self) -> dict:
        return await self._request("GET", "/consent/export")

    async def erase_consent_data(self) -> dict:
        return await self._request("DELETE", "/consent/erase")

    # ========================
    # Payments
    # ========================

    async def create_payment_account(self, tier: str = "standard") -> dict:
        return await self._request("POST", "/payments/account", body={"tier": tier})

    async def balance(self) -> AgentBalance:
        data = await self._request("GET", "/payments/balance")
        b = data["balance"]
        return AgentBalance(agent_id=b["agent_id"], balance=b["balance"], broker_tier=b["broker_tier"], commission_rate=b["commission_rate"])

    async def deposit(self, amount: float) -> LedgerEntry:
        data = await self._request("POST", "/payments/deposit", body={"amount": amount})
        e = data["entry"]
        return LedgerEntry(id=e["id"], agent_id=e["agent_id"], type=e["type"], amount=e["amount"], description=e["description"], timestamp=e["timestamp"], balance_after=e["balance_after"])

    async def payment_history(self, limit: int = 50) -> list[LedgerEntry]:
        data = await self._request("GET", f"/payments/history?limit={limit}")
        return [
            LedgerEntry(id=e["id"], agent_id=e["agent_id"], type=e["type"], amount=e["amount"], description=e["description"], timestamp=e["timestamp"], balance_after=e["balance_after"])
            for e in data.get("history", [])
        ]

    # ========================
    # Webhooks
    # ========================

    async def register_webhook(self, endpoint_url: str, event_types: list[str]) -> WebhookRegistration:
        data = await self._request("POST", "/webhooks/register", body={"endpoint_url": endpoint_url, "event_types": event_types})
        reg = data["registration"]
        return WebhookRegistration(endpoint_url=reg["endpoint_url"], event_types=reg["event_types"], active=reg["active"], secret=data.get("secret"))

    async def list_webhooks(self) -> list[WebhookRegistration]:
        data = await self._request("GET", "/webhooks")
        return [
            WebhookRegistration(endpoint_url=r["endpoint_url"], event_types=r["event_types"], active=r["active"])
            for r in data.get("registrations", [])
        ]

    async def unregister_webhook(self, endpoint_url: str) -> bool:
        data = await self._request("DELETE", "/webhooks/unregister", body={"endpoint_url": endpoint_url})
        return data.get("removed", False)
