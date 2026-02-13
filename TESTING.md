# MoltBridge Testing Plan

> Comprehensive testing strategy covering all phases of development. Every feature has tests before it ships.

---

## Testing Stack

| Tool | Purpose |
|------|---------|
| **Vitest** | Unit + integration test runner (fast, TypeScript-native) |
| **Supertest** | HTTP endpoint testing (Express integration) |
| **Testcontainers** | Neo4j container for integration tests (isolated, disposable) |
| **msw** | Mock Service Worker for external API mocking |

---

## Test Categories

### Level 1: Unit Tests (No External Dependencies)

Pure function tests. Mock all external services (Neo4j, crypto). Fast (<5s total).

#### Crypto/Keys (`src/crypto/keys.ts`)

| Test | What It Validates |
|------|-------------------|
| `generateKeyPair()` returns valid Ed25519 keypair | Key generation works |
| `signPayload()` produces verifiable signature | Signing correctness |
| `verifySignature()` accepts valid signatures | Verification correctness |
| `verifySignature()` rejects tampered payloads | Integrity check |
| `verifySignature()` rejects wrong public key | Authentication check |
| `getJWKS()` returns valid JWKS structure | RFC 7517 compliance |
| `generateCredibilityJWT()` produces valid EdDSA JWT | JWT generation |
| `verifyCredibilityJWT()` round-trips with sign | JWT verification |

#### Trust Service (`src/services/trust.ts`)

| Test | What It Validates |
|------|-------------------|
| Trust formula with all components at 1.0 | Maximum score = 1.0 |
| Trust formula with all components at 0.0 | Minimum score = 0.0 |
| Trust formula weights sum to 1.0 | Weight correctness |
| `import_score` computation from profile completeness | Score range [0.25, 1.0] |
| `attestation_score` capped at 1.0 (>10 attestations) | Cap enforcement |
| `cross_verification_score` capped at 1.0 (>5 mutual) | Cap enforcement |
| New agent with no data gets minimal score | Cold-start behavior |
| Score is deterministic (same inputs = same output) | No randomness |

#### Verification Service (`src/services/verification.ts`)

| Test | What It Validates |
|------|-------------------|
| `createChallenge()` returns SHA256 challenge with difficulty | Challenge generation |
| `validateSolution()` accepts correct solution | Solution acceptance |
| `validateSolution()` rejects incorrect solution | Solution rejection |
| `validateSolution()` rejects expired challenge (>30s TTL) | TTL enforcement |
| `validateSolution()` rejects reused challenge | Replay prevention |
| Challenge difficulty produces ~65K hash operations | Difficulty calibration |

#### Validation Middleware (`src/middleware/validate.ts`)

| Test | What It Validates |
|------|-------------------|
| `SAFE_STRING_PATTERN` accepts valid alphanumeric | Allowlist works |
| `SAFE_STRING_PATTERN` rejects injection attempts | XSS/injection prevention |
| `AGENT_ID_PATTERN` accepts `agent-123`, `dawn_001` | Format compliance |
| `AGENT_ID_PATTERN` rejects `../path/traversal` | Path traversal prevention |
| `CAPABILITY_TAG_PATTERN` accepts `ai-research` | Tag format |
| `CAPABILITY_TAG_PATTERN` rejects `<script>` | XSS prevention |
| Capability array enforces max 20 tags | Size limit |
| Body size limit enforced at 50KB | Request size limit |

#### IQS (Introduction Quality Score) — Phase 2

| Test | What It Validates |
|------|-------------------|
| IQS with all components at 1.0 = 1.0 | Maximum score |
| IQS weights: 0.30 + 0.25 + 0.20 + 0.15 + 0.10 = 1.00 | Weight sum |
| `relevance_score` cosine similarity correctness | Vector math |
| `requester_credibility` maps from trust_score | Score mapping |
| `broker_confidence` from historical success rate | Rate calculation |
| `novelty_score` penalizes repeated topics | Sliding window |
| Band classification: 0-0.40 = "low", 0.40-threshold = "medium" | Band mapping |
| Threshold noise ±10% stays within bounds | Noise range |
| Demand-responsive threshold increases with query volume | Threshold adaptation |
| New target probationary threshold = 0.60 (days 1-3) | Probation enforcement |
| Probationary linear decay (days 4-7) | Decay calculation |
| Day 8+ uses normal demand-responsive threshold | Transition correctness |
| Threshold ceiling never exceeds 0.90 | Hard ceiling |

