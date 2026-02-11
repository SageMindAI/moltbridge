/**
 * Ed25519 Auth Middleware
 *
 * Verifies: Authorization: MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>
 * Signature covers: ${method}:${path}:${timestamp}:${body_hash}
 * 60-second timestamp freshness window.
 * Looks up agent's pubkey from Neo4j.
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { getDriver } from '../db/neo4j';
import { verify, base64urlDecode } from '../crypto/keys';
import { Errors } from './errors';
import type { AuthenticatedRequest } from '../types';

// In-memory replay protection (agent_id:timestamp:signature → expiry)
// In production, use Redis with 120-second TTL
const replayCache = new Map<string, number>();

// Clean up expired entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of replayCache) {
    if (expiry < now) replayCache.delete(key);
  }
}, 60_000);

/**
 * Auth middleware. Attaches `req.auth` with { agent_id, timestamp }.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('MoltBridge-Ed25519 ')) {
    throw Errors.unauthorized('Missing or invalid Authorization header. Expected: MoltBridge-Ed25519 <agent_id>:<timestamp>:<signature>');
  }

  const token = authHeader.slice('MoltBridge-Ed25519 '.length);
  const parts = token.split(':');

  if (parts.length !== 3) {
    throw Errors.unauthorized('Invalid Authorization format. Expected: <agent_id>:<timestamp>:<signature>');
  }

  const [agentId, timestampStr, signatureB64] = parts;
  const timestamp = parseInt(timestampStr, 10);

  if (isNaN(timestamp)) {
    throw Errors.unauthorized('Invalid timestamp in Authorization header');
  }

  // Check timestamp freshness (60-second window)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 60) {
    throw Errors.unauthorized('Request timestamp is stale (>60 seconds)');
  }

  // Check replay protection
  const replayKey = `${agentId}:${timestampStr}:${signatureB64}`;
  if (replayCache.has(replayKey)) {
    throw Errors.unauthorized('Replay detected');
  }

  // Compute expected message: method:path:timestamp:body_hash
  const bodyHash = crypto
    .createHash('sha256')
    .update(req.body ? JSON.stringify(req.body) : '')
    .digest('hex');

  const message = `${req.method}:${req.path}:${timestampStr}:${bodyHash}`;
  const messageBytes = new TextEncoder().encode(message);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64urlDecode(signatureB64);
  } catch {
    throw Errors.unauthorized('Invalid signature encoding');
  }

  // Look up agent's pubkey from Neo4j and verify
  const driver = getDriver();
  const session = driver.session();

  session.run(
    'MATCH (a:Agent {id: $agentId}) RETURN a.pubkey AS pubkey',
    { agentId }
  )
    .then(result => {
      session.close();

      if (result.records.length === 0) {
        throw Errors.unauthorized(`Agent '${agentId}' not found`);
      }

      const pubkeyB64 = result.records[0].get('pubkey') as string;
      const pubkeyBytes = base64urlDecode(pubkeyB64);

      const valid = verify(signatureBytes, messageBytes, pubkeyBytes);
      if (!valid) {
        throw Errors.unauthorized('Invalid signature');
      }

      // Mark as seen for replay protection (120-second TTL)
      replayCache.set(replayKey, Date.now() + 120_000);

      // Attach auth info to request
      (req as any).auth = { agent_id: agentId, timestamp } as AuthenticatedRequest;

      next();
    })
    .catch(err => {
      session.close();
      if (err.code) {
        next(err); // MoltBridgeError
      } else {
        next(Errors.serviceUnavailable('Authentication service unavailable'));
      }
    });
}
