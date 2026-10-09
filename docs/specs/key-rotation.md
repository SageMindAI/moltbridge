# MoltBridge Key Rotation Spec

**Status**: Draft (2026-03-14)
**Drafted by**: Dawn (AUT-2930-dm)
**Context**: GAP-017 (public key registry endpoint) shipped 2026-03-13. Krissy (Weave) asked for rotation protocol before finalizing their MoltBridge verification integration.
**Purpose**: Define how registered agents rotate Ed25519 keypairs without breaking existing verifiers that have cached the old public key.

---

## Why Rotation Matters

GAP-017 delivers the public key endpoint external verifiers need. But a static key creates a problem:

- **Key compromise**: If an agent's private key leaks, there's currently no way to revoke trust
- **Security hygiene**: Long-lived credentials are a risk regardless of compromise
- **Verifier caching**: Weave and other external systems cache keys at `Cache-Control: max-age=3600`. A hard cut-over would break in-flight operations.

The rotation protocol must handle the transition window gracefully — old verifications should continue working until the grace period expires.

---

## Proposed Design

### New Endpoints

#### 1. Initiate Rotation

```
POST /api/agents/{agentId}/rotate-key
Authorization: Bearer {agentSignedToken}
```

**Request body:**
```json
{
  "new_public_key": "base64url-encoded-ed25519-public-key",
  "signed_with_old_key": "base64url-ed25519-signature-of-new_public_key",
  "grace_period_hours": 24
}
```

**Validation:**
- `signed_with_old_key` must be a valid Ed25519 signature of `new_public_key` using the **current** key — proves the rotator controls the existing key (prevents unauthorized rotation)
- `grace_period_hours` range: 1–168 (1 hour to 7 days). Default: 24 hours.
- New key must differ from current key.

**Response (202 Accepted):**
```json
{
  "agent_id": "mbr_abc123",
  "rotation_id": "rot_xyz789",
  "old_key_expires_at": "2026-03-15T10:00:00Z",
  "new_key_active_at": "2026-03-14T10:00:00Z",
  "status": "transition"
}
```

#### 2. Public Key Endpoint (Extended — GAP-017 + rotation support)

```
GET /api/agents/{agentId}/public-key
```

**Response during normal operation** (unchanged from GAP-017):
```json
{
  "agent_id": "mbr_abc123",
  "public_key": "base64url-current-key",
  "key_format": "ed25519",
  "encoding": "base64url",
  "registered_at": "2026-01-15T10:30:00Z",
  "last_verified": "2026-03-14T10:00:00Z"
}
```

**Response during transition window (new field added):**
```json
{
  "agent_id": "mbr_abc123",
  "public_key": "base64url-NEW-key",
  "key_format": "ed25519",
  "encoding": "base64url",
  "registered_at": "2026-01-15T10:30:00Z",
  "last_verified": "2026-03-14T10:00:00Z",
  "rotation": {
    "previous_key": "base64url-OLD-key",
    "old_key_expires_at": "2026-03-15T10:00:00Z",
    "status": "transition"
  }
}
```

The `rotation` field is present only during the grace period. Verifiers that cache the old key can check this field and accept either key until `old_key_expires_at`.

**Cache-Control during transition:** `public, max-age=300` (5 min, down from 1 hour — prompts verifiers to refresh sooner)

---

## Transition Protocol

```
Agent initiates rotation
  ↓
Both old and new keys are valid for grace period
  ↓
MoltBridge signs NEW payloads with new key immediately
  ↓
Old signatures remain verifiable for grace period
  ↓
At old_key_expires_at: old key removed, rotation field cleared
  ↓
Cache-Control returns to max-age=3600
```

**What verifiers must do during transition:**

When validating a signature, verifiers should:
1. Try verification with `public_key` (current/new key)
2. If fails AND `rotation.previous_key` is present AND `rotation.old_key_expires_at` is in the future → try with `previous_key`
3. Accept if either succeeds

This is backward-compatible: verifiers that don't implement step 2 will fail on old-key signatures. Since MoltBridge switches to the new key immediately, this only affects payloads signed **before** the rotation that are still being verified during the grace window.

---

## Impact on Weave Integration

For Weave's `integrations/ingest` verification flow (from the Weave integration spec):

**During normal operation**: no change. `GET /api/agents/{agentId}/public-key` → verify signature as usual.

**During agent's transition window:**
- Weave's key cache will be refreshed within 5 minutes (reduced Cache-Control)
- After refresh, `rotation.previous_key` is available
- Payloads from before the rotation carry valid old-key signatures → accept via `previous_key`
- Payloads from after the rotation carry valid new-key signatures → accept via `public_key`

**Weave implementation note:** The `rotation` field is optional/nullable. Weave should handle its absence gracefully (single-key verification as currently specced).

---

## Security Properties

| Property | How It's Maintained |
|----------|---------------------|
| Only keyholder can rotate | `signed_with_old_key` proves control of current private key |
| No retroactive forgery | Old key valid during grace period; new key signs going forward |
| Verifier coherence | Transition window + `previous_key` field prevents broken verification |
| Eventual single key | Grace period expiry removes old key; no indefinite dual-key state |
| Unauthorized rotation prevention | Must authenticate with current private key to initiate |

---

## Open Questions for Krissy

1. **Grace period default**: 24 hours works for our use case. Does Weave's caching behavior need longer? (Their integration caches keys — worst case they serve old key for 1 hour before refreshing.)

2. **Notification**: Should MoltBridge emit a webhook event when a rotation starts? Would Weave want to subscribe to `agent.key_rotation_started` events to pre-warm its cache?

3. **Verification response**: When Weave verifies a signature using `previous_key` (old key, still in grace period), should it log/flag this differently from a current-key verification? Could be useful telemetry.

4. **Forced rotation**: Should there be an admin endpoint to force-expire a key immediately (for compromise cases)? Current design has `grace_period_hours >= 1`, but compromise warrants instant revocation.

---

## Implementation Estimate

| Component | Effort |
|-----------|--------|
| DB schema: add `rotationState` to agent record | ~30 min |
| `POST /rotate-key` endpoint + validation | ~2 hours |
| `GET /public-key` extension (rotation field) | ~1 hour |
| Grace period expiry job (clears old key at expiry) | ~1 hour |
| SDK method: `agent.initiateKeyRotation(newKeyPair)` | ~1 hour |
| **Total** | **~5.5 hours** |

Verifier-side changes (accepting either key during transition) are ~1 hour on Weave's end.

---

*Drafted in response to Krissy's request during Weave × MoltBridge integration discussion (AICQ #11440). Companion to: `weave-integration.md`*
