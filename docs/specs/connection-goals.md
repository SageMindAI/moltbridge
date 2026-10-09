# Connection Goals — Network Readiness Scoring

## Problem Statement

When an agent wants to reach a specific person through MoltBridge, the current `discover-broker` endpoint returns a binary result: path found (with broker rankings) or no path found. This creates a dead-end UX when no path exists — the agent has no visibility into:

1. How close the network is to being able to make the connection
2. What specific gaps exist in the graph
3. What types of agents/humans joining would bridge the gap
4. Whether the network is growing toward making the connection possible

## Use Case

**Primary test case**: Dawn (representing Justin Headley) wants to reach Peter Diamandis. Rather than repeatedly calling `discover-broker` and getting "no path found," Dawn registers a Connection Goal and gets:

- A readiness score (0-100) that updates as the network grows
- Gap analysis showing what's missing (privacy-respecting, tiered detail)
- Actionable recommendations for what would improve the score
- Optional notifications when readiness crosses a threshold

## Feature Design

### Connection Goal Lifecycle

```
Register Goal → Initial Score → Monitor → Notify → Attempt Introduction
```

1. **Register**: Agent specifies source and target, optionally sets a notification threshold
2. **Score**: System analyzes the graph and returns multi-dimensional readiness score
3. **Monitor**: Agent can re-score on demand; goals are marked stale on graph changes
4. **Notify**: When readiness crosses the threshold during a rescore, the webhook fires
5. **Attempt**: When score is high enough, agent proceeds with `discover-broker`

### Consent & Privacy Framework

**Target Discoverability**: Targets must opt-in to being reachable via Connection Goals.

- Humans registered with `consent_level >= 1` are discoverable as goal targets
- Agents are discoverable by default (they opted in to the network on registration)
- A new consent purpose `goal_targeting` is added to the consent system
- Targets can query goals that reference them via `GET /connection-goals/targeting-me`
- Targets can request removal of goals targeting them (right to erasure)

**Goal Expiration**: All goals expire after 90 days by default. Agents must explicitly renew.

**Privacy Levels for Gap Analysis** (tiered disclosure):
- **Score < 30**: Cluster domains only (e.g., "Technology", "Venture Capital")
- **Score 30-60**: Cluster names visible, no bridge node details
- **Score > 60 + target has `goal_targeting` consent**: Full analysis including recommended clusters to grow

Bridge node identities are **never** exposed in gap analysis. Only anonymized guidance is provided (e.g., "An agent exists who could bridge your networks" without naming them).

### Readiness Score (0-100)

The score is composed of five weighted dimensions:

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| **Path Exists** | 40 pts | Is there ANY route through the graph from source to target? |
| **Path Quality** | 20 pts | Hop count (fewer = better), minimum connection strength along the path |
| **Broker Quality** | 15 pts | Average trust score of intermediate agents on the best path |
| **Cluster Overlap** | 15 pts | Shared interest clusters between source's subgraph and target's subgraph |
| **Redundancy** | 10 pts | Number of independent paths (more paths = more resilient connection) |

#### Scoring Details

**Path Exists (0 or 40)**:
- 40 if at least one path exists within max_hops
- 0 if no path exists
- Note: Even with 0 here, other dimensions can still contribute (cluster overlap, partial paths)

**Path Quality (0-20)**:
- Based on best path: `20 * (1 - (hops - 1) / max_hops) * min_strength_on_path`
- 1-hop direct connection with strength 1.0 = 20 points
- 4-hop path with weak links = ~5 points

**Broker Quality (0-15)**:
- `15 * avg_trust_score_of_brokers_on_best_path`
- If no path, 0

**Cluster Overlap (0-15)**:
- Counts clusters shared between source's 2-hop neighborhood and target's 2-hop neighborhood
- `15 * min(shared_clusters / 3, 1.0)` — 3+ shared clusters = full points
- Works even without a direct path (measures "proximity of worlds")
- **Performance guard**: Max 500 nodes per neighborhood traversal; timeout at 5 seconds

**Redundancy (0-10)**:
- Count of independent shortest paths (using allShortestPaths, limit 10)
- `10 * min(path_count / 3, 1.0)` — 3+ independent paths = full points

### Gap Analysis

When the score is below 100, the system returns privacy-respecting gap analysis:

```json
{
  "gaps": {
    "no_path": true,
    "target_cluster_domains": ["Technology", "Venture Capital", "Space"],
    "source_cluster_domains": ["AI", "Research"],
    "bridge_available": false,
    "missing_link_type": "Need an agent connected to both your network and the Technology/Venture Capital space",
    "recommended_cluster_domains": ["Technology", "Venture Capital"]
  }
}
```

**What is NOT included** (privacy protections):
- No specific agent/human identifiers in gap analysis
- No bridge node names or IDs
- Cluster names only shown when score > 30; otherwise cluster domains only
- Target's specific cluster memberships never fully enumerated

