/**
 * Metrics Routes — Comprehensive system health and metrics endpoint
 *
 * GET /metrics — Full system dashboard (localhost only)
 * GET /metrics/requests — Recent API request log
 * GET /metrics/errors — Recent errors
 * GET /metrics/activity — Activity timeline
 */

import { Router, Request, Response, NextFunction } from 'express';
import { verifyConnectivity, getDriver } from '../db/neo4j';
import {
  getMetricsStore,
  getEndpointMetrics,
  getErrorTracker,
} from '../services/metrics';
import { getNeo4jHealthTracker } from '../db/neo4j';

const startTime = Date.now();

export function createMetricsRoutes(): Router {
  const router = Router();

  const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res, next).catch(next);

  // Localhost-only gate
  function localhostOnly(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('::ffff:127.0.0.1')) {
      res.status(403).json({ error: 'Localhost only' });
      return;
    }
    next();
  }

  // GET /metrics — Full system dashboard
  router.get('/metrics', localhostOnly, asyncHandler(async (_req, res) => {
    const metricsStore = getMetricsStore();
    const endpointMetrics = getEndpointMetrics();
    const errorTracker = getErrorTracker();
    const neo4jHealth = getNeo4jHealthTracker();
    const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
    const totalRequests = endpointMetrics.getTotalRequests();
    const requestsPerMinute = uptimeSeconds > 0
      ? Math.round((totalRequests / (uptimeSeconds / 60)) * 100) / 100
      : 0;

    // Neo4j network stats
    let networkStats = { agents: 0, principals: 0, attestations: 0, outcomes: 0, goals: 0 };
    const neo4jConnected = await verifyConnectivity();
    if (neo4jConnected) {
      try {
        const session = getDriver().session();
        try {
          const result = await session.run(`
            OPTIONAL MATCH (a:Agent) WITH count(a) AS agents
            OPTIONAL MATCH (p:Principal) WITH agents, count(p) AS principals
            OPTIONAL MATCH ()-[att:ATTESTED]->() WITH agents, principals, count(att) AS attestations
            OPTIONAL MATCH (o:Outcome) WITH agents, principals, attestations, count(o) AS outcomes
            OPTIONAL MATCH (g:ConnectionGoal)
            RETURN agents, principals, attestations, outcomes, count(g) AS goals
          `);
          if (result.records.length > 0) {
            const r = result.records[0];
            networkStats = {
              agents: r.get('agents').toNumber(),
              principals: r.get('principals').toNumber(),
              attestations: r.get('attestations').toNumber(),
              outcomes: r.get('outcomes').toNumber(),
              goals: r.get('goals').toNumber(),
            };
          }
        } finally {
          await session.close();
        }
      } catch {}
    }

    res.json({
      timestamp: new Date().toISOString(),
      uptime_seconds: uptimeSeconds,
      neo4j: {
        connected: neo4jConnected,
        ...neo4jHealth.getStats(),
      },
      api: {
        total_requests: totalRequests,
        total_errors: endpointMetrics.getTotalErrors(),
        requests_per_minute: requestsPerMinute,
        error_rate: totalRequests > 0
          ? Math.round((endpointMetrics.getTotalErrors() / totalRequests) * 10000) / 10000
          : 0,
        endpoints: endpointMetrics.getSummary(),
      },
      errors: errorTracker.getCounts24h(),
      network: networkStats,
      persistence: {
        data_dir: metricsStore.getDataDir(),
        files: await metricsStore.listDataFiles(),
        last_snapshot: new Date().toISOString(),
      },
    });
  }));

  // GET /metrics/requests — Recent API request log
  router.get('/metrics/requests', localhostOnly, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query['limit'] as string) || 100;
    const since = req.query['since'] as string;
    const entries = await getMetricsStore().readLog('api-requests', { limit, since });
    res.json({ count: entries.length, entries });
  }));

  // GET /metrics/errors — Recent errors
  router.get('/metrics/errors', localhostOnly, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query['limit'] as string) || 100;
    const since = req.query['since'] as string;
    const entries = await getMetricsStore().readLog('errors', { limit, since });
    const counters = getErrorTracker().getCounts24h();
    res.json({ counters_24h: counters, count: entries.length, entries });
  }));

  // GET /metrics/activity — Activity timeline
  router.get('/metrics/activity', localhostOnly, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query['limit'] as string) || 100;
    const since = req.query['since'] as string;
    const entries = await getMetricsStore().readLog('activity', { limit, since });
    res.json({ count: entries.length, entries });
  }));

  return router;
}
