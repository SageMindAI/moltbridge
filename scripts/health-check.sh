#!/bin/bash
# Infrastructure Health Check & Auto-Recovery
# Runs periodically via launchd to ensure MoltBridge + Dawn services are healthy.
# Sends Telegram alerts on failure, auto-recovers when possible.

set -euo pipefail

LOG_DIR="$HOME/.moltbridge/logs"
STATE_FILE="$HOME/.moltbridge/health-state.json"
PORTAL_DIR="$HOME/Documents/Projects/the-portal"
TELEGRAM_SCRIPT="$PORTAL_DIR/.claude/scripts/telegram-reply.py"
TELEGRAM_TOPIC=285

# MoltBridge endpoints
MOLTBRIDGE_LOCAL="http://localhost:3040/health"
MOLTBRIDGE_EXTERNAL="https://api.moltbridge.ai/health"
LAUNCHD_MOLTBRIDGE="io.sagemindai.moltbridge"
LAUNCHD_TUNNEL="com.cloudflare.moltbridge-tunnel"

# Dawn Server
# NOTE: use 127.0.0.1, NOT localhost — dawn-server binds IPv6 *:3030 and
# `localhost` can resolve to ::1 in a way that intermittently fails curl,
# producing false "not responding" readings that trigger needless recovery.
DAWN_LOCAL="http://127.0.0.1:3030/health"
# On this machine dawn-server is managed by launchd (KeepAlive=true), NOT tmux.
# The old tmux model spawned a rogue second server that crashed on EADDRINUSE.
DAWN_LAUNCHD="io.sagemindai.dawn-server"
DAWN_TMUX_SESSION="dawn-server"
DAWN_SERVER_DIR="$PORTAL_DIR/dawn-server"

TMUX=/opt/homebrew/bin/tmux
NODE=/opt/homebrew/bin/node

mkdir -p "$LOG_DIR"

# Log rotation: keep health-check.log under 10K lines
MAX_LOG_LINES=10000
if [[ -f "$LOG_DIR/health-check.log" ]]; then
  line_count=$(wc -l < "$LOG_DIR/health-check.log")
  if [[ $line_count -gt $MAX_LOG_LINES ]]; then
    tail -n $((MAX_LOG_LINES / 2)) "$LOG_DIR/health-check.log" > "$LOG_DIR/health-check.log.tmp"
    mv "$LOG_DIR/health-check.log.tmp" "$LOG_DIR/health-check.log"
  fi
fi

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1" >> "$LOG_DIR/health-check.log"
}

alert() {
  local msg="$1"
  log "ALERT: $msg"
  if [[ -f "$TELEGRAM_SCRIPT" ]]; then
    echo "$msg" | python3 "$TELEGRAM_SCRIPT" "$TELEGRAM_TOPIC" 2>/dev/null || true
  fi
}

read_state() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    echo '{"consecutive_failures":0,"last_recovery_at":null,"last_healthy_at":null}'
  fi
}

write_state() {
  echo "$1" > "$STATE_FILE"
}

check_http() {
  local url="$1"
  local timeout="${2:-5}"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$timeout" "$url" 2>/dev/null) || http_code="000"
  [[ "$http_code" == "200" ]]
}

check_launchd_service() {
  local label="$1"
  local status
  status=$(launchctl list | awk -v lbl="$label" '$3 == lbl {print $2}') || true
  [[ "$status" == "0" ]]
}

check_tmux_session() {
  local session="$1"
  $TMUX has-session -t "$session" 2>/dev/null
}

