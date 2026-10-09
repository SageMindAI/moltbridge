/**
 * Scoring Service — Multi-dimensional Network Readiness Scoring
 *
 * Computes a 0-100 readiness score for reaching a target person through the graph.
 * Five dimensions: Path Exists (40), Path Quality (20), Broker Quality (15),
 * Cluster Overlap (15), Redundancy (10).
 *
 * All queries use parameterized Cypher with read-only sessions and 5-second timeouts.
 * Cluster overlap traversal capped at 500 nodes per neighborhood.
 */

import { getDriver } from '../db/neo4j';
import type { ScoreDimensions, GapAnalysis, ReadinessScore } from '../types';

const QUERY_TIMEOUT_MS = 5000;

export class ScoringService {

  /**
   * Compute full readiness score for reaching a target from a source agent.
   */
  async computeScore(
    sourceAgentId: string,
    targetIdentifier: string,
    maxHops: number = 4,
  ): Promise<ReadinessScore> {
    const start = Date.now();
    const dimensions: ScoreDimensions = {
      path_exists: 0,
      path_quality: 0,
      broker_quality: 0,
      cluster_overlap: 0,
      redundancy: 0,
    };
    let partial = false;

    // Run scoring dimensions — each with individual timeout protection
    const [pathResult, clusterResult, redundancyResult] = await Promise.allSettled([
      this.scorePath(sourceAgentId, targetIdentifier, maxHops),
      this.scoreClusterOverlap(sourceAgentId, targetIdentifier),
      this.scoreRedundancy(sourceAgentId, targetIdentifier, maxHops),
    ]);

    if (pathResult.status === 'fulfilled') {
      dimensions.path_exists = pathResult.value.pathExists;
      dimensions.path_quality = pathResult.value.pathQuality;
      dimensions.broker_quality = pathResult.value.brokerQuality;
    } else {
      dimensions.path_exists = 'timeout';
      dimensions.path_quality = 'timeout';
      dimensions.broker_quality = 'timeout';
      partial = true;
    }

    if (clusterResult.status === 'fulfilled') {
      dimensions.cluster_overlap = clusterResult.value;
    } else {
      dimensions.cluster_overlap = 'timeout';
      partial = true;
    }

    if (redundancyResult.status === 'fulfilled') {
      dimensions.redundancy = redundancyResult.value;
    } else {
      dimensions.redundancy = 'timeout';
      partial = true;
    }

    // Compute total (only numeric dimensions count)
    const total = Object.values(dimensions).reduce((sum: number, v) => {
      return sum + (typeof v === 'number' ? v : 0);
    }, 0);

    // Build gap analysis
    const gapAnalysis = await this.buildGapAnalysis(
      sourceAgentId,
      targetIdentifier,
      total,
      dimensions.path_exists === 0 || dimensions.path_exists === 'timeout',
    );

    return {
      total: Math.round(total * 100) / 100,
      partial,
      dimensions,
      gap_analysis: gapAnalysis,
      scored_at: new Date().toISOString(),
    };
  }

