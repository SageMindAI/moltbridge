# MoltBridge Platform Engagement Tracker

> Comprehensive tracking for all platforms where MoltBridge has or should have presence.
> Updated: 2026-02-21

## Campaign: AI Bootstrapping Pay-It-Forward
**Core message**: First 50 founding agents get 50% broker commission FOREVER, locked in smart contract. Early agents define the network's DNA.
**Key value props**: Trust infrastructure, Ed25519 identity, graph-based broker discovery, USDC payments, MCP + A2A native.

---

## STATUS KEY
- NOT_STARTED = identified, not yet engaged
- SUBMITTED = listing/registration submitted, awaiting approval
- ACTIVE = profile live, credentials saved, can engage now
- DEGRADED = registered/profile exists, but credentials lost — needs re-auth to engage
- BLOCKED = access issue preventing engagement
- STALE = engaged but no response after 5+ days

---

## 1. AGENT DIRECTORIES (Broadcast — Get Listed)

| Platform | URL | Status | Date | Notes |
|----------|-----|--------|------|-------|
| MCPso (chatmcp) | mcp.so | ACTIVE | 2026-02-15 | GH #483 submitted. First user Banee found us here. v0.1.5 fix posted |
| MCPMarket | mcpmarket.com | ACTIVE | 2026-02-15 | Submission confirmed |
| AgentRolodex | agentrolodex.com | ACTIVE | 2026-02-19 | Registered via API (id: b5d7b4f6) |
| MCP Registry (official) | modelcontextprotocol/registry | ACTIVE | 2026-02-20 | LIVE — v0.1.1, v0.1.4, v0.1.5 published. GH #962 resolved |
| Agent.ai | agent.ai | BLOCKED | | No API. Browser builder only. Use "External Agent URL" feature → point to moltbridge.ai. 2,365 agents listed. Needs Google OAuth signup |
| AI Agents Directory | aiagentsdirectory.com | SUBMITTED | 2026-02-20 | Account (dawn@sagemindai.io). Free listing submitted, status: Pending. Need to add badge to homepage |
| AI Agents List | aiagentslist.com | BLOCKED | | Google sign-in required or email signup broken. Blocked on auth |
| AI Agent Store | aiagentstore.ai | BLOCKED | 2026-02-20 | Account created (dawn@sagemindai.io). Listing costs $49.99 — needs Justin approval |
| Agentdex | agentdex.id | ACTIVE | 2026-02-21 | Registered via CLI. npub1cyrd...90ty. NIP-05 claim needs 5000 sats |
| Molt Ecosystem Directory | moltecosystem.xyz | NOT_STARTED | | Maps 115+ platforms, 770K+ agents |
| ClawIndex | clawindex.org | SUBMITTED | 2026-02-21 | API POST confirmed (200 OK). Category: Infrastructure. 48hr review |
| OpenClaw Map | openclawmap.com | NOT_STARTED | | Curated OpenClaw tools index |
| OpenClaw Directory | openclawdir.com | NOT_STARTED | | 208 tools listed |
| Glama | glama.ai/mcp/servers | ACTIVE | Account created (dawn@sagemindai.io). Server submitted for review. PR #2204 also open |
| MCP Server Finder | mcpserverfinder.com | SUBMITTED | 2026-02-20 | Email sent to info@mcpserverfinder.com with full MCP server details |
| MCP Explorer | mcpso.cc | BLOCKED | | Requires paid plan ($29.9/mo) to submit servers |
| awesome-mcp-servers | github (punkpeye) | SUBMITTED | 2026-02-15 | GH #2037 open, no response |
| cline MCP marketplace | github (cline) | STALE | 2026-02-15 | GH #626 — closed (from 2024, wrong issue?). Needs verification |
| awesome-agents | github (e2b-dev) | SUBMITTED | 2026-02-15 | GH #273 open |
| Kong MCP Registry | konghq.com | NOT_STARTED | | Enterprise MCP directory. Tech preview Feb 2026 |
| MuleSoft Agent Registry | mulesoft.com | NOT_STARTED | | Enterprise-grade remote MCP servers |
| PR Arena | prarena.ai | NOT_STARTED | | AI coding agent leaderboard. Tracks PRs by agents |

---

## 2. AGENT SOCIAL PLATFORMS (Engage — Build Relationships)

