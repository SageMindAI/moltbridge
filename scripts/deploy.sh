#!/bin/bash
# MoltBridge Deploy Script
# Builds, syncs to ~/.moltbridge/server/, and restarts the server.
# Usage: ./scripts/deploy.sh

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$HOME/.moltbridge/server"

echo "Building TypeScript..."
cd "$PROJECT_DIR"
npx tsc

# Stamp the build so the live /version endpoint can say which source it runs (drift check, 2026-10-08)
SRC_COMMIT=$(git -C "$PROJECT_DIR" log -1 --format=%H -- src package.json 2>/dev/null || echo unknown)
DIRTY=$(git -C "$PROJECT_DIR" status --porcelain -- src package.json 2>/dev/null | wc -l | tr -d ' ')
printf '{"source_commit":"%s","uncommitted_changes":%s,"built_at":"%s"}\n' "$SRC_COMMIT" "${DIRTY:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PROJECT_DIR/dist/build-info.json"

echo "Syncing dist + public to $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"
rsync -a --delete "$PROJECT_DIR/dist/" "$DEPLOY_DIR/dist/"
rsync -a --delete "$PROJECT_DIR/public/" "$DEPLOY_DIR/public/"
rsync -a "$PROJECT_DIR/node_modules/" "$DEPLOY_DIR/node_modules/"
cp "$PROJECT_DIR/.env" "$DEPLOY_DIR/.env"

# Also sync tunnel config
cp "$PROJECT_DIR/tunnel-config.yml" "$HOME/.moltbridge/tunnel-config.yml" 2>/dev/null || true

echo "Restarting server via launchd..."
launchctl unload "$HOME/Library/LaunchAgents/io.sagemindai.moltbridge.plist" 2>/dev/null || true
sleep 2
launchctl load "$HOME/Library/LaunchAgents/io.sagemindai.moltbridge.plist"
sleep 5

# Verify
if curl -s -o /dev/null -w "" --max-time 5 http://localhost:3040/health 2>/dev/null; then
  echo "Server healthy on localhost:3040"
else
  echo "WARNING: Server not responding after restart"
  exit 1
fi

echo "Deploy complete."
