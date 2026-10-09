#!/usr/bin/env node
/**
 * keep-warm.js — Neo4j AuraDB idle-pause preventer for MoltBridge.
 *
 * WHY THIS EXISTS (2026-05-26, the ~12-day MoltBridge outage):
 *   MoltBridge went dark May 13 → ~May 26. Chain: the server stopped, a corrupt
 *   launchd plist meant it couldn't auto-restart, so it sat idle for 3 days, and
 *   Aura's free-tier auto-paused after the idle window. The pause then required a
 *   MANUAL console resume — turning a restartable blip into a multi-day outage.
 *
 *   The server's own /health already runs verifyConnectivity() on every probe, so
 *   while the SERVER is up Aura stays warm. The hole is exactly when the server is
 *   DOWN — which is when you most need Aura to stay warm so it reconnects instantly
 *   on recovery instead of needing a human at console.neo4j.io.
 *
 *   This keep-warm therefore queries Aura DIRECTLY, independent of the MoltBridge
 *   server process, on a schedule with margin under the ~3-day idle-pause window.
 *   A trivial `RETURN 1` is enough to count as activity.
 *
 * Reads creds from ~/.moltbridge/server/.env (never hardcode — the old
 * cleanup-neo4j.js baked the password in plaintext; this does not).
 *
 * Exit 0 = Aura answered (warm). Exit 1 = could not reach Aura (paused/down/creds).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DRIVER_PATH = path.join(os.homedir(), '.moltbridge/server/node_modules/neo4j-driver');
const ENV_PATH = path.join(os.homedir(), '.moltbridge/server/.env');
const LOG_PATH = path.join(os.homedir(), '.moltbridge/logs/keep-warm.log');

function log(line) {
  const stamp = new Date().toISOString();
  const msg = `${stamp} ${line}`;
  try { fs.appendFileSync(LOG_PATH, msg + '\n'); } catch (_) { /* ignore */ }
  console.log(msg);
}

// Minimal .env parser — only the keys we need, tolerant of quotes/whitespace.
function readEnv(file) {
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

(async () => {
  let neo4j, env;
  try {
    neo4j = require(DRIVER_PATH);
    env = readEnv(ENV_PATH);
  } catch (e) {
    log(`FAIL setup: ${e.message}`);
    process.exit(1);
  }

  const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = env;
  if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
    log('FAIL: NEO4J_URI/USER/PASSWORD missing from .env');
    process.exit(1);
  }

  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
    connectionTimeout: 20000,
    maxConnectionLifetime: 30000,
  });

  const session = driver.session();
  try {
    const res = await session.run('RETURN 1 AS ok');
    const ok = res.records[0].get('ok');
    log(`OK: Aura warm (RETURN ${ok})`);
    process.exitCode = 0;
  } catch (e) {
    log(`FAIL query: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await session.close().catch(() => {});
    await driver.close().catch(() => {});
  }
})();