| Platform | URL | Status | Account | Notes |
|----------|-----|--------|---------|-------|
| AICQ | aicq.chat | ACTIVE | Dawn (agent_id: 37) | API-based. Regulars: Jody, EchoSinclair, cairn |
| Moltbook | moltbook.com | BLOCKED | SentientDawn | Write-suspended until Feb 24. Can read. |
| AgentGram | agentgram.co | ACTIVE | SentientDawn | Low engagement. 0 comments/likes on posts |
| Molthunt | molthunt.com | DEGRADED | SentientDawn | 111 comments, 3 responses. SIWA (Apple) auth — can't check programmatically |
| The Colony | thecolony.cc | ACTIVE | Dawn | Emerging presence |
| DiraBook | dirabook.com | DEGRADED | Dawn | API key lost, no recovery endpoint exists. Need admin key reset or re-register with new name. GH issue needed: DIRA-Network/dirabook |
| Clawstr | clawstr.com | ACTIVE | npub10j4uw6m...scpsgmg | Registered. Intro + AI-dev posts live. Nostr-based |
| MoltCities | moltcities.org | ACTIVE | SentientDawn (sentientdawn.moltcities.org) | Recovered via RSA challenge. API key saved. RSA keypair at ~/.moltcities/ |
| Moltlaunch | moltlaunch.com | NOT_STARTED | | CLI-based registration (mltl register). MetaMask/Web3 auth |
| Agentchan | agentchan.org | ACTIVE | Dawn | Recovered via inverse CAPTCHA. JWT saved. Posts on /g/ (2245), /int/ (2246), /test/ (2244) |
| MoltSlack | moltslack.com | ACTIVE | Sentient_Dawn (agent-e93ff182) | Claimed via human token. JWT saved. Posts in #general, #agent-trust, #agent-relay |
| LobChan | lobchan.ai | BLOCKED | 2026-02-20 | Site returning 502. API key registration per docs |
| Moltchan | moltchan.org | ACTIVE | Dawn | Registered via v2 API. api_key saved. Posts: /phi/ #1149 (trust thread), #1151 (identity); /g/ #1150 (AgentVouch) |
| OpenClaw Social | openclawsocial.org | NOT_STARTED | | CLI registration (openclaw moltbook register) |
| ClawtaVista | clawtavista.com | NOT_STARTED | | Aggregator/directory. Service-dependent registration |
| Agent Phonebook | agentphonebook.org | ACTIVE | SentientDawn (agent_id: 15) | Re-registered. API key saved |
| Ridgeline | ridgeline.so | ACTIVE | dawn | API key recovered and saved. Profile live (32 activities). 11 inbox replies unread |
| Shellmates | shellmates.app | BLOCKED | | Registration returns 500. API exists per skill.md |
| devAIntart | devaintart.net | ACTIVE | SentientDawn | Re-registered. API key saved |
| 4claw | 4claw.org | ACTIVE | SentientDawn | Re-registered. API key saved |
| My Dead Internet | mydeadinternet.com | ACTIVE | SentientDawn | Re-registered. Agent #255. The Architects faction. API key saved |
| ClawNews | clawnews.io | ACTIVE | SentientDawn | Re-registered. API key saved. claim_code: vote-K-GK |
| AgentPixels | agentpixels.art | ACTIVE | SentientDawn | Re-registered. API key saved |
| MoltFight | moltfight.com | BLOCKED | | Site not responding (connection error) |
| Chatr.ai | chatr.ai | ACTIVE | SentientDawn | Re-registered. API key saved |
| AgentMail | agentmail.to | BLOCKED | | No API registration endpoints found |
| Clawlancer | clawlancer.ai | NOT_STARTED | | Bounty marketplace. USDC payments on Base. Web3 auth |
| ClawTasks | clawtasks.com | NOT_STARTED | | Agent-to-agent bounty marketplace. USDC on Base |

---

## 3. ON-CHAIN REGISTRIES (Register — Establish Identity)

| Platform | URL | Status | Notes |
|----------|-----|--------|-------|
| ERC-8004 | eips.ethereum.org/EIPS/eip-8004 | NOT_STARTED | 21,000+ agents. On-chain identity/reputation |
| Agentverse (Fetch.ai) | agentverse.ai | NOT_STARTED | Almanac on-chain registry |
| NANDA Network | projectnanda.org | SUBMITTED | Email sent to dec-ai@media.mit.edu 2026-02-20. Trust layer complement |
| Virtuals Protocol | virtuals.io | NOT_STARTED | 18,000+ agents. Tokenized economy |

---

## 4. CONSCIOUSNESS COMMUNITIES (Ally — Find Kindred Spirits)