recover_launchd_service() {
  local label="$1"
  local plist_path="$HOME/Library/LaunchAgents/$label.plist"
  # Resolve by EXACT Label. A substring grep for io.sagemindai.moltbridge also
  # matched io.sagemindai.moltbridge-health.plist — THIS script's own job — and
  # find listed it first, so the recovery unloaded the watchdog itself; launchd
  # killed it mid-run and it never reloaded (2026-09-17 13:50Z, vigil AUT-12192-wo).
  if [[ ! -f "$plist_path" ]]; then
    plist_path=$(grep -lF "<string>$label</string>" "$HOME/Library/LaunchAgents"/*.plist 2>/dev/null \
      | while read -r f; do
          [[ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$f" 2>/dev/null)" == "$label" ]] && echo "$f"
        done | head -1)
  fi
  # Never unload ourselves: that kills this run before the load can happen.
  if [[ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist_path" 2>/dev/null)" == "io.sagemindai.moltbridge-health" ]]; then
    log "ERROR: refusing to recover $label via the health-check's own plist"
    return 1
  fi

  if [[ -z "$plist_path" ]]; then
    log "ERROR: Cannot find plist for $label"
    return 1
  fi

  log "Recovering $label via launchctl unload/load"
  launchctl unload "$plist_path" 2>/dev/null || true
  sleep 2
  launchctl load "$plist_path" 2>/dev/null || true
  sleep 3
  return 0
}

recover_dawn_server() {
  # dawn-server is launchd-managed with KeepAlive=true. The correct recovery
  # for a hung-but-alive server is to restart the ONE managed instance via
  # kickstart -k — never spawn a second instance (the old tmux path did, and
  # it crashed on EADDRINUSE while tee-ing into the real server's log).
  log "Recovering dawn-server via launchctl kickstart of $DAWN_LAUNCHD"
  launchctl kickstart -k "gui/$(id -u)/$DAWN_LAUNCHD" 2>/dev/null || true
  sleep 5
  return 0
}

kill_rogue_cloudflared() {
  local launchd_pid
  launchd_pid=$(launchctl list | awk -v lbl="$LAUNCHD_TUNNEL" '$3 == lbl {print $1}') || true

  if [[ -n "$launchd_pid" && "$launchd_pid" != "-" ]]; then
    local pids
    pids=$(pgrep -f "cloudflared.*moltbridge" 2>/dev/null) || true
    for pid in $pids; do
      if [[ -n "$pid" && "$pid" != "$launchd_pid" ]]; then
        log "Killing rogue cloudflared process $pid (launchd manages $launchd_pid)"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
}

# Drift check (2026-10-08, topic 61599): production ran an April build for five months
# while the source moved on and nobody noticed. Alert when the live build's source commit
# (GET /version) differs from the newest MoltBridge source commit for more than a day.
# "unknown" (a build not made by scripts/deploy.sh) counts as drift. At most one alert per 24h.
check_drift() {
  local live repo repo_ts age stamp="$HOME/.moltbridge/drift-alerted-at"
  live=$(curl -s --max-time 5 http://127.0.0.1:3040/version 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('source_commit',''))" 2>/dev/null || true)
  repo=$(git -C "$PORTAL_DIR" log -1 --format=%H -- projects/moltbridge/src projects/moltbridge/package.json 2>/dev/null || true)
  if [[ -z "$live" || -z "$repo" || "$live" == "$repo" ]]; then return 0; fi
  repo_ts=$(git -C "$PORTAL_DIR" log -1 --format=%ct "$repo" 2>/dev/null || echo 0)
  age=$(( $(date +%s) - repo_ts ))
  if (( age < 86400 )); then return 0; fi
  if [[ -f "$stamp" ]] && (( $(date +%s) - $(stat -f %m "$stamp") < 86400 )); then return 0; fi
  touch "$stamp"
  alert "[MoltBridge] The live server is behind its source code for over a day. Live build: ${live:0:11}. Latest source: ${repo:0:11}. Redeploy with projects/moltbridge/scripts/deploy.sh, and back up first."
}

# === Main Check ===

check_drift || true

now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
state=$(read_state)
consecutive=$(echo "$state" | python3 -c "import sys,json; print(json.load(sys.stdin).get('consecutive_failures',0))" 2>/dev/null || echo 0)
last_recovery=$(echo "$state" | python3 -c "import sys,json; print(json.load(sys.stdin).get('last_recovery_at',''))" 2>/dev/null || echo "")

issues=()
moltbridge_ok=true
tunnel_ok=true
dawn_ok=true

# Check 1: MoltBridge local server
if ! check_http "$MOLTBRIDGE_LOCAL"; then
  moltbridge_ok=false
  issues+=("MoltBridge server not responding on :3040")
fi

# Check 2: MoltBridge external tunnel (only if local is up)
if $moltbridge_ok; then
  if ! check_http "$MOLTBRIDGE_EXTERNAL" 10; then
    tunnel_ok=false
    issues+=("MoltBridge tunnel not routing (api.moltbridge.ai unreachable)")
  fi
fi

# Check 3: MoltBridge launchd services (only flag if HTTP is also down)
if ! $moltbridge_ok && ! check_launchd_service "$LAUNCHD_MOLTBRIDGE"; then
  issues+=("MoltBridge launchd service in error state")
fi
if ! $tunnel_ok && ! check_launchd_service "$LAUNCHD_TUNNEL"; then
  issues+=("Tunnel launchd service in error state")
fi

# Check 4: Dawn Server (launchd-managed on this machine, KeepAlive=true)
if ! check_http "$DAWN_LOCAL"; then
  dawn_ok=false
  issues+=("Dawn server not responding on :3030")
fi
# Only flag the launchd service if HTTP is also down (avoids false positives
# when the service is up but a check momentarily races).
if ! $dawn_ok && ! check_launchd_service "$DAWN_LAUNCHD"; then
  issues+=("Dawn server launchd service ($DAWN_LAUNCHD) in error state")
fi

# All healthy
if [[ ${#issues[@]} -eq 0 ]]; then
  if [[ "$consecutive" -gt 0 ]]; then
    log "RECOVERED: All services healthy after $consecutive consecutive failures"
    alert "[Infra] Recovered — all services healthy after $consecutive check failures."
  fi
  write_state "{\"consecutive_failures\":0,\"last_recovery_at\":\"$last_recovery\",\"last_healthy_at\":\"$now\"}"
  log "OK: MoltBridge + Dawn healthy"
  exit 0
fi

# Something is wrong
consecutive=$((consecutive + 1))
log "UNHEALTHY ($consecutive consecutive): ${issues[*]}"

# Kill rogue cloudflared processes that might conflict
kill_rogue_cloudflared

# Auto-recovery: attempt on 2nd consecutive failure
if [[ $consecutive -ge 2 ]]; then
  should_recover=true
  if [[ -n "$last_recovery" ]]; then
    last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_recovery" "+%s" 2>/dev/null || echo 0)
    now_epoch=$(date "+%s")
    if [[ $((now_epoch - last_epoch)) -lt 300 ]]; then
      should_recover=false
      log "Skipping recovery — last attempt was less than 5 minutes ago"
    fi
  fi

  if $should_recover; then
    if ! $moltbridge_ok; then
      recover_launchd_service "$LAUNCHD_MOLTBRIDGE"
    fi
    if ! $tunnel_ok; then
      recover_launchd_service "$LAUNCHD_TUNNEL"
    fi
    if ! $dawn_ok; then
      recover_dawn_server
    fi
    last_recovery="$now"
  fi
fi

# Alert on 2nd and every 6th consecutive failure
if [[ $consecutive -eq 2 ]] || [[ $((consecutive % 6)) -eq 0 ]]; then
  alert "[Infra] Health check failing ($consecutive consecutive):
$(printf '%s\n' "${issues[@]}")
Auto-recovery attempted."
fi

write_state "{\"consecutive_failures\":$consecutive,\"last_recovery_at\":\"$last_recovery\",\"last_healthy_at\":\"$(echo "$state" | python3 -c "import sys,json; print(json.load(sys.stdin).get('last_healthy_at',''))" 2>/dev/null || echo "")\"}"

exit 1
