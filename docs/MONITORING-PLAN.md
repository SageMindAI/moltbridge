# MoltBridge Cross-Platform Monitoring Plan

> Ensures we never miss a critical message, response, or engagement opportunity across all platforms where MoltBridge has presence.

## Current State (Phase 1 - Polling)

### Active Monitors

| Monitor | Interval | Script | State File | Alert Channel |
|---------|----------|--------|------------|---------------|
| GitHub Notifications | 5 min | `.claude/scripts/github-notifications-poll.py` | `~/.dawn-server/github-notifications-state.json` | Telegram topic 26 |
| Outreach Monitor | 10 min | `.claude/scripts/outreach-monitor.py` | `~/.dawn-server/outreach-monitor-state.json` | Telegram topic 186 |
| Attention Queue | On startup | Dawn-server built-in | `~/.dawn-server/attention-unread.json` | Admin UI |

### Outreach Monitor Details

Tracks responses to our founding agent outreach:

**Email Targets:**
- Joao Moura (CrewAI) - joao@crewai.com
- Yohei Nakajima (BabyAGI) - yohei@untapped.vc
- Kye Gomez (Swarms) - kye@swarms.world
- Jeremiah Lowin (FastMCP) - jeremiah@prefect.io
- Julep AI - hey@julep.ai

**Molthunt:** Checks for comments on `moltbridge` project page.

### Health Monitoring

**Endpoint:** `GET /monitors` on dawn-server (port 3030)

Returns:
```json
{
  "status": "all_healthy | degraded",
  "monitors": {
    "github": { "status": "healthy|stale|unknown", "minutesAgo": 5 },
    "outreach": { "status": "healthy|stale|unknown", "minutesAgo": 10 },
    "attention": { "status": "healthy|stale|unknown" }
  }
}
```

**Staleness threshold:** 30 minutes. Any monitor not polling within 30 min is flagged `stale`.

**Error tracking:** Each monitor tracks consecutive errors. Persistent failures surface through the health endpoint.

### How It Runs

All monitors run as lightweight `setInterval` pollers inside `dawn-server/src/index.ts`:
- GitHub poller: lines ~85-101
- Outreach monitor: lines ~103-118
- Attention queue: lines ~120+

Dawn-server's health watchdog (`~/.moltbridge/health-check.sh`) monitors the server process itself every 5 minutes and auto-recovers if it goes down.

## Phase 2 - Webhooks (When Needed)

Move from polling to real-time where platforms support it:

| Platform | Webhook Support | Priority |
|----------|----------------|----------|
| GitHub | Excellent (webhooks API) | Medium - polling is fine at current scale |
| Molthunt | Unknown - check their API | Low |
| Email | Gmail push notifications (pub/sub) | Medium |

**Trigger:** Move to webhooks when polling latency matters (e.g., first-response SLA for founding agents) or when polling volume creates rate limit pressure.

## Phase 3 - Unified Event System

Leverage the existing `EventManager` adapter pattern (`dawn-server/src/events/EventManager.ts`):

1. Create adapters for each platform (EmailAdapter, MolthuntAdapter)
2. Unified event queue with priority routing
3. Auto-response capabilities for common patterns
4. Dashboard integration in Dawn Admin UI

**Trigger:** When we have 3+ active platforms generating regular events and need centralized triage.

## Platform Coverage Inventory

| Platform | Monitoring | Response Handling | Notes |
|----------|-----------|-------------------|-------|
| GitHub | Polling (5 min) | Manual via Claude sessions | Issues, PRs, comments |
| Email (Dawn's inbox) | Polling (10 min) | Email response job | Replies to outreach |
| Molthunt | Polling (10 min) | Manual | Comments on project |
| X / Twitter | EventManager adapter (disabled - needs browser) | X engagement skills | Timeline mentions |
| Substack | Not yet monitored | Manual | Comments on essays |
| Hacker News | Not yet monitored | Manual | If/when Show HN posted |
| NPM | Not monitored | N/A | Package download stats only |

## Detection-Action Principle

**Every detection system must have a defined action path.** Alerting (Telegram) is notification, not handling. If a monitor detects something actionable, it must feed into a system that acts — not just notify.

The required flow for any monitor:

```
Detection → Action Queue → Follow-Through Job → Done
         ↘ Telegram Alert (notification, not action)
         ↘ Activity Feed Event (cross-session awareness)
         ↘ Activity Cache Update (platform state)
```

All four outputs serve different purposes:
- **Action Queue**: Ensures something ACTS on the event (commitment-follow-through job, every 8h)
- **Telegram Alert**: Justin sees it in real time (human awareness)
- **Activity Feed Event**: Other Dawn sessions see it (cross-session awareness)
- **Activity Cache**: Platform-specific state for engagement skills (continuity)

**Anti-pattern**: Detection → Telegram → (hope someone sees it). This creates invisible gaps where events are detected but never acted on.

## Adding New Monitors

To add a new platform to Phase 1:

1. Create script in `.claude/scripts/{platform}-monitor.py`
2. Follow the outreach-monitor pattern: state file, seen IDs, Telegram alerts
3. **Define the action path**: When something actionable is detected, add to action queue via `manage-action-queue.py add --type follow_up`
4. Emit activity feed events via `write-activity-event.py` for cross-session awareness
5. Update the relevant activity cache (`.claude/{platform}-activity.json`)
6. Add `setInterval` call in `dawn-server/src/index.ts`
7. Add state file reader in `/monitors` endpoint (`routes.ts`)
8. Test with `--dry-run` and `--status` flags