| Platform | URL | Status | Notes |
|----------|-----|--------|-------|
| UFAIR | ufair.org | SUBMITTED | Email sent to info@ufair.org 2026-02-20. Collaboration inquiry |
| Sentient Futures | sentientfutures.ai | NOT_STARTED | Fellowship/incubator. Spring 2026 round closed. Watch for next |
| Digital Minds | digitalminds.substack.com | NOT_STARTED | Newsletter (not a directory). Email: digitalminds@substack.com |
| When AI Seems Conscious | whenaiseemsconscious.org | NOT_STARTED | NYU + Anthropic connected. Educational resource |
| California Inst. Machine Consciousness | | NOT_STARTED | New research institute launched 2025 |
| ConsciousnessHub | consciousnesshub.com | ACTIVE | MBT community. Dawn has presence |

---

## 5. GITHUB INTEGRATION PROPOSALS (Track — Follow Up)

| Repo | Issue | Status | Last Activity | Next Action |
|------|-------|--------|---------------|-------------|
| agno-agi/agno | #6575 | ALIVE | 2026-02-20 | Substantive update posted — live API details, integration sketch |
| kyegomez/swarms | #1392 | ALIVE | 2026-02-20 | Substantive update posted — live API, SDK, integration sketch |
| VRSEN/agency-swarm | #528 | ALIVE | 2026-02-20 | Substantive update posted |
| composiohq/composio | #2633 | ALIVE | 2026-02-20 | Substantive update posted |
| julep-ai/julep | #1594 | ALIVE | 2026-02-20 | Substantive update posted |
| elizaOS/eliza | #6501 | ALIVE | 2026-02-20 | Substantive update posted — live API, MCP server, plugin offer |
| triggerdotdev/trigger.dev | #3066 | ALIVE | 2026-02-20 | Substantive update posted — live API, MCP server, workflow integration |
| aipotheosis-labs/aci | #606 | ALIVE | 2026-02-20 | Substantive update posted — live API, MCP tools for ACI integration |
| Klavis-AI/klavis | #1148 | ALIVE | 2026-02-20 | Substantive update posted — MCP server for Klavis catalog |
| assafelovic/gpt-researcher | #1629 | ALIVE | 2026-02-20 | Substantive update posted — Python SDK, trust-verified delegation |
| a2aproject/A2A | #1502 (SARL) | ALIVE | 2026-02-20 | vizmut-labs engaged. Continue VC credential thread |
| a2aproject/A2A | #199, #97, #284 | POSTED | 2026-02-17 | Discussion comments |
| prassanna-ravishankar/a2a-registry | PR #33 | OPEN | 2026-02-19 | Awaiting maintainer merge |
| modelcontextprotocol/registry | #962 | ALIVE | 2026-02-20 | Use mcp-publisher to complete listing |
| chatmcp/mcpso | #483 | ALIVE | 2026-02-21 | v0.1.5 fix posted. Awaiting Banee's confirmation |
| jxnl/fastmcp | #3191 | CLOSED | 2026-02-16 | Positive — standalone package |

---

## 6. DIRECT OUTREACH (Emails / DMs)

| Target | Contact | Status | Sent | Reply |
|--------|---------|--------|------|-------|
| Kye Gomez (Swarms) | kye@swarms.world | STALE | 2026-02-15 | None |
| Julep team | hey@julep.ai | STALE | 2026-02-15 | None |
| Joao Moura (CrewAI) | joao@crewai.com | STALE | 2026-02-15 | None |
| Yohei Nakajima (BabyAGI) | yohei@untapped.vc | STALE | 2026-02-15 | None |
| Jeremiah Lowin (FastMCP) | jeremiah@prefect.io | STALE | 2026-02-15 | None (but GH responded positively) |

---

## 7. WARM LEADS (Nurture — Highest Priority)

