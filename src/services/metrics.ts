/**
 * MetricsStore — Centralized metrics persistence for MoltBridge
 *
 * Provides file-based persistence for all metrics and activity data.
 * Uses JSONL for append-only logs (API requests, errors, activity timeline)
 * and JSON snapshots for state that needs loading whole (analytics buffer).
 *
 * No external dependencies — uses Node's built-in fs module.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Types
// ============================================================

interface EndpointBucket {
  count: number;
  totalMs: number;
  errorCount: number;
  latencies: number[]; // circular buffer for percentile calculation
  statusCodes: Record<number, number>;
}

export interface EndpointSummary {
  method: string;
  path: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorCount: number;
  errorRate: number;
  statusCodes: Record<number, number>;
}

export interface ErrorEntry {
  timestamp: string;
  type: 'auth_failure' | 'rate_limit' | 'validation' | 'server_error' | 'not_found';
  code: string;
  message: string;
  path: string;
  method: string;
  agentId?: string;
  ip?: string;
}

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  route: string;
  status: number;
  durationMs: number;
  agentId: string | null;
  ip: string | undefined;
  userAgent: string;
  contentLength: number;
}

export interface ActivityEntry {
  timestamp: string;
  event: string;
  details: Record<string, any>;
}

// ============================================================
// MetricsStore — File persistence
// ============================================================

class MetricsStore {
  private dataDir: string;
  private writeBuffers: Map<string, string[]> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private maxLogSizeBytes = 10 * 1024 * 1024; // 10MB rotation threshold
  private writeCounters: Map<string, number> = new Map();

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(__dirname, '..', '..', 'data');
  }

  async init(): Promise<void> {
    await this.ensureDataDir();
    // Flush write buffers every 5 seconds
    this.flushInterval = setInterval(() => this.flush(), 5_000);
    if (this.flushInterval.unref) this.flushInterval.unref();
  }

  private async ensureDataDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.dataDir, { recursive: true });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  // --- Snapshot methods (atomic read/write of entire JSON) ---

  async saveSnapshot(name: string, data: any): Promise<void> {
    const filePath = path.join(this.dataDir, `${name}.json`);
    const tmpPath = `${filePath}.tmp`;
    const content = JSON.stringify(data, null, 2);
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  }

  async loadSnapshot<T>(name: string): Promise<T | null> {
    const filePath = path.join(this.dataDir, `${name}.json`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      console.error(`[Metrics] Failed to load snapshot ${name}:`, err.message);
      return null;
    }
  }

  // --- Append-only log methods (JSONL) ---

  appendLog(name: string, entry: object): void {
    const line = JSON.stringify({ ...entry, _ts: new Date().toISOString() }) + '\n';
    let buffer = this.writeBuffers.get(name);
    if (!buffer) {
      buffer = [];
      this.writeBuffers.set(name, buffer);
    }
    buffer.push(line);

    // Track writes for rotation check
    const count = (this.writeCounters.get(name) || 0) + 1;
    this.writeCounters.set(name, count);

    // Immediate flush if buffer is large
    if (buffer.length >= 500) {
      this.flushLog(name).catch(err =>
        console.error(`[Metrics] Flush error for ${name}:`, err.message)
      );
    }

    // Check rotation every 1000 writes
    if (count % 1000 === 0) {
      this.rotateIfNeeded(name).catch(() => {});
    }
  }

  async readLog<T>(name: string, opts?: { since?: string; limit?: number }): Promise<T[]> {
    const filePath = path.join(this.dataDir, `${name}.jsonl`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      let entries = lines.map(l => JSON.parse(l) as T);

      if (opts?.since) {
        entries = entries.filter((e: any) => {
          const ts = e._ts || e.timestamp;
          return ts && ts >= opts.since!;
        });
      }
      if (opts?.limit) {
        entries = entries.slice(-opts.limit);
      }
      return entries;
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async countLog(name: string): Promise<number> {
    const filePath = path.join(this.dataDir, `${name}.jsonl`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content.trim().split('\n').filter(l => l.length > 0).length;
    } catch (err: any) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async getLogSize(name: string): Promise<number> {
    const filePath = path.join(this.dataDir, `${name}.jsonl`);
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  // --- Log rotation ---

  private async rotateIfNeeded(name: string): Promise<void> {
    const size = await this.getLogSize(name);
    if (size > this.maxLogSizeBytes) {
      const filePath = path.join(this.dataDir, `${name}.jsonl`);
      const date = new Date().toISOString().split('T')[0];
      const archivePath = path.join(this.dataDir, `${name}.${date}.jsonl`);
      try {
        await fs.promises.rename(filePath, archivePath);
        console.log(`[Metrics] Rotated ${name}.jsonl → ${name}.${date}.jsonl`);
      } catch (err: any) {
        console.error(`[Metrics] Rotation error for ${name}:`, err.message);
      }
    }
  }

  // --- Flush and lifecycle ---

  private async flushLog(name: string): Promise<void> {
    const buffer = this.writeBuffers.get(name);
    if (!buffer || buffer.length === 0) return;

    const lines = buffer.splice(0, buffer.length);
    const filePath = path.join(this.dataDir, `${name}.jsonl`);
    await fs.promises.appendFile(filePath, lines.join(''), 'utf-8');
  }

  async flush(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const name of this.writeBuffers.keys()) {
      promises.push(this.flushLog(name));
    }
    await Promise.all(promises);
  }

  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }

  /** Get data directory path for reporting */
  getDataDir(): string {
    return this.dataDir;
  }

  /** List all data files with sizes */
  async listDataFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    try {
      const entries = await fs.promises.readdir(this.dataDir);
      for (const entry of entries) {
        const stat = await fs.promises.stat(path.join(this.dataDir, entry));
        const sizeKB = stat.size / 1024;
        files[entry] = sizeKB > 1024
          ? `${(sizeKB / 1024).toFixed(1)}MB`
          : `${sizeKB.toFixed(1)}KB`;
      }
    } catch {}
    return files;
  }
}

