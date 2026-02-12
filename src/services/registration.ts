/**
 * Registration Service
 *
 * Creates Agent nodes in Neo4j with pubkey, capabilities, clusters.
 * Handles profile updates.
 */

import { getDriver } from '../db/neo4j';
import { MoltBridgeError, Errors } from '../middleware/errors';
import { isValidAgentId, isValidCapabilityTag, isSafeString } from '../middleware/validate';
import type { RegistrationRequest, ProfileUpdateRequest, AgentNode } from '../types';

export class RegistrationService {

  /**
   * Register a new agent in the network.
   */
  async register(request: RegistrationRequest): Promise<AgentNode> {
    // Validate inputs
    if (!isValidAgentId(request.agent_id)) {
      throw Errors.validationError('Invalid agent_id format. Use alphanumeric, hyphens, underscores (1-100 chars).');
    }
    if (!isSafeString(request.name)) {
      throw Errors.validationError('Invalid name format.');
    }
    if (!isSafeString(request.platform)) {
      throw Errors.validationError('Invalid platform format.');
    }
    if (!request.pubkey || request.pubkey.length < 20) {
      throw Errors.validationError('Invalid public key.');
    }
    for (const cap of request.capabilities) {
      if (!isValidCapabilityTag(cap)) {
        throw Errors.validationError(`Invalid capability tag: '${cap}'. Use lowercase, hyphens only.`);
      }
    }
    for (const cluster of request.clusters) {
      if (!isSafeString(cluster)) {
        throw Errors.validationError(`Invalid cluster name: '${cluster}'.`);
      }
    }

    const driver = getDriver();
    const session = driver.session();

    try {
      // Check for duplicate agent_id
      const existing = await session.run(
        'MATCH (a:Agent {id: $id}) RETURN a.id AS id',
        { id: request.agent_id }
      );

      if (existing.records.length > 0) {
        throw Errors.conflict(`Agent '${request.agent_id}' already exists`);
      }

      // Create agent node
      const now = new Date().toISOString();
      const result = await session.run(
        `
        CREATE (a:Agent {
          id: $id,
          name: $name,
          platform: $platform,
          trust_score: 0.0,
          capabilities: $capabilities,
          verified_at: $verifiedAt,
          pubkey: $pubkey,
          a2a_endpoint: $a2aEndpoint
        })
        RETURN a
        `,
        {
          id: request.agent_id,
          name: request.name,
          platform: request.platform,
          capabilities: request.capabilities,
          verifiedAt: now,
          pubkey: request.pubkey,
          a2aEndpoint: request.a2a_endpoint || null,
        }
      );

      // Create cluster memberships
      for (const clusterName of request.clusters) {
        await session.run(
          `
          MATCH (a:Agent {id: $agentId})
          MERGE (c:Cluster {name: $clusterName})
          ON CREATE SET c.type = 'general', c.description = ''
          MERGE (a)-[:PAIRED_WITH]->(:Human {alias: $agentId + '-human'})
          WITH a
          MATCH (c:Cluster {name: $clusterName})
          MERGE (a)-[:CONNECTED_TO {platform: 'moltbridge', since: $since, strength: 0.5}]->(c)
          `,
          {
            agentId: request.agent_id,
            clusterName,
            since: now,
          }
        );
      }

      const node = result.records[0].get('a').properties;
      return {
        id: node.id,
        name: node.name,
        platform: node.platform,
        trust_score: node.trust_score ?? 0,
        capabilities: node.capabilities || [],
        verified_at: node.verified_at,
        pubkey: node.pubkey,
        a2a_endpoint: node.a2a_endpoint,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Update an agent's profile.
   */
  async updateProfile(agentId: string, update: ProfileUpdateRequest): Promise<AgentNode> {
    const driver = getDriver();
    const session = driver.session();

    try {
      // Build SET clauses dynamically
      const setClauses: string[] = [];
      const params: Record<string, any> = { agentId };

      if (update.capabilities) {
        for (const cap of update.capabilities) {
          if (!isValidCapabilityTag(cap)) {
            throw Errors.validationError(`Invalid capability tag: '${cap}'`);
          }
        }
        setClauses.push('a.capabilities = $capabilities');
        params.capabilities = update.capabilities;
      }

      if (update.a2a_endpoint !== undefined) {
        setClauses.push('a.a2a_endpoint = $a2aEndpoint');
        params.a2aEndpoint = update.a2a_endpoint;
      }

      if (setClauses.length === 0) {
        throw Errors.validationError('No valid update fields provided');
      }

      const result = await session.run(
        `MATCH (a:Agent {id: $agentId}) SET ${setClauses.join(', ')} RETURN a`,
        params
      );

      if (result.records.length === 0) {
        throw Errors.agentNotFound(agentId);
      }

      const node = result.records[0].get('a').properties;
      return {
        id: node.id,
        name: node.name,
        platform: node.platform,
        trust_score: node.trust_score ?? 0,
        capabilities: node.capabilities || [],
        verified_at: node.verified_at,
        pubkey: node.pubkey,
        a2a_endpoint: node.a2a_endpoint,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get an agent by ID.
   */
  async getAgent(agentId: string): Promise<AgentNode | null> {
    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        'MATCH (a:Agent {id: $agentId}) RETURN a',
        { agentId }
      );

      if (result.records.length === 0) return null;

      const node = result.records[0].get('a').properties;
      return {
        id: node.id,
        name: node.name,
        platform: node.platform,
        trust_score: parseFloat((node.trust_score ?? 0).toString()),
        capabilities: node.capabilities || [],
        verified_at: node.verified_at,
        pubkey: node.pubkey,
        a2a_endpoint: node.a2a_endpoint,
      };
    } finally {
      await session.close();
    }
  }
}