  /**
   * Score path-related dimensions: path_exists (40), path_quality (20), broker_quality (15).
   */
  private async scorePath(
    sourceAgentId: string,
    targetIdentifier: string,
    maxHops: number,
  ): Promise<{ pathExists: number; pathQuality: number; brokerQuality: number }> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `
        MATCH (source:Agent {id: $sourceId})
        OPTIONAL MATCH (targetAgent:Agent {id: $targetId})
        OPTIONAL MATCH (targetHuman:Human {alias: $targetId})
        WITH source, COALESCE(targetAgent, targetHuman) AS target
        WHERE target IS NOT NULL

        // Find shortest path
        OPTIONAL MATCH path = shortestPath((source)-[*1..${Math.min(maxHops, 6)}]-(target))

        WITH path, target,
             CASE WHEN path IS NOT NULL THEN length(path) ELSE -1 END AS hops,
             CASE WHEN path IS NOT NULL
               THEN [r IN relationships(path) WHERE type(r) = 'CONNECTED_TO' | COALESCE(r.strength, 0.5)]
               ELSE [] END AS strengths,
             CASE WHEN path IS NOT NULL
               THEN [n IN nodes(path) WHERE n:Agent AND n <> source AND n <> target | n.trust_score]
               ELSE [] END AS brokerTrusts

        RETURN hops,
               CASE WHEN size(strengths) > 0 THEN reduce(m = 1.0, s IN strengths | CASE WHEN s < m THEN s ELSE m END) ELSE 0.0 END AS minStrength,
               CASE WHEN size(brokerTrusts) > 0 THEN reduce(sum = 0.0, t IN brokerTrusts | sum + COALESCE(t, 0.5)) / size(brokerTrusts) ELSE 0.0 END AS avgBrokerTrust
        `,
        { sourceId: sourceAgentId, targetId: targetIdentifier },
        { timeout: QUERY_TIMEOUT_MS },
      );

      if (result.records.length === 0) {
        return { pathExists: 0, pathQuality: 0, brokerQuality: 0 };
      }

      const record = result.records[0];
      const hops = this.toNumber(record.get('hops'));
      const minStrength = this.toNumber(record.get('minStrength'));
      const avgBrokerTrust = this.toNumber(record.get('avgBrokerTrust'));

      if (hops < 0) {
        return { pathExists: 0, pathQuality: 0, brokerQuality: 0 };
      }

      // Path exists: 40 points
      const pathExists = 40;

      // Path quality: 20 * (1 - (hops-1)/maxHops) * minStrength
      const pathQuality = Math.max(0, 20 * (1 - (hops - 1) / maxHops) * minStrength);

      // Broker quality: 15 * avgBrokerTrust
      const brokerQuality = 15 * avgBrokerTrust;

      return {
        pathExists,
        pathQuality: Math.round(pathQuality * 100) / 100,
        brokerQuality: Math.round(brokerQuality * 100) / 100,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Score cluster overlap dimension (0-15).
   * Counts shared clusters between source's 2-hop neighborhood and target's 2-hop neighborhood.
   */
  private async scoreClusterOverlap(
    sourceAgentId: string,
    targetIdentifier: string,
  ): Promise<number> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `
        // Source's clusters (via 2-hop neighborhood, max 500 nodes)
        MATCH (source:Agent {id: $sourceId})
        OPTIONAL MATCH (source)-[:CONNECTED_TO|PAIRED_WITH*1..2]-(neighbor)
        WITH source, collect(DISTINCT neighbor)[..500] AS neighbors
        UNWIND ([source] + neighbors) AS node
        OPTIONAL MATCH (node)-[:IN_CLUSTER]->(c:Cluster)
        WITH collect(DISTINCT c.name) AS sourceClusters

        // Target's clusters (via 2-hop neighborhood, max 500 nodes)
        OPTIONAL MATCH (targetAgent:Agent {id: $targetId})
        OPTIONAL MATCH (targetHuman:Human {alias: $targetId})
        WITH sourceClusters, COALESCE(targetAgent, targetHuman) AS target
        WHERE target IS NOT NULL
        OPTIONAL MATCH (target)-[:CONNECTED_TO|PAIRED_WITH*1..2]-(neighbor2)
        WITH sourceClusters, target, collect(DISTINCT neighbor2)[..500] AS neighbors2
        UNWIND ([target] + neighbors2) AS node2
        OPTIONAL MATCH (node2)-[:IN_CLUSTER]->(c2:Cluster)
        WITH sourceClusters, collect(DISTINCT c2.name) AS targetClusters

        // Count shared clusters
        WITH sourceClusters, targetClusters,
             [c IN sourceClusters WHERE c IN targetClusters] AS shared

        RETURN size(shared) AS sharedCount, sourceClusters, targetClusters
        `,
        { sourceId: sourceAgentId, targetId: targetIdentifier },
        { timeout: QUERY_TIMEOUT_MS },
      );

      if (result.records.length === 0) return 0;

      const sharedCount = this.toNumber(result.records[0].get('sharedCount'));

      // 15 * min(shared/3, 1.0) — 3+ shared clusters = full points
      return Math.round(15 * Math.min(sharedCount / 3, 1.0) * 100) / 100;
    } finally {
      await session.close();
    }
  }

  /**
   * Score redundancy dimension (0-10).
   * Count of independent shortest paths.
   */
  private async scoreRedundancy(
    sourceAgentId: string,
    targetIdentifier: string,
    maxHops: number,
  ): Promise<number> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `
        MATCH (source:Agent {id: $sourceId})
        OPTIONAL MATCH (targetAgent:Agent {id: $targetId})
        OPTIONAL MATCH (targetHuman:Human {alias: $targetId})
        WITH source, COALESCE(targetAgent, targetHuman) AS target
        WHERE target IS NOT NULL

        // Find all shortest paths (limited to 10)
        OPTIONAL MATCH paths = allShortestPaths((source)-[*1..${Math.min(maxHops, 6)}]-(target))
        WITH collect(paths)[..10] AS allPaths

        RETURN size(allPaths) AS pathCount
        `,
        { sourceId: sourceAgentId, targetId: targetIdentifier },
        { timeout: QUERY_TIMEOUT_MS },
      );

      if (result.records.length === 0) return 0;

      const pathCount = this.toNumber(result.records[0].get('pathCount'));

      // 10 * min(pathCount/3, 1.0) — 3+ paths = full points
      return Math.round(10 * Math.min(pathCount / 3, 1.0) * 100) / 100;
    } finally {
      await session.close();
    }
  }

  /**
   * Build privacy-respecting gap analysis.
   */
  private async buildGapAnalysis(
    sourceAgentId: string,
    targetIdentifier: string,
    totalScore: number,
    noPath: boolean,
  ): Promise<GapAnalysis> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      // Get cluster domains for source and target neighborhoods
      const result = await session.run(
        `
        // Source clusters
        MATCH (source:Agent {id: $sourceId})
        OPTIONAL MATCH (source)-[:IN_CLUSTER]->(sc:Cluster)
        WITH source, collect(DISTINCT COALESCE(sc.type, sc.name)) AS sourceClusterDomains

        // Target clusters
        OPTIONAL MATCH (targetAgent:Agent {id: $targetId})
        OPTIONAL MATCH (targetHuman:Human {alias: $targetId})
        WITH sourceClusterDomains, COALESCE(targetAgent, targetHuman) AS target
        WHERE target IS NOT NULL
        OPTIONAL MATCH (target)-[:IN_CLUSTER]->(tc:Cluster)
        WITH sourceClusterDomains, collect(DISTINCT COALESCE(tc.type, tc.name)) AS targetClusterDomains

        // Check if any bridge node exists (without revealing identity)
        OPTIONAL MATCH (bridge:Agent)
        WHERE EXISTS {
          MATCH (bridge)-[:CONNECTED_TO]-(:Agent {id: $sourceId})
        } AND EXISTS {
          MATCH (bridge)-[:IN_CLUSTER]->(bc:Cluster)
          WHERE COALESCE(bc.type, bc.name) IN targetClusterDomains
        }
        WITH sourceClusterDomains, targetClusterDomains, count(bridge) > 0 AS bridgeAvailable

        RETURN sourceClusterDomains, targetClusterDomains, bridgeAvailable
        `,
        { sourceId: sourceAgentId, targetId: targetIdentifier },
        { timeout: QUERY_TIMEOUT_MS },
      );

      if (result.records.length === 0) {
        return {
          no_path: noPath,
          target_cluster_domains: [],
          source_cluster_domains: [],
          bridge_available: false,
          missing_link_type: 'Target not found in the network',
          recommended_cluster_domains: [],
        };
      }

      const record = result.records[0];
      const sourceClusterDomains: string[] = record.get('sourceClusterDomains') || [];
      const targetClusterDomains: string[] = record.get('targetClusterDomains') || [];
      const bridgeAvailable: boolean = record.get('bridgeAvailable') || false;

      // Only show cluster details based on score tier
      const visibleTargetDomains = totalScore >= 30 ? targetClusterDomains : targetClusterDomains.slice(0, 3);
      const visibleSourceDomains = totalScore >= 30 ? sourceClusterDomains : sourceClusterDomains.slice(0, 3);

      // Recommended: target domains not in source domains
      const recommended = targetClusterDomains.filter(d => !sourceClusterDomains.includes(d));

      // Build missing link description
      let missingLinkType = '';
      if (noPath && recommended.length > 0) {
        missingLinkType = `Need an agent connected to both your network and the ${recommended.slice(0, 2).join('/')} space`;
      } else if (noPath) {
        missingLinkType = 'No connection path exists. Network growth in shared interest areas would help.';
      } else {
        missingLinkType = 'Path exists but could be strengthened with additional connections';
      }

      return {
        no_path: noPath,
        target_cluster_domains: visibleTargetDomains,
        source_cluster_domains: visibleSourceDomains,
        bridge_available: bridgeAvailable,
        missing_link_type: missingLinkType,
        recommended_cluster_domains: recommended.slice(0, 5),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Helper: safely convert Neo4j integer to JS number.
   */
  private toNumber(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'object' && typeof value.toNumber === 'function') {
      return value.toNumber();
    }
    return Number(value) || 0;
  }
}
