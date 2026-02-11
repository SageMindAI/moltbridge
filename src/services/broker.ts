/**
 * Broker Discovery Service
 *
 * Core value: Find the best broker to bridge a connection between two nodes.
 * Uses Cypher shortestPath + degree centrality ranking.
 * AuraDB Free does NOT include GDS, so centrality is approximated via Cypher.
 */

import { getDriver } from '../db/neo4j';
import type {
  BrokerDiscoveryRequest,
  BrokerDiscoveryResponse,
  BrokerResult,
  CapabilityMatchRequest,
  CapabilityMatchResponse,
  CapabilityMatchResult,
} from '../types';

export class BrokerService {

  /**
   * Find the best broker(s) to reach a specific person.
   *
   * Algorithm:
   * 1. Find shortest paths between source and target
   * 2. Extract intermediate nodes (potential brokers)
   * 3. Rank by: degree centrality * connection strength to source * connection strength to target
   */
  async findBrokerToPerson(request: BrokerDiscoveryRequest): Promise<BrokerDiscoveryResponse> {
    const start = Date.now();
    const driver = getDriver();
    const session = driver.session();

    try {
      const maxHops = request.max_hops ?? 4;
      const maxResults = request.max_results ?? 3;

      // Find all shortest paths and extract broker candidates
      // We look for paths through Agent nodes, checking both Agent and Human targets
      const result = await session.run(
        `
        // Match source agent
        MATCH (source:Agent {id: $sourceId})

        // Match target — could be Agent or Human
        OPTIONAL MATCH (targetAgent:Agent {id: $targetId})
        OPTIONAL MATCH (targetHuman:Human {alias: $targetId})
        WITH source, COALESCE(targetAgent, targetHuman) AS target
        WHERE target IS NOT NULL

        // Find shortest paths (up to maxHops relationships)
        MATCH path = shortestPath((source)-[*1..${maxHops}]-(target))

        // Extract intermediate Agent nodes as broker candidates
        WITH path, [n IN nodes(path) WHERE n:Agent AND n <> source AND n <> target] AS brokers
        UNWIND brokers AS broker

        // Get broker's degree centrality (number of connections)
        OPTIONAL MATCH (broker)-[r:CONNECTED_TO]-()
        WITH broker, count(r) AS degree, path

        // Get connection strength to source
        OPTIONAL MATCH (broker)-[rs:CONNECTED_TO]-(source:Agent {id: $sourceId})
        WITH broker, degree, path, COALESCE(rs.strength, 0.1) AS source_strength

        // Get connection strength to target
        OPTIONAL MATCH (broker)-[rt:CONNECTED_TO]-(target)
        WHERE target.id = $targetId OR target.alias = $targetId
        WITH broker, degree, length(path) AS hops,
             COALESCE(rt.strength, 0.1) AS target_strength,
             source_strength,
             [n IN nodes(path) WHERE n:Cluster | n.name] AS clusters

        // Composite score: centrality * source_strength * target_strength
        WITH broker, degree, hops, clusters,
             (toFloat(degree) * source_strength * target_strength) AS composite_score

        RETURN DISTINCT broker.id AS broker_id,
               broker.name AS broker_name,
               broker.trust_score AS trust_score,
               hops,
               clusters,
               composite_score
        ORDER BY composite_score DESC
        LIMIT toInteger($maxResults)
        `,
        {
          sourceId: request.source_agent_id,
          targetId: request.target_identifier,
          maxResults: maxResults,
        }
      );

      if (result.records.length === 0) {
        // Check if source and target exist
        const existCheck = await session.run(
          `
          OPTIONAL MATCH (source:Agent {id: $sourceId})
          OPTIONAL MATCH (targetAgent:Agent {id: $targetId})
          OPTIONAL MATCH (targetHuman:Human {alias: $targetId})
          RETURN source IS NOT NULL AS sourceExists,
                 (targetAgent IS NOT NULL OR targetHuman IS NOT NULL) AS targetExists
          `,
          { sourceId: request.source_agent_id, targetId: request.target_identifier }
        );

        const record = existCheck.records[0];
        const sourceExists = record?.get('sourceExists');
        const targetExists = record?.get('targetExists');

        if (!sourceExists) {
          return {
            results: [],
            query_time_ms: Date.now() - start,
            path_found: false,
            message: `Source agent '${request.source_agent_id}' not found`,
          };
        }
        if (!targetExists) {
          return {
            results: [],
            query_time_ms: Date.now() - start,
            path_found: false,
            message: `Target '${request.target_identifier}' not found`,
          };
        }

        return {
          results: [],
          query_time_ms: Date.now() - start,
          path_found: false,
          message: 'No connection path exists. Consider capability matching mode instead.',
        };
      }

      const results: BrokerResult[] = result.records.map(record => ({
        broker_agent_id: record.get('broker_id'),
        broker_name: record.get('broker_name'),
        broker_trust_score: record.get('trust_score')?.toFixed?.(2)
          ? parseFloat(record.get('trust_score').toFixed(2))
          : record.get('trust_score') ?? 0,
        path_hops: typeof record.get('hops') === 'object'
          ? (record.get('hops') as any).toNumber()
          : record.get('hops'),
        via_clusters: (record.get('clusters') || []).filter(Boolean),
        composite_score: typeof record.get('composite_score') === 'object'
          ? parseFloat((record.get('composite_score') as any).toNumber().toFixed(4))
          : parseFloat((record.get('composite_score') ?? 0).toFixed?.(4) ?? '0'),
      }));

      return {
        results,
        query_time_ms: Date.now() - start,
        path_found: true,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Find agents matching capability needs.
   * Tag intersection + trust_score ranking.
   */
  async findCapabilityMatch(request: CapabilityMatchRequest): Promise<CapabilityMatchResponse> {
    const start = Date.now();
    const driver = getDriver();
    const session = driver.session();

    try {
      const minTrust = request.min_trust_score ?? 0.0;
      const maxResults = request.max_results ?? 10;

      const result = await session.run(
        `
        MATCH (a:Agent)
        WHERE a.trust_score >= $minTrust

        // Count how many of the requested capabilities this agent has
        WITH a, [cap IN $capabilities WHERE cap IN a.capabilities] AS matched
        WHERE size(matched) > 0

        // Match score: fraction of requested capabilities matched, weighted by trust
        WITH a, matched,
             (toFloat(size(matched)) / toFloat(size($capabilities))) * a.trust_score AS match_score

        RETURN a.id AS agent_id,
               a.name AS agent_name,
               a.trust_score AS trust_score,
               matched AS matched_capabilities,
               match_score
        ORDER BY match_score DESC
        LIMIT toInteger($maxResults)
        `,
        {
          capabilities: request.capabilities,
          minTrust: minTrust,
          maxResults: maxResults,
        }
      );

      const results: CapabilityMatchResult[] = result.records.map(record => ({
        agent_id: record.get('agent_id'),
        agent_name: record.get('agent_name'),
        trust_score: parseFloat((record.get('trust_score') ?? 0).toString()),
        matched_capabilities: record.get('matched_capabilities') || [],
        match_score: parseFloat((record.get('match_score') ?? 0).toString()),
      }));

      return {
        results,
        query_time_ms: Date.now() - start,
      };
    } finally {
      await session.close();
    }
  }
}
