/**
 * MoltBridge Phase 1 Deployment Script
 *
 * Handles the full deployment lifecycle:
 *   1. Pre-flight checks (dependencies, keys, Neo4j)
 *   2. Schema bootstrap
 *   3. Build
 *   4. Cloudflare Tunnel setup (if not already configured)
 *   5. Server start
 *
 * Usage:
 *   pnpm deploy                  # Full deployment
 *   pnpm deploy -- --check       # Pre-flight checks only
 *   pnpm deploy -- --tunnel      # Set up Cloudflare Tunnel only
 *   pnpm deploy -- --no-tunnel   # Deploy without tunnel (local only)
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

const ROOT = path.resolve(__dirname, '..');

// ANSI colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function log(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  ${green('✓')} ${msg}`); }
function fail(msg: string) { console.log(`  ${red('✗')} ${msg}`); }
function warn(msg: string) { console.log(`  ${yellow('!')} ${msg}`); }
function header(msg: string) { console.log(`\n${green('===')} ${msg} ${green('===')}`); }

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  fatal?: boolean;
}

// --- Pre-flight Checks ---

async function checkNode(): Promise<CheckResult> {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    const major = parseInt(version.replace('v', '').split('.')[0], 10);
    return {
      name: 'Node.js',
      passed: major >= 18,
      message: major >= 18 ? `${version}` : `${version} (requires >= 18)`,
      fatal: major < 18,
    };
  } catch {
    return { name: 'Node.js', passed: false, message: 'Not found', fatal: true };
  }
}

async function checkNeo4j(): Promise<CheckResult> {
  const uri = process.env.NEO4J_URI;
  if (!uri) {
    return { name: 'Neo4j', passed: false, message: 'NEO4J_URI not set in .env', fatal: true };
  }
  return { name: 'Neo4j', passed: true, message: `${uri}` };
}

async function checkSigningKeys(): Promise<CheckResult> {
  const key = process.env.MOLTBRIDGE_SIGNING_KEY;
  if (!key) {
    // Check for dev keys
    const devKeys = path.join(ROOT, '.dev-keys.json');
    if (fs.existsSync(devKeys)) {
      return { name: 'Signing Keys', passed: true, message: 'Using dev keys (.dev-keys.json)' };
    }
    return {
      name: 'Signing Keys',
      passed: false,
      message: 'No MOLTBRIDGE_SIGNING_KEY env var or .dev-keys.json. Run: pnpm keys -- --env',
      fatal: false, // Server auto-generates dev keys
    };
  }
  return { name: 'Signing Keys', passed: true, message: 'MOLTBRIDGE_SIGNING_KEY configured' };
}

async function checkCloudflared(): Promise<CheckResult> {
  try {
    const version = execSync('cloudflared --version 2>&1', { encoding: 'utf-8' }).trim();
    return { name: 'Cloudflare Tunnel', passed: true, message: version.split('\n')[0] };
  } catch {
    return {
      name: 'Cloudflare Tunnel',
      passed: false,
      message: 'cloudflared not installed. Install: brew install cloudflared',
      fatal: false,
    };
  }
}

async function checkDependencies(): Promise<CheckResult> {
  const nodeModules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    return { name: 'Dependencies', passed: false, message: 'Run: pnpm install', fatal: true };
  }
  return { name: 'Dependencies', passed: true, message: 'node_modules present' };
}

async function checkEnvFile(): Promise<CheckResult> {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    return {
      name: '.env file',
      passed: false,
      message: 'No .env file. Create from .env.example',
      fatal: false,
    };
  }

  // Load env file
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  return { name: '.env file', passed: true, message: `${lines.length} variables configured` };
}

async function runPreflightChecks(): Promise<boolean> {
  header('Pre-flight Checks');

  // Load .env if exists
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: envPath });
  }

  const checks = await Promise.all([
    checkNode(),
    checkDependencies(),
    checkEnvFile(),
    checkNeo4j(),
    checkSigningKeys(),
    checkCloudflared(),
  ]);

  let allPassed = true;
  for (const check of checks) {
    if (check.passed) {
      ok(`${check.name}: ${check.message}`);
    } else if (check.fatal) {
      fail(`${check.name}: ${check.message}`);
      allPassed = false;
    } else {
      warn(`${check.name}: ${check.message}`);
    }
  }

  return allPassed;
}

// --- Schema Bootstrap ---

async function bootstrapSchema(): Promise<void> {
  header('Schema Bootstrap');
  try {
    execSync('npx tsx scripts/bootstrap-schema.ts', { cwd: ROOT, stdio: 'inherit' });
    ok('Neo4j schema constraints applied');
  } catch {
    warn('Schema bootstrap failed (Neo4j may be unavailable or schema already exists)');
  }
}

// --- Build ---

async function build(): Promise<void> {
  header('Build');
  try {
    execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
    ok('TypeScript compiled to dist/');
  } catch {
    fail('Build failed');
    process.exit(1);
  }
}

// --- Cloudflare Tunnel ---

async function setupTunnel(hostname: string, port: number): Promise<void> {
  header('Cloudflare Tunnel');

  log(`Setting up tunnel: ${hostname} → localhost:${port}`);
  log(dim('This will open a browser for Cloudflare login if not already authenticated.'));
  log('');

  const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnel.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line.includes('.trycloudflare.com')) {
      ok(`Tunnel active: ${line}`);
    }
  });

  tunnel.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line.includes('.trycloudflare.com')) {
      ok(`Tunnel URL: ${line}`);
    } else if (line.includes('Registered tunnel connection')) {
      ok('Tunnel connection registered');
    }
  });

  tunnel.on('close', (code) => {
    if (code !== 0) warn(`Tunnel exited with code ${code}`);
  });

  // Give tunnel time to establish
  await new Promise(resolve => setTimeout(resolve, 3000));
}

// --- Server Start ---

async function startServer(port: number): Promise<void> {
  header('Server Start');

  log(`Starting MoltBridge on port ${port}...`);

  const server = spawn('node', ['dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: port.toString() },
    stdio: 'inherit',
  });

  server.on('close', (code) => {
    if (code !== 0) fail(`Server exited with code ${code}`);
  });

  // Wait for server to be ready
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/health',
        method: 'GET',
        timeout: 1000,
      }, (res) => {
        if (res.statusCode === 200) {
          clearInterval(check);
          ok(`Server running on port ${port}`);
          resolve();
        }
      });
      req.on('error', () => {}); // Ignore connection errors during startup
      req.end();
    }, 500);

    // Timeout after 15 seconds
    setTimeout(() => {
      clearInterval(check);
      warn('Server health check timed out (may still be starting)');
      resolve();
    }, 15000);
  });
}

// --- Main ---

async function main() {
  console.log('\n  MoltBridge Phase 1 Deployment');
  console.log(dim('  Professional network intelligence for AI agents\n'));

  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const tunnelOnly = args.includes('--tunnel');
  const noTunnel = args.includes('--no-tunnel');
  const port = parseInt(process.env.PORT || '3040', 10);
  const hostname = process.env.MOLTBRIDGE_HOSTNAME || 'api.moltbridge.com';

  // Always run pre-flight
  const passed = await runPreflightChecks();

  if (checkOnly) {
    console.log('');
    if (passed) {
      ok('All critical checks passed. Ready to deploy.');
    } else {
      fail('Some critical checks failed. Fix issues before deploying.');
    }
    process.exit(passed ? 0 : 1);
  }

  if (!passed) {
    fail('\nCritical pre-flight checks failed. Fix issues or run with --check for details.');
    process.exit(1);
  }

  if (tunnelOnly) {
    await setupTunnel(hostname, port);
    log('\nTunnel running. Press Ctrl+C to stop.');
    return;
  }

  // Full deployment
  await bootstrapSchema();
  await build();
  await startServer(port);

  if (!noTunnel) {
    await setupTunnel(hostname, port);
  }

  header('Deployment Complete');
  ok(`MoltBridge running on port ${port}`);
  if (!noTunnel) ok(`Cloudflare Tunnel → ${hostname}`);
  log('');
  log('Endpoints:');
  log(`  Health:   http://localhost:${port}/health`);
  log(`  JWKS:     http://localhost:${port}/.well-known/jwks.json`);
  log(`  OpenAPI:  http://localhost:${port}/openapi.yaml`);
  log(`  Agent:    http://localhost:${port}/.well-known/agent.json`);
  log('');
  log('Press Ctrl+C to stop.');
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
