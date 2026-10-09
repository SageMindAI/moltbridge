/**
 * Neo4j Driver — Singleton connection manager with health tracking
 */

import neo4j, { Driver, Session } from 'neo4j-driver';

let driver: Driver | null = null;

// ============================================================
// Neo4j Health Tracker
// ============================================================

class Neo4jHealthTracker {
  private queryCount = 0;
  private totalQueryMs = 0;
  private errorCount = 0;
  private lastError: string | null = null;
  private lastErrorTime: string | null = null;
  private slowQueryCount = 0; // queries > 500ms
  private slowQueryThreshold = 500;

  recordQuery(durationMs: number): void {
    this.queryCount++;
    this.totalQueryMs += durationMs;
    if (durationMs > this.slowQueryThreshold) this.slowQueryCount++;
  }

  recordError(message: string): void {
    this.errorCount++;
    this.lastError = message;
    this.lastErrorTime = new Date().toISOString();
  }

  getStats() {
    return {
      query_count: this.queryCount,
      avg_query_ms: this.queryCount > 0
        ? Math.round((this.totalQueryMs / this.queryCount) * 100) / 100
        : 0,
      error_count: this.errorCount,
      slow_query_count: this.slowQueryCount,
      last_error: this.lastError,
      last_error_time: this.lastErrorTime,
    };
  }
}

const healthTracker = new Neo4jHealthTracker();

export function getNeo4jHealthTracker(): Neo4jHealthTracker {
  return healthTracker;
}

/**
 * Create a tracked Neo4j session that records query timing and errors.
 * Use this instead of driver.session() for all application queries.
 */
export function createTrackedSession(): Session {
  const d = getDriver();
  const session = d.session();

  // Wrap the run method to track performance
  const originalRun = session.run.bind(session);
  session.run = function (...args: Parameters<Session['run']>) {
    const start = Date.now();
    const result = originalRun(...args);

    // Track timing on the result promise
    result.then(() => {
      healthTracker.recordQuery(Date.now() - start);
    }).catch((err: Error) => {
      healthTracker.recordQuery(Date.now() - start);
      healthTracker.recordError(err.message);
    });

    return result;
  } as Session['run'];

  return session;
}

// ============================================================
// Driver management
// ============================================================

export function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;

    if (!uri || !user || !password) {
      throw new Error('Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD environment variables');
    }

    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

export async function verifyConnectivity(): Promise<boolean> {
  try {
    const d = getDriver();
    await d.verifyConnectivity();
    return true;
  } catch (error) {
    console.error('[Neo4j] Connectivity check failed:', error);
    return false;
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
