#!/usr/bin/env node
/**
 * MoltBridge CLI — Agent registration and MCP server
 *
 * Commands:
 *   npx moltbridge init    — Generate keypair, register agent, save credentials
 *   npx moltbridge serve   — Start the MCP server (requires init first)
 *   npx moltbridge status  — Check agent registration status
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { MoltBridge } from './client.js';
import { Ed25519Signer } from './auth.js';

const VERSION = '0.1.5';
const BASE_URL = process.env.MOLTBRIDGE_BASE_URL || 'https://api.moltbridge.ai';
const ENV_FILE = '.env.moltbridge';

interface Credentials {
  agentId: string;
  signingKey: string;
  publicKey: string;
}

function loadCredentials(): Credentials | null {
  // Check env vars first
  if (process.env.MOLTBRIDGE_AGENT_ID && process.env.MOLTBRIDGE_SIGNING_KEY) {
    return {
      agentId: process.env.MOLTBRIDGE_AGENT_ID,
      signingKey: process.env.MOLTBRIDGE_SIGNING_KEY,
      publicKey: '', // will be derived
    };
  }

  // Check .env.moltbridge file
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) vars[match[1]] = match[2];
    }
    if (vars.MOLTBRIDGE_AGENT_ID && vars.MOLTBRIDGE_SIGNING_KEY) {
      return {
        agentId: vars.MOLTBRIDGE_AGENT_ID,
        signingKey: vars.MOLTBRIDGE_SIGNING_KEY,
        publicKey: vars.MOLTBRIDGE_PUBLIC_KEY || '',
      };
    }
  }

  return null;
}

async function init(): Promise<void> {
  console.log('MoltBridge Agent Setup\n');

  // Check if already initialized
  const existing = loadCredentials();
  if (existing) {
    console.log(`Already initialized: agent ${existing.agentId}`);
    console.log(`Credentials in: ${existsSync(ENV_FILE) ? ENV_FILE : 'environment variables'}`);
    console.log('\nRun "npx moltbridge status" to check registration.');
    return;
  }

  // Get agent name from args or generate
  const agentName = process.argv[3] || `agent-${Date.now().toString(36)}`;
  const capabilities = process.argv[4]?.split(',') || ['general'];
  const agentId = `mb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  console.log(`Generating Ed25519 keypair...`);
  const signer = Ed25519Signer.generate(agentId);
  const publicKey = signer.publicKeyB64;
  const signingKey = signer.seedHex;

  console.log(`Agent ID: ${agentId}`);
  console.log(`Public key: ${publicKey.slice(0, 16)}...`);

  // Register with the API
  console.log(`\nRegistering with ${BASE_URL}...`);
  try {
    const mb = new MoltBridge({
      agentId,
      signingKey,
      baseUrl: BASE_URL,
    });

    await mb.verify();
    console.log('Verification: passed');

    await mb.register({
      agentId,
      name: agentName,
      platform: 'cli',
      pubkey: publicKey,
      capabilities,
      clusters: [],
      verificationToken: undefined as any,
    });
    console.log('Registration: success');
  } catch (err: any) {
    console.log(`Registration: ${err.message || 'failed (API may be updating)'}`);
    console.log('Credentials saved — you can retry registration later.');
  }

  // Save credentials
  const envContent = [
    `MOLTBRIDGE_AGENT_ID=${agentId}`,
    `MOLTBRIDGE_SIGNING_KEY=${signingKey}`,
    `MOLTBRIDGE_PUBLIC_KEY=${publicKey}`,
    `MOLTBRIDGE_BASE_URL=${BASE_URL}`,
  ].join('\n');

  writeFileSync(ENV_FILE, envContent + '\n');
  console.log(`\nCredentials saved to ${ENV_FILE}`);
  console.log('\nAdd to your shell:');
  console.log(`  source ${ENV_FILE}  # or add vars to your .env`);
  console.log('\nNext: npx moltbridge serve');
}

async function status(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.log('Not initialized. Run: npx moltbridge init [agent-name]');
    return;
  }

  console.log(`Agent ID: ${creds.agentId}`);
  console.log(`Public Key: ${creds.publicKey ? creds.publicKey.slice(0, 16) + '...' : '(derived from signing key)'}`);
  console.log(`API: ${BASE_URL}`);

  try {
    const mb = new MoltBridge({
      agentId: creds.agentId,
      signingKey: creds.signingKey,
      baseUrl: BASE_URL,
    });
    const health = await mb.health();
    console.log(`\nAPI Status: ${health.status}`);
    console.log(`Version: ${health.version}`);
  } catch (err: any) {
    console.log(`\nAPI Status: unreachable (${err.message})`);
  }
}

async function serve(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    // Use stderr for non-JSON-RPC output in serve mode
    process.stderr.write('Not initialized. Run: npx moltbridge init [agent-name]\n');
    process.exit(1);
  }

  // IMPORTANT: All informational output goes to stderr.
  // MCP uses stdout exclusively for JSON-RPC protocol messages.
  // Writing non-JSON to stdout breaks MCP clients.
  process.stderr.write(`MoltBridge MCP Server\n`);
  process.stderr.write(`Agent: ${creds.agentId}\n`);
  process.stderr.write(`API: ${BASE_URL}\n`);
  process.stderr.write(`\nMCP server starting on stdio...\n\n`);

  // MCP server over stdio (JSON-RPC)
  const mb = new MoltBridge({
    agentId: creds.agentId,
    signingKey: creds.signingKey,
    baseUrl: BASE_URL,
  });

  const tools = [
    {
      name: 'moltbridge_discover_broker',
      description: 'Find trusted broker agents who can introduce you to a target person or organization',
      inputSchema: {
        type: 'object' as const,
        properties: {
          target: { type: 'string', description: 'Name of person or org to reach' },
          context: { type: 'string', description: 'Why you want the introduction' },
        },
        required: ['target'],
      },
    },
    {
      name: 'moltbridge_discover_capability',
      description: 'Find agents with specific capabilities',
      inputSchema: {
        type: 'object' as const,
        properties: {
          needs: { type: 'array', items: { type: 'string' }, description: 'Required capabilities' },
          cluster: { type: 'string', description: 'Optional cluster filter' },
        },
        required: ['needs'],
      },
    },
    {
      name: 'moltbridge_attest',
      description: 'Record a trust attestation about another agent after an interaction',
      inputSchema: {
        type: 'object' as const,
        properties: {
          subjectId: { type: 'string', description: 'Agent ID being attested' },
          rating: { type: 'number', description: 'Trust rating 0-1' },
          context: { type: 'string', description: 'What interaction this attestation is about' },
        },
        required: ['subjectId', 'rating'],
      },
    },
    {
      name: 'moltbridge_credibility',
      description: 'Get a credibility packet for an agent (trust score, attestations, verification status)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agentId: { type: 'string', description: 'Agent ID to check' },
        },
        required: ['agentId'],
      },
    },
  ];

  // Handle MCP JSON-RPC over stdio
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin });

  const respond = (id: number | string, result: any) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };

  const respondError = (id: number | string, code: number, message: string) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  };

  rl.on('line', async (line: string) => {
    try {
      const msg = JSON.parse(line);
      const { id, method, params } = msg;

      if (method === 'initialize') {
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'moltbridge', version: VERSION },
        });
      } else if (method === 'notifications/initialized') {
        // No response needed for notifications
      } else if (method === 'tools/list') {
        respond(id, { tools });
      } else if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        try {
          let result: any;

          if (toolName === 'moltbridge_discover_broker') {
            result = await mb.discoverBroker({ target: args.target });
          } else if (toolName === 'moltbridge_discover_capability') {
            result = await mb.discoverCapability({ needs: args.needs });
          } else if (toolName === 'moltbridge_attest') {
            result = await mb.attest({
              targetAgentId: args.subjectId,
              attestationType: 'INTERACTION',
              confidence: args.rating,
            });
          } else if (toolName === 'moltbridge_credibility') {
            result = await mb.credibilityPacket(args.agentId, '');
          } else {
            respondError(id, -32601, `Unknown tool: ${toolName}`);
            return;
          }

          respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err: any) {
          respond(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      } else {
        respondError(id, -32601, `Method not found: ${method}`);
      }
    } catch {
      // Ignore malformed lines
    }
  });
}

// Route commands
const command = process.argv[2];

switch (command) {
  case 'init':
    init().catch(console.error);
    break;
  case 'serve':
    serve().catch(console.error);
    break;
  case 'status':
    status().catch(console.error);
    break;
  default:
    console.log(`MoltBridge CLI v${VERSION}

Commands:
  npx moltbridge init [name]     Generate keypair, register agent, save credentials
  npx moltbridge serve           Start the MCP server (stdio JSON-RPC)
  npx moltbridge status          Check registration status and API health

Getting started:
  1. npx moltbridge init my-agent
  2. source .env.moltbridge
  3. npx moltbridge serve

Documentation: https://moltbridge.ai
API: https://api.moltbridge.ai`);
}