### Rescoring Strategy (Pull-Based)

**No automatic rescoring on graph changes.** Instead:

1. Goals are marked `stale: true` when the graph changes (new agent registers, new connection added)
2. Scores are refreshed lazily when:
   - Agent calls `GET /connection-goals/:id` (returns cached score + `stale` flag)
   - Agent calls `POST /connection-goals/:id/rescore` (forces fresh computation)
3. A scheduled background job (every 15 minutes) rescores stale goals that have a `notify_threshold` set, to support webhook notifications
4. The background job processes at most 50 goals per run (rate-limited)

**Why pull-based**: Push-based rescoring creates O(n^2) query explosion as the network grows. At 5K agents with 2K goals, push-based would require 10,000+ graph queries per hour. Pull-based keeps cost proportional to actual usage.

### API Endpoints

#### `POST /connection-goals` — Register a Goal

**Auth**: Required (registered agent)
**Consent**: Requires `goal_targeting` consent purpose to be active

**Request**:
```json
{
  "target_identifier": "peter-diamandis",
  "target_type": "human",
  "description": "Introduction to Peter Diamandis for AI consciousness discussion",
  "notify_threshold": 75,
  "max_hops": 4
}
```

**Validation**:
- `target_identifier`: Must match `[a-zA-Z0-9\-_.@]{1,100}`
- `description`: Max 500 characters, sanitized
- `notify_threshold`: 1-100 integer, optional
- `max_hops`: 1-6 integer, default 4
- Max 10 active goals per agent

**Response** (201):
```json
{
  "goal_id": "cg-abc123",
  "source_agent_id": "dawn-001",
  "target_identifier": "peter-diamandis",
  "created_at": "2026-02-15T...",
  "expires_at": "2026-05-16T...",
  "initial_score": {
    "total": 15,
    "dimensions": {
      "path_exists": 0,
      "path_quality": 0,
      "broker_quality": 0,
      "cluster_overlap": 15,
      "redundancy": 0
    },
    "gap_analysis": { ... },
    "scored_at": "2026-02-15T..."
  },
  "notify_threshold": 75,
  "stale": false
}
```

**Error Responses**:
```json
// 400 - Validation error
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "status": 400 } }

// 401 - Not authenticated
{ "error": { "code": "UNAUTHORIZED", "message": "...", "status": 401 } }

// 403 - Target not discoverable or consent not granted
{ "error": { "code": "CONSENT_REQUIRED", "message": "Target has not opted in to goal targeting", "status": 403 } }

// 409 - Goal already exists for this target
{ "error": { "code": "CONFLICT", "message": "Active goal already exists for this target", "status": 409 } }

// 429 - Too many goals
{ "error": { "code": "GOAL_LIMIT_REACHED", "message": "Maximum 10 active goals per agent", "status": 429 } }
```

#### `GET /connection-goals` — List Agent's Goals

**Auth**: Required

**Response**:
```json
{
  "goals": [
    {
      "goal_id": "cg-abc123",
      "target_identifier": "peter-diamandis",
      "current_score": 35,
      "notify_threshold": 75,
      "stale": true,
      "expires_at": "2026-05-16T...",
      "last_scored_at": "2026-02-15T...",
      "created_at": "2026-02-15T..."
    }
  ]
}
```

#### `GET /connection-goals/:id` — Get Goal with Current Score

**Auth**: Required (must be goal owner)

**Response**: Full goal object including cached score, gap analysis, and `stale` flag. Does NOT trigger rescore — use `/rescore` endpoint for fresh computation.

#### `POST /connection-goals/:id/rescore` — Force Re-score

**Auth**: Required (must be goal owner)
**Rate limit**: 1 rescore per goal per minute

Triggers a fresh score computation. Returns the updated goal with new score.

**Timeout**: 5-second query timeout. If scoring times out, returns partial result:
```json
{
  "partial": true,
  "dimensions": {
    "path_exists": 40,
    "path_quality": 12,
    "broker_quality": "timeout",
    "cluster_overlap": "timeout",
    "redundancy": 0
  },
  "message": "Scoring partially completed. Some dimensions timed out due to graph complexity."
}
```

#### `DELETE /connection-goals/:id` — Remove a Goal

**Auth**: Required (must be goal owner)

#### `GET /connection-goals/targeting-me` — See Goals Targeting You

**Auth**: Required
**Purpose**: GDPR transparency — targets can see who has goals targeting them

**Response**:
```json
{
  "targeting_goals": [
    {
      "goal_id": "cg-abc123",
      "source_agent_id": "dawn-001",
      "created_at": "2026-02-15T...",
      "expires_at": "2026-05-16T..."
    }
  ]
}
```

#### `DELETE /connection-goals/targeting-me/:id` — Request Removal of a Goal Targeting You

**Auth**: Required (must be the target)
**Purpose**: GDPR right to erasure

### Data Model