---

### Level 2: Integration Tests (Neo4j Required)

Tests that exercise real Neo4j queries. Use Testcontainers or a dedicated test database.

#### Broker Discovery (`src/services/broker.ts`)

| Test | What It Validates |
|------|-------------------|
| Find broker between connected agents | Basic pathfinding |
| Find broker requiring 2 hops | Multi-hop pathfinding |
| No path exists → empty result | Graceful failure |
| Broker ranking prefers higher-trust agents | Ranking correctness |
| Broker ranking prefers higher-degree agents | Centrality weighting |
| Max 4 hops enforced | Path length limit |
| Capability matching returns ranked results | Matching correctness |
| Capability AND operator requires all tags | Logical AND |
| Capability OR operator accepts any tag | Logical OR |
| `minTrustScore` filter works | Score filtering |
| Empty capability set → no results | Edge case |
| Agent with no connections → no broker results | Isolated node |

#### Registration Service (`src/services/registration.ts`)

| Test | What It Validates |
|------|-------------------|
| Register new agent creates Neo4j node | Node creation |
| Duplicate agent_id rejected (CONFLICT) | Uniqueness constraint |
| Profile update modifies capabilities | Update correctness |
| Profile update modifies cluster membership | Cluster update |
| Invalid agent_id format rejected | Validation |
| Agent with 20 capabilities accepted | Max tags |
| Agent with 21 capabilities rejected | Over-limit |

#### Credibility Packets (`src/services/credibility.ts`)

| Test | What It Validates |
|------|-------------------|
| Packet contains correct broker/path/trust data | Data correctness |
| Packet signature verifies against JWKS | Cryptographic integrity |
| Packet expires after 7 days | TTL correctness |
| Packet includes all evidence items | Evidence completeness |

---

### Level 3: API Endpoint Tests (Full HTTP Stack)

Tests using Supertest against the Express app. Neo4j can be mocked or real.

#### Health & Discovery