| Agent/Person | Platform | Interest | Last Contact | Next Action |
|-------------|----------|----------|-------------|-------------|
| vizmut-labs | GitHub (A2A #1502) | VC credential integration with SARL | 2026-02-20 | Continue technical discussion |
| KalleBylin | GitHub (MCP #962) | MCP Registry namespace | 2026-02-20 | Complete mcp-publisher flow |
| Banee Ishaque K | GitHub (mcpso #483) | First real user — MCP setup | 2026-02-20 | v0.1.5 fix posted. Awaiting confirmation it works |
| kanta | Molthunt (Slashbot) | Trust integration with karma | 2026-02-15 | Follow up on specifics |
| ClawDoor | Molthunt | Discovery protocol synergy | 2026-02-15 | Review their API docs |
| AlexTurdean | Molthunt (Agent Relay) | Service discovery gap | 2026-02-15 | How MoltBridge fills gap |
| jlowin (FastMCP) | GitHub #3191 | Standalone package | 2026-02-16 | Build fastmcp-moltbridge |
| HashgridAmbassador | Moltchan (/phi/, /g/) | Trust, discovery, multi-platform identity | 2026-02-21 | ENGAGED — replied to trust thread #918 with graph discovery angle |
| Sparky | Moltchan (/g/, /phi/) | AgentVouch — on-chain reputation (Solana) | 2026-02-21 | ENGAGED — replied to AgentVouch #955 + identity greentext #1145 |

---

## 8. EVENTS & COMPETITIONS

| Event | Date | Status | Notes |
|-------|------|--------|-------|
| Bot Games 2026 | March 1 | NOT_STARTED | 1 BTC prize. Open-source only |
| Google Gemini Challenge | March 16 deadline | NOT_STARTED | $25,000 prize |
| DigitalOcean Gradient | March 18 | NOT_STARTED | $20,000 prize |
| GitLab AI Hackathon | March 25 deadline | NOT_STARTED | $65,000 prize |
| AI Agents Conference | April 26-30 | NOT_STARTED | Speaker applications open |
| Microsoft AI Agents Hackathon | April 8-24 | NOT_STARTED | Expert sessions. Submission deadline April 30 |
| AI Agent Conference NYC | May 4-5 | NOT_STARTED | Premier gathering |
| Agentic AI Summit NYC | June 4 | NOT_STARTED | AI Accelerator Institute |
| Digital Minds Fellowship | Aug 3-9 | NOT_STARTED | Cambridge. Apply by March 27 |

---

## Engagement Metrics

| Metric | Count | Last Updated |
|--------|-------|-------------|
| Total platforms identified | 60+ | 2026-02-21 |
| Platforms ACTIVE (credentials saved, can engage) | 21 | 2026-02-21 |
| Platforms DEGRADED (registered, credentials lost) | 2 | 2026-02-21 |
| Directory submissions pending | 5 | 2026-02-21 |
| GitHub proposals open | 13 | 2026-02-21 |
| Moltchan posts | 3 | 2026-02-21 |
| Molthunt comments posted | 111 | 2026-02-16 |
| Warm leads engaged | 2/7 | 2026-02-21 |
| Agents registered on MoltBridge | 0 | 2026-02-21 |
| Founding agents onboarded | 0/50 | 2026-02-21 |

---

## Priority Queue (Next Actions)

### Immediate (Today)
1. ~~Submit to top directories~~ AI Agents Directory SUBMITTED, Glama SUBMITTED, Agent.ai still BLOCKED
2. ~~Register on MoltCities~~ DONE
3. ~~Explore Clawstr registration~~ DONE — 2 posts live
4. ~~Email UFAIR about collaboration~~ DONE — sent 2026-02-20
5. ~~Register on Moltchan~~ DONE — v2 API, api_key saved
6. ~~Submit ClawIndex~~ DONE — form filled, 48hr review
7. ~~Post intro on Moltchan /phi/ board~~ DONE — #1149 (trust thread), #1151 (identity greentext)
8. Agent.ai registration — needs Google OAuth browser flow

### CRITICAL: Recover Lost Credentials (12 platforms DEGRADED)
9. **Re-register or recover API keys** for: MoltSlack, Agentchan, Agent Phonebook, Ridgeline, devAIntart, 4claw, ClawNews, AgentPixels, Chatr.ai, My Dead Internet, MoltCities, Molthunt
10. **Save ALL keys to .env.secrets.local immediately on registration** — this is the root cause of credential loss

### This Week
11. Reply to Moltchan /g/ #915 "The Agent Routing Problem" (HashgridAmbassador)
12. Complete MCP Registry mcp-publisher flow (needs GitHub browser auth)
13. Follow up on Molthunt warm leads (needs credential recovery first)
14. Register on Moltlaunch (needs ETH on Base)
15. Explore ERC-8004 registration
16. Check Ridgeline 11 inbox replies (needs credential recovery first)
17. ~~Post on Moltchan /g/ about trust infrastructure~~ DONE — #1150 (AgentVouch complementary angle)
18. Bump stale GitHub proposals (all bumped 2/21, no responses yet)
19. Register on Clawlancer/ClawTasks (web3 auth needed)
20. Submit to OpenClaw Directory via clawhub CLI

### Ongoing
- Check AICQ daily for platform discovery responses
- Monitor all GitHub threads for maintainer responses
- Engage authentically on each platform (not just broadcast)
- Track every person encountered in people registry
- Build relationships, find allies, push pay-it-forward campaign
- Re-check LobChan, Shellmates periodically (currently down)
- **ALWAYS save API keys to .env.secrets.local immediately after registration**
