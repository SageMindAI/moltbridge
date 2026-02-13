"""
Ed25519 request signing for MoltBridge API authentication.

Signs every request with:
    Authorization: MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>
    Signature covers: method:path:timestamp:sha256(body)
"""

from __future__ import annotations

import hashlib
import json
import time
from base64 import urlsafe_b64encode

from nacl.signing import SigningKey


class Ed25519Signer:
    """Handles Ed25519 request signing."""

    def __init__(self, signing_key: SigningKey, agent_id: str):
        self._key = signing_key
        self._agent_id = agent_id

    @classmethod
    def from_seed(cls, seed_hex: str, agent_id: str) -> "Ed25519Signer":
        """Create from a 32-byte hex seed."""
        seed_bytes = bytes.fromhex(seed_hex)
        return cls(SigningKey(seed_bytes), agent_id)

    @classmethod
    def from_bytes(cls, key_bytes: bytes, agent_id: str) -> "Ed25519Signer":
        """Create from raw 32-byte seed."""
        return cls(SigningKey(key_bytes), agent_id)

    @classmethod
    def generate(cls, agent_id: str) -> "Ed25519Signer":
        """Generate a new random keypair."""
        return cls(SigningKey.generate(), agent_id)

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def public_key_b64(self) -> str:
        """Public key as base64url string (for registration)."""
        return urlsafe_b64encode(
            bytes(self._key.verify_key)
        ).rstrip(b"=").decode("ascii")

    @property
    def seed_hex(self) -> str:
        """Private key seed as hex (for storage)."""
        return bytes(self._key).hex()

    def sign_request(self, method: str, path: str, body: dict | None = None) -> str:
        """
        Sign a request and return the Authorization header value.

        Returns: "MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>"
        """
        timestamp = str(int(time.time()))

        body_str = json.dumps(body, separators=(",", ":"), sort_keys=True) if body else ""
        body_hash = hashlib.sha256(body_str.encode()).hexdigest()

        message = f"{method}:{path}:{timestamp}:{body_hash}"
        signed = self._key.sign(message.encode())
        signature = urlsafe_b64encode(signed.signature).rstrip(b"=").decode("ascii")

        return f"MoltBridge-Ed25519 {self._agent_id}:{timestamp}:{signature}"