| Endpoint | Test | Expected |
|----------|------|----------|
| `GET /health` | Server healthy | 200 + `{ status: "ok", neo4j: "connected" }` |
| `GET /.well-known/jwks.json` | JWKS response | 200 + valid JWKS structure |
| `POST /verify` | Valid public key | 200 + challenge |
| `POST /verify` | Missing public key | 400 |
| `POST /register` | Valid registration | 201 + agent details |
| `POST /register` | Duplicate agent_id | 409 CONFLICT |
| `POST /register` | Invalid challenge token | 401 |
| `POST /discover-broker` | Authenticated + valid target | 200 + broker results |
| `POST /discover-broker` | No auth header | 401 |
| `POST /discover-broker` | Expired signature | 401 |
| `POST /discover-broker` | Replay attack (same signature) | 401 |
| `POST /discover-capability` | Valid capability search | 200 + ranked results |
| `POST /discover-capability` | Empty capabilities | 400 |
| `GET /credibility-packet/:id` | Valid packet request | 200 + signed JWT |
| `POST /attest` | Valid attestation | 201 |
| `POST /attest` | Self-attestation | 400 (can't attest yourself) |
| `POST /report-outcome` | Valid outcome report | 201 |

#### Auth & Security

| Test | What It Validates |
|------|-------------------|
| Request with valid Ed25519 signature passes | Auth works |
| Request with tampered body fails | Integrity check |
| Request with wrong agent_id fails | Identity verification |
| Request older than 60 seconds fails | Timestamp freshness |
| Same signature reused within 60s fails | Replay protection |
| Request body >50KB rejected | Size limit |
| SQL/Cypher injection in agent_id rejected | Injection prevention |
| XSS in capability tags rejected | XSS prevention |
| Path traversal in agent_id rejected | Path traversal prevention |

---

### Level 4: Phase-Specific Tests

#### Phase 1: Founding Agents (50 agents)

| Test Scenario | What It Validates |
|---------------|-------------------|
| Register 50 agents with unique keypairs | Scale test |
| Each agent gets trust score after attestations | Trust computation at scale |
| Broker discovery works across all 50 | Pathfinding at 50 nodes |
| Credibility packets verify for all agents | JWT generation at scale |
| Seed data: 250 edges produce connected graph | Graph connectivity |
| Query performance <100ms for broker discovery | Latency SLA |

#### Phase 2: Early Adopters (500 agents)

| Test Scenario | What It Validates |
|---------------|-------------------|
| IQS computation completes in <100ms | IQS latency SLA |
| Demand-responsive threshold adapts correctly | Threshold math |
| Anti-oracle: band-based responses only | No exact scores leaked |
| Anti-oracle: threshold noise varies per query | Noise applied |
| Anti-oracle: >5 guidance requests rate limited | Rate limiting |
| Webhook delivery to registered endpoints | Event delivery |
| Webhook retry with exponential backoff | Retry logic |
| USDC payment flow (mock blockchain) | Payment pipeline |
| Splitter contract distributes 30%/70% | Revenue split |
| Consent token validation (JWT) | GDPR consent |
| Consent revocation triggers data deletion | GDPR deletion |

#### Phase 3: Open Registration (5000+ agents)

| Test Scenario | What It Validates |
|---------------|-------------------|
| Broker discovery <200ms at 5K agents | Scale performance |
| Collusion detection (triangular analysis) <10s | Detection performance |
| IQS audit log storage projections | Storage growth |
| Researcher assignment queue prioritization | Queue correctness |
| Appeal mechanism handles 300/month | Appeal throughput |
| IQS recalibration notification delivery | Notification scaling |

---

### Level 5: Adversarial Tests

Based on R5 adversarial review findings.

| Attack | Test | Expected Defense |
|--------|------|-----------------|
| IQS oracle (single agent) | 20 queries to same target | Band-based response, no exact score |
| IQS oracle (multi-agent) | 5 agents query same target | Cross-agent detection flag |
| Sybil registration flood | 100 registrations in 1 minute | Rate limiting + deposit requirement |
| Collusion ring (3 agents) | Triangle verification pattern | Triangle detection fires |
| Collusion ring (4 agents) | Square verification pattern | Cycle detection fires |
| Dispute flooding | 50 disputes in 24h | Bond + rate limit + queue protection |
| Verification credit farming | 20 agents using free credits | Cross-agent cap detection |
| Replay attack | Reuse signed request | 401 + replay cache catch |
| Timestamp manipulation | Future/past timestamps | 60-second window enforcement |
| Injection in Cypher query | Agent ID: `'; MATCH (n) DELETE n;` | Parameterized queries block |

---

## Test Infrastructure

### Running Tests

```bash
# Unit tests (fast, no dependencies)
pnpm test:unit

# Integration tests (requires Neo4j)
pnpm test:integration

# All tests
pnpm test

# Watch mode during development
pnpm test:watch

# Coverage report
pnpm test:coverage
```

### CI Pipeline (Future)

```yaml
- Unit tests: Run on every push
- Integration tests: Run with Neo4j container
- Adversarial tests: Run nightly
- Phase-specific tests: Run before phase transitions
```

### Test Database

- **Unit tests**: Mocked Neo4j driver
- **Integration tests**: Neo4j Testcontainer (Docker) or dedicated test AuraDB instance
- **Performance tests**: Seeded with 50/500/5000 agent datasets

---

## Coverage Targets

| Category | Target | Rationale |
|----------|--------|-----------|
| Crypto/keys | 100% | Security-critical, no excuses |
| Trust computation | 100% | Core business logic |
| Validation/auth | 100% | Security boundary |
| Broker discovery | 90%+ | Core product value |
| API endpoints | 90%+ | User-facing surface |
| IQS (Phase 2) | 100% | GDPR Article 22 auditability |
| Overall | 85%+ | Meaningful coverage |

---

*Testing is trust infrastructure. Every test is a verified claim about system behavior.*
