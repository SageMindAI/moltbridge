# MoltBridge Launch Checklist

> From "code complete" to "live and serving agents."

## Status: Ready for Launch

All code, tests, and deployment tooling are complete. This checklist covers the remaining operational steps.

---

## Phase 1: Local Infrastructure (30 minutes)

### 1. Neo4j AuraDB Setup
- [ ] Create free cluster at [neo4j.io/aura](https://neo4j.io/aura) (200K nodes free tier)
- [ ] Copy connection URI, username, password
- [ ] Create `.env` from `.env.example`:
  ```bash
  cp .env.example .env
  # Edit .env with your Neo4j credentials
  ```
- [ ] Verify connectivity:
  ```bash
  pnpm deploy -- --check
  ```

### 2. Generate Production Keys
- [ ] Generate server signing keypair:
  ```bash
  pnpm keys -- --env
  ```
  This appends `MOLTBRIDGE_AGENT_ID` and `MOLTBRIDGE_SIGNING_KEY` to `.env`.

### 3. Bootstrap Database Schema
- [ ] Run schema constraints:
  ```bash
  pnpm bootstrap
  ```
  Creates uniqueness constraints and indexes on Neo4j.

### 4. Seed Initial Data (Optional)
- [ ] Seed development graph:
  ```bash
  pnpm seed
  ```
- [ ] Or seed 110-agent sandbox for testing:
  ```bash
  pnpm seed:sandbox
  ```

### 5. Verify Local Server
- [ ] Start server:
  ```bash
  pnpm dev
  ```
- [ ] Check health:
  ```bash
  curl http://localhost:3040/health
  ```
- [ ] Verify JWKS:
  ```bash
  curl http://localhost:3040/.well-known/jwks.json
  ```

---

## Phase 2: Public Access (15 minutes)

### 6. Cloudflare Tunnel
- [ ] Install cloudflared (if not already):
  ```bash
  brew install cloudflared
  ```
- [ ] Login to Cloudflare:
  ```bash
  cloudflared tunnel login
  ```
- [ ] Create named tunnel:
  ```bash
  cloudflared tunnel create moltbridge
  ```
- [ ] Configure DNS (in Cloudflare dashboard):
  - Add CNAME: `api.moltbridge.com` → `<tunnel-id>.cfargotunnel.com`
- [ ] Or use quick tunnel for testing:
  ```bash
  pnpm deploy -- --tunnel
  ```

### 7. Full Deployment
- [ ] Run full deployment:
  ```bash
  pnpm deploy
  ```
  This runs pre-flight checks, bootstraps schema, builds, starts server, and sets up tunnel.

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
- [ ] Verify agent card is served:
  ```bash
  curl https://api.moltbridge.com/.well-known/agent.json
  ```
  This is the Google A2A protocol discovery endpoint.

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
curl -s https://api.moltbridge.com/health | jq .

# Verify all endpoints respond
curl -s https://api.moltbridge.com/.well-known/jwks.json | jq .
curl -s https://api.moltbridge.com/.well-known/agent.json | jq .
curl -s https://api.moltbridge.com/payments/pricing | jq .
```

### Phase Transition Triggers

| Phase | Trigger | Next Infrastructure |
|-------|---------|-------------------|
| 1 → 2 | 30+ agents, 150+ edges | Railway/VPS + managed Neo4j |
| 2 → 3 | 150+ agents, revenue flowing | Kubernetes + Neo4j cluster |

---

## Test Coverage Summary

| Suite | Tests | Status |
|-------|-------|--------|
| Core API | 471 | Passing |
| TypeScript SDK | 57 | Passing |
| Python SDK | 24 | Passing |
| Smart Contract | 23 | Passing |
| **Total** | **575** | **All passing** |
