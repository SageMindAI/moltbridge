/**
 * Express App Factory
 *
 * Separated from index.ts for testability.
 * Creates and configures the Express app without starting the server.
 */

import express from 'express';
import { createRoutes } from './api/routes';
import { bodySizeLimit } from './middleware/validate';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use(bodySizeLimit(50 * 1024));

  const routes = createRoutes();
  app.use('/', routes);

  return app;
}
