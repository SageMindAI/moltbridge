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
import { getWebhookService } from './services/webhooks';
import { getMetricsStore, getEndpointMetrics, getErrorTracker } from './services/metrics';

const PORT = process.env.PORT || 3040;

async function main() {
  console.log('='.repeat(50));
  console.log('MoltBridge starting...');
  console.log(`Port: ${PORT}`);
  console.log('='.repeat(50));

  // Initialize signing keypair (auto-generates in dev)
  getSigningKeyPair();

  // Initialize metrics persistence
  const metricsStore = getMetricsStore();
  await metricsStore.init();
  console.log('[Metrics] Store initialized');

  // Restore error tracker state from last shutdown
  const errorSnapshot = await metricsStore.loadSnapshot<any>('error-counters');
  if (errorSnapshot) {
    getErrorTracker().restore(errorSnapshot);
    console.log('[Metrics] Error counters restored from snapshot');
  }

  // Log server start
  metricsStore.appendLog('activity', {
    event: 'server_start',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });

  // Verify Neo4j connectivity
  const neo4jOk = await verifyConnectivity();
  if (neo4jOk) {
    console.log('[Neo4j] Connected successfully');
  } else {
    console.warn('[Neo4j] Connection failed — server starting in degraded mode');
  }

  // Bootstrap inbound-webhook partners (veroq, a2a, moltrust) from env secrets.
  // Missing secrets → partner simply not registered; route returns 404.
  const { bootstrapInboundPartners } = await import('./services/inbound-webhooks');
  bootstrapInboundPartners();

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

  // Periodic metrics snapshot (every 60 seconds)
  const metricsInterval = setInterval(async () => {
    try {
      await metricsStore.saveSnapshot('endpoint-metrics', getEndpointMetrics().getSnapshot());
      await metricsStore.saveSnapshot('error-counters', getErrorTracker().getSnapshot());
    } catch (err: any) {
      console.error('[Metrics] Snapshot save error:', err.message);
    }
  }, 60_000);
  if (metricsInterval.unref) metricsInterval.unref();
  console.log('[Metrics] Periodic snapshots enabled (60s interval)');

  // Start webhook event processor (every 30s)
  const webhookService = getWebhookService();
  const webhookInterval = setInterval(async () => {
    try {
      const processed = await webhookService.processQueue(async (url, payload, signature) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MoltBridge-Signature': signature,
          },
          body: payload,
        });
        return response.ok;
      });
      if (processed > 0) {
        console.log(`[Webhooks] Processed ${processed} deliveries`);
      }
    } catch (err: any) {
      console.error('[Webhooks] Queue processing error:', err.message);
    }
  }, 30_000);
  console.log('[Webhooks] Event processor started (30s interval)');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(webhookInterval);
    clearInterval(metricsInterval);

    // Persist metrics before exit
    try {
      const uptime = Math.round((Date.now() - Date.now()) / 1000); // approximate
      metricsStore.appendLog('activity', {
        event: 'server_stop',
        timestamp: new Date().toISOString(),
        signal,
      });
      await metricsStore.saveSnapshot('endpoint-metrics', getEndpointMetrics().getSnapshot());
      await metricsStore.saveSnapshot('error-counters', getErrorTracker().getSnapshot());
      await metricsStore.shutdown();
      console.log('[Metrics] Final snapshots saved');
    } catch (err: any) {
      console.error('[Metrics] Shutdown save error:', err.message);
    }

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
