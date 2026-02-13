/**
 * MoltBridge Key Generation Script
 *
 * Generates Ed25519 keypairs for production and development use.
 *
 * Usage:
 *   pnpm keys                        # Generate keypair, print to stdout
 *   pnpm keys -- --env               # Also append to .env file
 *   pnpm keys -- --agent-id my-agent # Generate for a specific agent
 *   pnpm keys -- --json              # Output as JSON
 *
 * The generated keys are in the formats needed by:
 *   - Server: MOLTBRIDGE_SIGNING_KEY env var (base64url-encoded 32-byte seed)
 *   - SDK clients: signing_key parameter (hex-encoded 32-byte seed)
 *   - JWKS endpoint: x parameter (base64url-encoded public key)
 */

import * as ed from '@noble/ed25519';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// noble/ed25519 v2 requires SHA-512
ed.etc.sha512Sync = (...m: Uint8Array[]) => {
  const h = crypto.createHash('sha512');
  for (const msg of m) h.update(msg);
  return new Uint8Array(h.digest());
};

function base64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function hexEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

interface GeneratedKeys {
  agentId: string;
  privateKeySeed: {
    base64url: string;
    hex: string;
  };
  publicKey: {
    base64url: string;
    hex: string;
  };
  jwk: {
    kty: string;
    crv: string;
    x: string;
    kid: string;
    use: string;
    alg: string;
  };
  envVars: {
    MOLTBRIDGE_AGENT_ID: string;
    MOLTBRIDGE_SIGNING_KEY: string;
  };
  sdkConfig: {
    typescript: string;
    python: string;
  };
}

function generateKeypair(agentId: string): GeneratedKeys {
  const privateKey = ed.utils.randomPrivateKey(); // 32-byte seed
  const publicKey = ed.getPublicKey(privateKey);

  const publicKeyB64 = base64urlEncode(publicKey);
  const privateKeyB64 = base64urlEncode(privateKey);
  const privateKeyHex = hexEncode(privateKey);

  // JWK thumbprint for Key ID (RFC 7638)
  const jwkThumbprintInput = `{"crv":"Ed25519","kty":"OKP","x":"${publicKeyB64}"}`;
  const kid = crypto.createHash('sha256').update(jwkThumbprintInput).digest('base64url');

  return {
    agentId,
    privateKeySeed: {
      base64url: privateKeyB64,
      hex: privateKeyHex,
    },
    publicKey: {
      base64url: publicKeyB64,
      hex: hexEncode(publicKey),
    },
    jwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: publicKeyB64,
      kid,
      use: 'sig',
      alg: 'EdDSA',
    },
    envVars: {
      MOLTBRIDGE_AGENT_ID: agentId,
      MOLTBRIDGE_SIGNING_KEY: privateKeyB64,
    },
    sdkConfig: {
      typescript: `const mb = new MoltBridge({\n  agentId: '${agentId}',\n  signingKey: '${privateKeyHex}',\n});`,
      python: `mb = MoltBridge(\n    agent_id="${agentId}",\n    signing_key="${privateKeyHex}",\n)`,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const writeEnv = args.includes('--env');

  let agentId = 'moltbridge-server';
  const agentIdx = args.indexOf('--agent-id');
  if (agentIdx !== -1 && args[agentIdx + 1]) {
    agentId = args[agentIdx + 1];
  }

  const keys = generateKeypair(agentId);

  if (jsonOutput) {
    console.log(JSON.stringify(keys, null, 2));
  } else {
    console.log('=== MoltBridge Ed25519 Keypair ===\n');
    console.log(`Agent ID:         ${keys.agentId}`);
    console.log(`Public Key:       ${keys.publicKey.base64url}`);
    console.log(`Key ID (kid):     ${keys.jwk.kid}`);
    console.log('');
    console.log('--- Environment Variables (server) ---');
    console.log(`MOLTBRIDGE_AGENT_ID=${keys.envVars.MOLTBRIDGE_AGENT_ID}`);
    console.log(`MOLTBRIDGE_SIGNING_KEY=${keys.envVars.MOLTBRIDGE_SIGNING_KEY}`);
    console.log('');
    console.log('--- SDK Usage ---');
    console.log('');
    console.log('TypeScript:');
    console.log(keys.sdkConfig.typescript);
    console.log('');
    console.log('Python:');
    console.log(keys.sdkConfig.python);
    console.log('');
    console.log('--- JWKS Entry (for /.well-known/jwks.json) ---');
    console.log(JSON.stringify(keys.jwk, null, 2));
    console.log('');
    console.log('IMPORTANT: Store the signing key securely. It cannot be recovered.');
  }

  if (writeEnv) {
    const envPath = path.join(process.cwd(), '.env');
    const envContent = `\n# MoltBridge Keys (generated ${new Date().toISOString()})\nMOLTBRIDGE_AGENT_ID=${keys.envVars.MOLTBRIDGE_AGENT_ID}\nMOLTBRIDGE_SIGNING_KEY=${keys.envVars.MOLTBRIDGE_SIGNING_KEY}\n`;

    fs.appendFileSync(envPath, envContent);
    console.log(`\nAppended to ${envPath}`);
  }
}

main();
