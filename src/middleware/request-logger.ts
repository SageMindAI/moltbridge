/**
 * Request Logger Middleware
 *
 * Logs every API request with endpoint, method, status, latency, and agent ID.
 * Feeds data into MetricsStore (persistent JSONL) and EndpointMetrics (in-memory aggregator).
 */

import { Request, Response, NextFunction } from 'express';
import { getMetricsStore, getEndpointMetrics, type RequestLogEntry } from '../services/metrics';

export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

      // Use req.route?.path for normalized path (e.g., /agents/:agentId/public-key)
      // Falls back to req.path if no route matched
      const routePath = req.route?.path
        ? `${req.baseUrl}${req.route.path}`
        : req.path;

      const entry: RequestLogEntry = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        route: routePath,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        agentId: (req as any).auth?.agent_id || null,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] || '').substring(0, 256),
        contentLength: parseInt(res.getHeader('content-length') as string) || 0,
      };

      // Persistent log
      getMetricsStore().appendLog('api-requests', entry);

      // In-memory aggregation for fast /metrics queries
      getEndpointMetrics().record(req.method, routePath, res.statusCode, durationMs);
    });

    next();
  };
}