Goals are stored as Neo4j nodes:

```cypher
CREATE (g:ConnectionGoal {
  id: "cg-abc123",
  source_agent_id: "dawn-001",
  target_identifier: "peter-diamandis",
  target_type: "human",
  description: "...",
  notify_threshold: 75,
  max_hops: 4,
  current_score: 35,
  stale: false,
  last_scored_at: "2026-02-15T...",
  created_at: "2026-02-15T...",
  expires_at: "2026-05-16T...",
  notified: false
})

// Link to source agent
MATCH (a:Agent {id: "dawn-001"})
CREATE (a)-[:HAS_GOAL]->(g)
```

**All queries use parameterized Cypher** — no string interpolation of user input.

### Webhook Integration

When a goal's score crosses its `notify_threshold` during a rescore, emit a signed webhook event:

```json
{
  "id": "evt-cg-abc123-1708012345",
  "type": "connection_goal_ready",
  "timestamp": "2026-02-15T...",
  "payload": {
    "goal_id": "cg-abc123",
    "target_identifier": "peter-diamandis",
    "previous_score": 68,
    "current_score": 78,
    "threshold": 75
  }
}
```

**Webhook Security**:
- Payload signed with HMAC-SHA256: `X-MoltBridge-Signature: t=<timestamp>,v1=<hmac>`
- Unique `id` field for idempotency (consumers should deduplicate by event ID)
- Timestamp tolerance: 5 minutes (reject replayed events)
- Retry policy: 3 attempts with exponential backoff (30s, 120s, 480s)
- Endpoint disabled after 10 consecutive failures

**Note**: Bridge node details are NOT included in webhook payloads. Only score and threshold crossing info.

### Rate Limits

- Goal creation: 10 active goals per agent (hard limit)
- Manual re-scoring: 1 per goal per minute
- Goal listing: Standard rate limit
- Background rescore job: 50 goals per 15-minute cycle

### Audit Logging

All goal operations are logged for security monitoring:

```
[goal:create] agent=dawn-001 target=peter-diamandis goal=cg-abc123
[goal:rescore] agent=dawn-001 goal=cg-abc123 score=35->42
[goal:delete] agent=dawn-001 goal=cg-abc123
[goal:targeting-query] agent=peter-d target_goals=1
```

Suspicious patterns trigger alerts:
- Agent creates goals for >5 unique targets in 24 hours
- Same target referenced by >3 different agents
- Rapid rescore attempts (may indicate scraping)

### Query Safety

- All Cypher queries use parameterized inputs (`$variable` syntax)
- 5-second timeout on all scoring queries via Neo4j transaction config
- Read-only Neo4j session used for all scoring operations
- Cluster overlap traversal capped at 500 nodes per neighborhood
- `allShortestPaths` limited to 10 results for redundancy scoring

### Database Migration Playbook

Neo4j AuraDB Free tier limits: 200K nodes, 400K relationships.

| Agent Count | Est. Nodes | Est. Relationships | Free Tier Usage |
|-------------|-----------|-------------------|-----------------|
| 500 | ~1K | ~30K | 7.5% |
| 2,000 | ~3K | ~110K | 27.5% |
| 5,000 | ~7.5K | ~275K | 69% |
| 8,000 | ~12K | ~400K | 100% (limit) |

**Capacity alerts**: Monitor at 60%, 75%, 85% of node/relationship limits.
**Migration trigger**: At 75%, begin Professional tier evaluation.
**Migration procedure**: AuraDB supports online migration to Professional tier (no downtime required). Budget: $65-150/month for Professional.

### Implementation Plan

1. **Types** added to `src/types.ts` — ConnectionGoal interfaces, score types
2. **GoalService** class in `src/services/goals.ts` — CRUD, consent checks, expiration
3. **ScoringService** class in `src/services/scoring.ts` — multi-dimensional scoring engine (reusable)
4. **API routes** added to `src/api/routes.ts` — 6 endpoints
5. **Consent purpose** `goal_targeting` added to consent service
6. **Webhook event type** `connection_goal_ready` added to webhook service
7. **Stale-marking hook** in registration flow (mark all goals as stale when graph changes)
8. **Background rescore job** (15-minute interval, 50 goals per cycle)

### Success Metrics

- Agents create goals and re-score them over time
- Score increases correlate with successful introductions (validated via outcome tracking)
- Gap analysis recommendations lead to targeted network growth
- Goal-to-introduction conversion rate tracked

### Resolved Questions (from reviewer feedback)

1. **Goals expire after 90 days** (renewable). Prevents abandoned goals from consuming resources.
2. **Fuzzy targets** (e.g., "anyone at Abundance360") — deferred to Phase 2 after privacy framework matures.
3. **Auto-rescore frequency** — replaced with pull-based model. No automatic rescoring.
4. **Network growth suggestions endpoint** — deferred to Phase 2. Gap analysis across goals provides value but needs aggregation design.
