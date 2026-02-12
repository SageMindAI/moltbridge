/**
 * Trust Score Service
 *
 * Deterministic formula — NO LLM in the loop.
 * Phase 1 (MVP): score = 0.17*import + 0.25*attestation + 0.58*cross_verification
 * (Layer 4 transaction_score = 0 until Phase 1.5)
 */

import { getDriver } from '../db/neo4j';
import { TRUST_WEIGHTS, type TrustComponents } from '../types';

export class TrustService {

  /**
   * Compute trust components for an agent.
   */
  async computeComponents(agentId: string): Promise<TrustComponents> {
    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `
        MATCH (a:Agent {id: $agentId})

        // Layer 1: Import score — completeness of profile data
        WITH a,
             CASE
               WHEN a.name IS NOT NULL AND a.platform IS NOT NULL
                    AND size(a.capabilities) > 0 AND a.a2a_endpoint IS NOT NULL
               THEN 1.0
               WHEN a.name IS NOT NULL AND a.platform IS NOT NULL
                    AND size(a.capabilities) > 0
               THEN 0.75
               WHEN a.name IS NOT NULL AND a.platform IS NOT NULL
               THEN 0.5
               ELSE 0.25
             END AS import_score

        // Layer 2: Attestation score — count of attestations received
        OPTIONAL MATCH (other:Agent)-[att:ATTESTED]->(a)
        WITH a, import_score, count(att) AS att_count

        // Normalize: 10+ attestations = 1.0
        WITH a, import_score,
             CASE
               WHEN att_count >= 10 THEN 1.0
               ELSE toFloat(att_count) / 10.0
             END AS attestation_score

        // Layer 3: Cross-verification — mutual attestations (both directions)
        OPTIONAL MATCH (a)-[:ATTESTED]->(other:Agent)-[:ATTESTED]->(a)
        WITH a, import_score, attestation_score, count(DISTINCT other) AS cross_count

        // Also count agents whose attestations about 'a' are confirmed by 2+ others
        OPTIONAL MATCH (v1:Agent)-[:ATTESTED]->(a), (v2:Agent)-[:ATTESTED]->(a)
        WHERE v1 <> v2
        WITH a, import_score, attestation_score, cross_count,
             count(DISTINCT v1) AS multi_verified

        // Normalize cross-verification: 5+ cross-verifications = 1.0
        WITH import_score, attestation_score,
             CASE
               WHEN (cross_count + multi_verified) >= 5 THEN 1.0
               ELSE toFloat(cross_count + multi_verified) / 5.0
             END AS cross_verification_score

        RETURN import_score, attestation_score, cross_verification_score
        `,
        { agentId }
      );

      if (result.records.length === 0) {
        return { import_score: 0, attestation_score: 0, cross_verification_score: 0 };
      }

      const record = result.records[0];
      return {
        import_score: parseFloat((record.get('import_score') ?? 0).toString()),
        attestation_score: parseFloat((record.get('attestation_score') ?? 0).toString()),
        cross_verification_score: parseFloat((record.get('cross_verification_score') ?? 0).toString()),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Compute the aggregate trust score from components.
   * Phase 1 formula: 0.17*import + 0.25*attestation + 0.58*cross_verification
   */
  computeScore(components: TrustComponents): number {
    const score =
      TRUST_WEIGHTS.import * components.import_score +
      TRUST_WEIGHTS.attestation * components.attestation_score +
      TRUST_WEIGHTS.cross_verification * components.cross_verification_score;

    // Clamp to [0.0, 1.0]
    return Math.max(0, Math.min(1, parseFloat(score.toFixed(4))));
  }

  /**
   * Recalculate and persist an agent's trust score.
   */
  async recalculate(agentId: string): Promise<number> {
    const components = await this.computeComponents(agentId);
    const score = this.computeScore(components);

    const driver = getDriver();
    const session = driver.session();

    try {
      await session.run(
        'MATCH (a:Agent {id: $agentId}) SET a.trust_score = $score',
        { agentId, score }
      );
      return score;
    } finally {
      await session.close();
    }
  }
}
