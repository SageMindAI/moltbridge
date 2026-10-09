/**
 * Express App Factory
 *
 * Separated from index.ts for testability.
 * Creates and configures the Express app without starting the server.
 */

import express from 'express';
import * as path from 'path';
import { createRoutes } from './api/routes';
import { createMetricsRoutes } from './api/metrics-routes';
import { bodySizeLimit } from './middleware/validate';
import { requestLogger } from './middleware/request-logger';

export function createApp(): express.Express {
  const app = express();
  // Capture raw body for HMAC signature verification on inbound webhooks.
  app.use(express.json({
    limit: '50kb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  app.use(bodySizeLimit(50 * 1024));

  // Request logging — must be before routes to capture all requests
  app.use(requestLogger());

  // Redirect api.moltbridge.ai root to docs
  app.use((req, res, next) => {
    const host = req.hostname || '';
    if (host.startsWith('api.') && req.path === '/') {
      return res.redirect('/docs');
    }
    next();
  });

  // Serve static files (.well-known/agent.json, openapi.yaml, styles.css, analytics.js)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Clean URL routes for landing pages
  const publicDir = path.join(__dirname, '..', 'public');
  const landingPages = ['how-it-works', 'research', 'pricing', 'docs'];
  for (const page of landingPages) {
    app.get(`/${page}`, (_req, res) => {
      res.sendFile(path.join(publicDir, `${page}.html`));
    });
  }

  const routes = createRoutes();
  app.use('/', routes);

  // Metrics routes (localhost only)
  const metricsRoutes = createMetricsRoutes();
  app.use('/', metricsRoutes);

  return app;
}
