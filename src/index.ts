/**
 * MoltBridge — Professional Network Intelligence Engine
 *
 * Express server with Neo4j graph database.
 * Follows dawn-server patterns: createRoutes() factory, graceful shutdown.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { createApp } from './app';
import { verifyConnectivity, closeDriver } from './db/neo4j';
import { getSigningKeyPair } from './crypto/keys';

const PORT = process.env.PORT || 3040;

async function main() {
  console.log('='.repeat(50));
  console.log('MoltBridge starting...');
  console.log(`Port: ${PORT}`);
  console.log('='.repeat(50));

  // Initialize signing keypair (auto-generates in dev)
  getSigningKeyPair();

  // Verify Neo4j connectivity
  const neo4jOk = await verifyConnectivity();
  if (neo4jOk) {
    console.log('[Neo4j] Connected successfully');
  } else {
    console.warn('[Neo4j] Connection failed — server starting in degraded mode');
  }

  // Set up Express
  const app = createApp();

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`MoltBridge listening on http://localhost:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health                  — Server health');
    console.log('  GET  /.well-known/jwks.json   — Public signing key');
    console.log('  POST /verify                  — Proof-of-AI challenge');
    console.log('  POST /register                — Register agent');
    console.log('  PUT  /profile                 — Update profile (auth)');
    console.log('  POST /discover-broker         — Find broker (auth)');
    console.log('  POST /discover-capability     — Capability match (auth)');
    console.log('  GET  /credibility-packet      — Generate packet (auth)');
    console.log('  POST /attest                  — Submit attestation (auth)');
    console.log('  POST /report-outcome          — Report outcome (auth)');
    console.log('');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    server.close();
    await closeDriver();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
