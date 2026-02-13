/**
 * Credibility Packet Service
 *
 * Generates signed JWT credibility packets — the core output artifact.
 * Signed with MoltBridge's Ed25519 key, verifiable by anyone via JWKS.
 */

import { v4 as uuidv4 } from 'uuid';
import * as jose from 'jose';
import { getSigningKeyPair, getKeyId, base64urlEncode } from '../crypto/keys';
import { getDriver } from '../db/neo4j';
import type { CredibilityPacketPayload } from '../types';

const PACKET_TTL_DAYS = 30;

export class CredibilityService {

  /**
   * Generate a credibility packet for a broker-mediated connection.
   */
  async generatePacket(
    requesterId: string,
    targetId: string,
    brokerId: string,
  ): Promise<string> {
    const driver = getDriver();
    const session = driver.session();

    try {
      // Fetch requester, broker, and path info
      const result = await session.run(
        `
        MATCH (requester:Agent {id: $requesterId})
        MATCH (broker:Agent {id: $brokerId})

        // Get requester's trust score
        WITH requester, broker

        // Count attestations about the broker
        OPTIONAL MATCH (attestor:Agent)-[:ATTESTED]->(broker)
        WITH requester, broker, count(attestor) AS attestation_count

        // Get clusters the broker belongs to (via their human)
        OPTIONAL MATCH (broker)-[:PAIRED_WITH]->(h:Human)-[:IN_CLUSTER]->(c:Cluster)
        WITH requester, broker, attestation_count,
             collect(DISTINCT c.name) AS broker_clusters

        // Get shared capabilities between requester and target area
        RETURN requester.trust_score AS requester_trust,
               requester.capabilities AS requester_caps,
               broker.trust_score AS broker_trust,
               broker.capabilities AS broker_caps,
               broker_clusters,
               attestation_count
        `,
        { requesterId, brokerId }
      );

      if (result.records.length === 0) {
        throw new Error('Requester or broker not found');
      }

      const record = result.records[0];
      const requesterTrust = parseFloat((record.get('requester_trust') ?? 0).toString());
      const requesterCaps: string[] = record.get('requester_caps') || [];
      const brokerCaps: string[] = record.get('broker_caps') || [];
      const brokerClusters: string[] = record.get('broker_clusters') || [];
      const rawAttestation = record.get('attestation_count');
      const attestationCount = rawAttestation && typeof rawAttestation === 'object' && 'toNumber' in rawAttestation
        ? (rawAttestation as any).toNumber()
        : rawAttestation ?? 0;

      // Compute shared interests (capability intersection)
      const sharedInterests = requesterCaps.filter(c => brokerCaps.includes(c));

      // Complementary expertise (capabilities the other has)
      const complementary = brokerCaps.filter(c => !requesterCaps.includes(c)).slice(0, 5);

      const now = Math.floor(Date.now() / 1000);
      const exp = now + PACKET_TTL_DAYS * 24 * 60 * 60;

      const payload: CredibilityPacketPayload = {
        iss: 'moltbridge',
        sub: 'credibility-packet',
        jti: uuidv4(),
        iat: now,
        exp,
        aud: targetId,
        requester: {
          agent_id: requesterId,
          trust_score: requesterTrust,
        },
        broker: {
          agent_id: brokerId,
          betweenness_rank: 0, // Simplified for Phase 1
        },
        path_summary: {
          hops: 2, // Will be computed from actual path in future
          via_clusters: brokerClusters.slice(0, 3),
          proximity_score: requesterTrust,
        },
        relevance: {
          shared_interests: sharedInterests.slice(0, 5),
          complementary_expertise: complementary,
        },
        attestation_count: attestationCount,
      };

      // Sign the JWT using jose with Ed25519
      const { privateKey } = getSigningKeyPair();
      const kid = getKeyId();

      // Import the private key for jose
      const privateKeyObj = await jose.importPKCS8(
        toPKCS8(privateKey),
        'EdDSA'
      ).catch(() => {
        // Fallback: construct the JWK directly
        return jose.importJWK({
          kty: 'OKP',
          crv: 'Ed25519',
          d: base64urlEncode(privateKey),
          x: base64urlEncode(getSigningKeyPair().publicKey),
        }, 'EdDSA');
      });

      const jwt = await new jose.SignJWT(payload as unknown as jose.JWTPayload)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
        .sign(privateKeyObj);

      return jwt;
    } finally {
      await session.close();
    }
  }

  /**
   * Verify a credibility packet JWT.
   * Returns the decoded payload if valid, throws if invalid.
   */
  async verifyPacket(token: string): Promise<CredibilityPacketPayload> {
    const { publicKey } = getSigningKeyPair();

    const publicKeyObj = await jose.importJWK({
      kty: 'OKP',
      crv: 'Ed25519',
      x: base64urlEncode(publicKey),
    }, 'EdDSA');

    const { payload } = await jose.jwtVerify(token, publicKeyObj, {
      algorithms: ['EdDSA'],  // MUST hardcode — prevents algorithm confusion attacks
      issuer: 'moltbridge',
      clockTolerance: 60,
    });

    return payload as unknown as CredibilityPacketPayload;
  }
}

/**
 * Convert raw Ed25519 private key bytes to PKCS8 PEM format.
 */
function toPKCS8(privateKey: Uint8Array): string {
  // Ed25519 PKCS8 wrapping: OID prefix + raw key
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([prefix, Buffer.from(privateKey)]);
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}
