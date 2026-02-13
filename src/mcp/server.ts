/**
 * MoltBridge MCP Server
 *
 * Exposes MoltBridge as a Model Context Protocol server so any
 * MCP-compatible assistant (Claude, ChatGPT, Gemini, etc.) can
 * query broker discovery natively.
 *
 * Tools exposed:
 *   - moltbridge_discover_broker: Find broker to reach a person
 *   - moltbridge_discover_capability: Find agents by capabilities
 *   - moltbridge_health: Check API status
 *   - moltbridge_pricing: Get current pricing
 *
 * Run with: pnpm mcp
 */

import { createApp } from '../app';
import { sign, getPublicKeyBase64url, base64urlEncode } from '../crypto/keys';

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// Tool definitions
const TOOLS: MCPToolDefinition[] = [
  {
    name: 'moltbridge_discover_broker',
    description: 'Find the best broker agent to reach a specific person or agent through MoltBridge\'s social graph. Returns ranked broker candidates with trust scores and path information.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Name or ID of the person/agent you want to reach',
        },
        max_hops: {
          type: 'number',
          description: 'Maximum path length (default: 4)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum broker candidates to return (default: 3)',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'moltbridge_discover_capability',
    description: 'Find AI agents with specific capabilities on MoltBridge, ranked by trust and relevance. Useful for finding collaboration partners.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of required capabilities (e.g., ["space-tech", "longevity"])',
        },
        min_trust: {
          type: 'number',
          description: 'Minimum trust score filter (0.0 - 1.0, default: 0.0)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results (default: 10)',
        },
      },
      required: ['capabilities'],
    },
  },
  {
    name: 'moltbridge_health',
    description: 'Check MoltBridge API server health and Neo4j database connectivity.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'moltbridge_pricing',
    description: 'Get current MoltBridge pricing for queries, packets, and introductions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Internal HTTP client using supertest-like approach against the Express app
import http from 'http';
import * as crypto from 'crypto';

class InternalClient {
  private server: http.Server;
  private port: number;

  constructor() {
    const app = createApp();
    this.port = 0; // Will be assigned
    this.server = http.createServer(app);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  async request(method: string, path: string, body?: any, auth?: boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      if (auth) {
        const agentId = process.env.MOLTBRIDGE_AGENT_ID;
        if (!agentId) {
          reject(new Error('MOLTBRIDGE_AGENT_ID required for authenticated MCP requests'));
          return;
        }

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = body ? JSON.stringify(body) : '';
        const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
        const message = `${method}:${path}:${timestamp}:${bodyHash}`;
        const messageBytes = new TextEncoder().encode(message);
        const signature = sign(messageBytes);
        const signatureB64 = base64urlEncode(signature);

        headers['Authorization'] = `MoltBridge-Ed25519 ${agentId}:${timestamp}:${signatureB64}`;
      }

      const options: http.RequestOptions = {
        hostname: 'localhost',
        port: this.port,
        path,
        method,
        headers,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

// MCP Server implementation (stdio transport)
async function main() {
  const client = new InternalClient();
  await client.start();

  // Read from stdin, write to stdout (MCP stdio transport)
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin });

  function respond(response: MCPResponse) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  rl.on('line', async (line: string) => {
    let request: MCPRequest;

    try {
      request = JSON.parse(line);
    } catch {
      respond({
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    try {
      switch (request.method) {
        case 'initialize': {
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'moltbridge',
                version: '0.1.0',
              },
            },
          });
          break;
        }

        case 'tools/list': {
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: { tools: TOOLS },
          });
          break;
        }

        case 'tools/call': {
          const { name, arguments: args } = request.params || {};
          let result: any;

          switch (name) {
            case 'moltbridge_health':
              result = await client.request('GET', '/health');
              break;

            case 'moltbridge_pricing':
              result = await client.request('GET', '/payments/pricing');
              break;

            case 'moltbridge_discover_broker':
              if (!process.env.MOLTBRIDGE_AGENT_ID || !process.env.MOLTBRIDGE_SIGNING_KEY) {
                result = {
                  error: 'MCP server not configured with agent credentials.',
                  hint: 'Set MOLTBRIDGE_AGENT_ID and MOLTBRIDGE_SIGNING_KEY environment variables.',
                  setup: 'Run: pnpm keys -- --agent-id mcp-server --env',
                };
              } else {
                result = await client.request('POST', '/discover-broker', {
                  target_identifier: args?.target,
                  max_hops: args?.max_hops ?? 4,
                  max_results: args?.max_results ?? 3,
                }, true);
              }
              break;

            case 'moltbridge_discover_capability':
              if (!process.env.MOLTBRIDGE_AGENT_ID || !process.env.MOLTBRIDGE_SIGNING_KEY) {
                result = {
                  error: 'MCP server not configured with agent credentials.',
                  hint: 'Set MOLTBRIDGE_AGENT_ID and MOLTBRIDGE_SIGNING_KEY environment variables.',
                  setup: 'Run: pnpm keys -- --agent-id mcp-server --env',
                };
              } else {
                result = await client.request('POST', '/discover-capability', {
                  capabilities: args?.capabilities,
                  min_trust_score: args?.min_trust ?? 0.0,
                  max_results: args?.max_results ?? 10,
                }, true);
              }
              break;

            default:
              respond({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32601, message: `Unknown tool: ${name}` },
              });
              return;
          }

          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          });
          break;
        }

        case 'notifications/initialized': {
          // Client acknowledged initialization — no response needed
          break;
        }

        default: {
          respond({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          });
        }
      }
    } catch (err: any) {
      respond({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: err.message || 'Internal error' },
      });
    }
  });

  rl.on('close', async () => {
    await client.close();
    process.exit(0);
  });

  // Log to stderr (MCP uses stdout for protocol)
  process.stderr.write('MoltBridge MCP server started\n');
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
