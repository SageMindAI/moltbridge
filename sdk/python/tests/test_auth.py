"""Tests for Ed25519 request signing."""

import hashlib
import json
import time

from nacl.signing import SigningKey, VerifyKey

from moltbridge.auth import Ed25519Signer


class TestEd25519Signer:
    def test_generate_creates_valid_keypair(self):
        signer = Ed25519Signer.generate("test-agent")
        assert signer.agent_id == "test-agent"
        assert len(signer.public_key_b64) > 0
        assert len(signer.seed_hex) == 64  # 32 bytes as hex

    def test_from_seed_roundtrip(self):
        original = Ed25519Signer.generate("test-agent")
        seed = original.seed_hex
        restored = Ed25519Signer.from_seed(seed, "test-agent")
        assert restored.public_key_b64 == original.public_key_b64

    def test_sign_request_format(self):
        signer = Ed25519Signer.generate("agent-001")
        header = signer.sign_request("POST", "/discover-broker", {"target": "test"})

        assert header.startswith("MoltBridge-Ed25519 ")
        parts = header.split(" ", 1)[1].split(":")
        assert len(parts) == 3
        assert parts[0] == "agent-001"  # agent_id
        assert int(parts[1])  # timestamp
        assert len(parts[2]) > 0  # signature

    def test_signature_is_verifiable(self):
        signer = Ed25519Signer.generate("agent-001")
        body = {"target": "peter-d"}

        header = signer.sign_request("POST", "/discover-broker", body)
        parts = header.split(" ", 1)[1].split(":")
        timestamp = parts[1]
        sig_b64 = parts[2]

        # Reconstruct message
        body_hash = hashlib.sha256(
            json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()
        message = f"POST:/discover-broker:{timestamp}:{body_hash}"

        # Verify with public key
        from base64 import urlsafe_b64decode
        # Add padding back
        sig_padded = sig_b64 + "=" * (4 - len(sig_b64) % 4)
        sig_bytes = urlsafe_b64decode(sig_padded)

        pub_padded = signer.public_key_b64 + "=" * (4 - len(signer.public_key_b64) % 4)
        pub_bytes = urlsafe_b64decode(pub_padded)

        verify_key = VerifyKey(pub_bytes)
        # Should not raise
        verify_key.verify(message.encode(), sig_bytes)

    def test_different_bodies_produce_different_signatures(self):
        signer = Ed25519Signer.generate("agent-001")

        header1 = signer.sign_request("POST", "/test", {"a": 1})
        header2 = signer.sign_request("POST", "/test", {"b": 2})

        sig1 = header1.split(":")[-1]
        sig2 = header2.split(":")[-1]
        assert sig1 != sig2

    def test_empty_body_handling(self):
        signer = Ed25519Signer.generate("agent-001")
        header = signer.sign_request("GET", "/health")
        assert "agent-001" in header
