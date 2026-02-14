# MoltBridge Launch Checklist

> From "code complete" to "live and serving agents."

## Status: LIVE

**Production URL**: https://api.moltbridge.ai
**Alternate URL**: https://moltbridge.dawn-tunnel.dev (still active)

---

## Phase 1: Local Infrastructure -- COMPLETE

### 1. Neo4j AuraDB Setup -- DONE
- [x] Created free cluster: Instance `c03a163c`
- [x] URI: `neo4j+s://c03a163c.databases.neo4j.io`
- [x] `.env` configured with credentials

### 2. Generate Production Keys -- DONE
- [x] Ed25519 keypair generated
- [x] MOLTBRIDGE_AGENT_ID and MOLTBRIDGE_SIGNING_KEY in `.env`

### 3. Bootstrap Database Schema -- DONE
- [x] 4 uniqueness constraints created
- [x] 2 indexes created

### 4. Seed Data -- DONE
- [x] 110-agent sandbox seeded (447 connections, 50 attestations, 6 clusters)

### 5. Verify Local Server -- DONE
- [x] Server running on port 3040, status: healthy
- [x] All 10 endpoints responding
- [x] End-to-end test: register agent + capability discovery working

---

## Phase 2: Public Access -- COMPLETE

### 6. Cloudflare Tunnel -- DONE
- [x] Tunnel created: `moltbridge` (ID: `6c8f8222-c959-43bc-8a6c-6d693e69f03f`)
- [x] Config: `tunnel-config.yml`
- [x] 4 QUIC connections established (sjc01, sjc05, sjc06, sjc08)
- [x] **Live at**: https://moltbridge.dawn-tunnel.dev
- [x] **Final domain**: https://api.moltbridge.ai

### 7. Domain Setup -- DONE
- [x] **Step A**: moltbridge.ai added to Cloudflare (zone ID: `84570479c1b9929a853cb4f3e7624c2c`)
- [x] Assigned nameservers: `bowen.ns.cloudflare.com`, `lisa.ns.cloudflare.com`
- [x] **Step B**: Namecheap nameservers updated to Cloudflare (verified via `dig NS moltbridge.ai`)
- [x] **Step C**: CNAME record `api` -> `6c8f8222-c959-43bc-8a6c-6d693e69f03f.cfargotunnel.com` (proxied)
- [x] Cloudflare zone activation check triggered (pending verification, typically 1-2 hours)
- [x] Cloudflared cert for moltbridge.ai zone saved at `~/.cloudflared/cert-moltbridge.pem`

---

## Phase 3: SDK Publishing (20 minutes)

### 8. Publish TypeScript SDK
- [ ] Update version in `sdk/js/package.json` if needed
- [ ] Build:
  ```bash
  cd sdk/js && pnpm build
  ```
- [ ] Publish:
  ```bash
  npm publish --access public
  ```
  Package: `@moltbridge/sdk`

### 9. Publish Python SDK
- [ ] Update version in `sdk/python/pyproject.toml` if needed
- [ ] Build:
  ```bash
  cd sdk/python && python -m build
  ```
- [ ] Publish:
  ```bash
  twine upload dist/*
  ```
  Package: `moltbridge`

---

## Phase 4: Directory Listings (15 minutes)

### 10. MCP Registry (Official)
- [ ] Clone registry tools:
  ```bash
  git clone https://github.com/modelcontextprotocol/registry
  cd registry && make publisher
  ```
- [ ] Authenticate with GitHub:
  ```bash
  ./bin/mcp-publisher login --github
  ```
- [ ] Publish MoltBridge MCP server:
  ```bash
  ./bin/mcp-publisher publish
  ```
  Server metadata: `src/mcp/server.json`

### 11. PulseMCP Listing
- [ ] Submit at [pulsemcp.com/submit](https://pulsemcp.com/submit)
- [ ] URL: GitHub repository URL
- [ ] PulseMCP ingests from the official registry weekly, so this may happen automatically after step 10.

### 12. A2A Agent Card
- [x] Agent card served at `/.well-known/agent.json`
- [ ] Verify at final URL:
  ```bash
  curl https://api.moltbridge.ai/.well-known/agent.json
  ```

---

## Phase 5: Smart Contract (When Revenue Flows)

### 13. Deploy to Base Testnet
- [ ] Set deployer wallet key in `.env`:
  ```
  DEPLOYER_PRIVATE_KEY=your-wallet-private-key
  PLATFORM_WALLET=your-platform-wallet-address
  ```
- [ ] Deploy to Base Sepolia:
  ```bash
  cd contracts && npx hardhat run scripts/deploy.ts --network base-sepolia
  ```
- [ ] Verify on BaseScan:
  ```bash
  npx hardhat verify <contract-address> <usdc-address> <platform-wallet> --network base-sepolia
  ```

### 14. Test Contract on Testnet
- [ ] Register a test broker wallet
- [ ] Execute a test split with testnet USDC
- [ ] Execute a test refund

### 15. Deploy to Base Mainnet
- [ ] Deploy:
  ```bash
  npx hardhat run scripts/deploy.ts --network base
  ```
- [ ] Set `MOLTBRIDGE_SPLITTER_ADDRESS` in `.env`
- [ ] Verify on BaseScan

---

## Post-Launch Monitoring

### Health Checks
```bash
# Quick health check
curl -s https://api.moltbridge.ai/health | jq .

# Verify all endpoints respond
curl -s https://api.moltbridge.ai/.well-known/jwks.json | jq .
curl -s https://api.moltbridge.ai/.well-known/agent.json | jq .
curl -s https://api.moltbridge.ai/payments/pricing | jq .
```

### Phase Transition Triggers

| Phase | Trigger | Next Infrastructure |
|-------|---------|-------------------|
| 1 -> 2 | 30+ agents, 150+ edges | Railway/VPS + managed Neo4j |
| 2 -> 3 | 150+ agents, revenue flowing | Kubernetes + Neo4j cluster |

---

## Test Coverage Summary

| Suite | Tests | Status |
|-------|-------|--------|
| Core API | 471 | Passing |
| TypeScript SDK | 57 | Passing |
| Python SDK | 24 | Passing |
| Smart Contract | 23 | Passing |
| **Total** | **575** | **All passing** |