// ============================================================
// EndpointMetrics — In-memory per-endpoint aggregator
// ============================================================

const LATENCY_BUFFER_SIZE = 200; // Keep last 200 latencies per endpoint for percentiles

export class EndpointMetrics {
  private buckets: Map<string, EndpointBucket> = new Map();

  record(method: string, routePath: string, status: number, durationMs: number): void {
    const key = `${method} ${routePath}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, totalMs: 0, errorCount: 0, latencies: [], statusCodes: {} };
      this.buckets.set(key, bucket);
    }

    bucket.count++;
    bucket.totalMs += durationMs;
    if (status >= 400) bucket.errorCount++;
    bucket.statusCodes[status] = (bucket.statusCodes[status] || 0) + 1;

    // Circular buffer for latencies
    if (bucket.latencies.length >= LATENCY_BUFFER_SIZE) {
      bucket.latencies.shift();
    }
    bucket.latencies.push(durationMs);
  }

  getSummary(): EndpointSummary[] {
    const summaries: EndpointSummary[] = [];
    for (const [key, bucket] of this.buckets) {
      const [method, ...pathParts] = key.split(' ');
      const routePath = pathParts.join(' ');
      const sorted = [...bucket.latencies].sort((a, b) => a - b);

      summaries.push({
        method,
        path: routePath,
        count: bucket.count,
        avgMs: Math.round((bucket.totalMs / bucket.count) * 100) / 100,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        errorCount: bucket.errorCount,
        errorRate: Math.round((bucket.errorCount / bucket.count) * 10000) / 10000,
        statusCodes: bucket.statusCodes,
      });
    }

    // Sort by count descending
    return summaries.sort((a, b) => b.count - a.count);
  }

  getTotalRequests(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.count;
    return total;
  }

  getTotalErrors(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.errorCount;
    return total;
  }

  getSnapshot(): Record<string, any> {
    const snapshot: Record<string, any> = {};
    for (const [key, bucket] of this.buckets) {
      snapshot[key] = {
        count: bucket.count,
        totalMs: bucket.totalMs,
        errorCount: bucket.errorCount,
        statusCodes: bucket.statusCodes,
      };
    }
    return snapshot;
  }

  reset(): void {
    this.buckets.clear();
  }
}

// ============================================================
// ErrorTracker — Categorized error counters
// ============================================================

export class ErrorTracker {
  private counts: Record<string, number> = {
    auth_failure: 0,
    rate_limit: 0,
    validation: 0,
    server_error: 0,
    not_found: 0,
  };
  private recentWindow: ErrorEntry[] = [];
  private windowMs = 24 * 60 * 60 * 1000; // 24 hours

  record(entry: ErrorEntry): void {
    this.counts[entry.type] = (this.counts[entry.type] || 0) + 1;
    this.recentWindow.push(entry);
    this.pruneWindow();
  }

  private pruneWindow(): void {
    const cutoff = new Date(Date.now() - this.windowMs).toISOString();
    this.recentWindow = this.recentWindow.filter(e => e.timestamp >= cutoff);
  }

  getCounts24h(): Record<string, number> {
    this.pruneWindow();
    const counts: Record<string, number> = {
      auth_failures: 0,
      rate_limit_hits: 0,
      validation_errors: 0,
      server_errors: 0,
      not_found: 0,
    };
    for (const entry of this.recentWindow) {
      switch (entry.type) {
        case 'auth_failure': counts.auth_failures++; break;
        case 'rate_limit': counts.rate_limit_hits++; break;
        case 'validation': counts.validation_errors++; break;
        case 'server_error': counts.server_errors++; break;
        case 'not_found': counts.not_found++; break;
      }
    }
    return counts;
  }

  getTotalCounts(): Record<string, number> {
    return { ...this.counts };
  }

  getSnapshot(): { counts: Record<string, number>; recentWindow: ErrorEntry[] } {
    return { counts: { ...this.counts }, recentWindow: [...this.recentWindow] };
  }

  restore(snapshot: { counts: Record<string, number>; recentWindow: ErrorEntry[] }): void {
    if (snapshot.counts) this.counts = snapshot.counts;
    if (snapshot.recentWindow) this.recentWindow = snapshot.recentWindow;
    this.pruneWindow();
  }
}

// ============================================================
// Singletons
// ============================================================

let metricsStoreInstance: MetricsStore | null = null;
const endpointMetrics = new EndpointMetrics();
const errorTracker = new ErrorTracker();

export function getMetricsStore(dataDir?: string): MetricsStore {
  if (!metricsStoreInstance) {
    metricsStoreInstance = new MetricsStore(dataDir);
  }
  return metricsStoreInstance;
}

export function getEndpointMetrics(): EndpointMetrics {
  return endpointMetrics;
}

export function getErrorTracker(): ErrorTracker {
  return errorTracker;
}

// ============================================================
// Helpers
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}
