/**
 * Connection Goals Service
 *
 * CRUD operations for connection goals with consent checks, expiration,
 * audit logging, and stale-marking support.
 *
 * Goals are stored as Neo4j nodes linked to the source agent via HAS_GOAL.
 * All Cypher queries use parameterized inputs.
 */

import * as crypto from 'crypto';
import { getDriver } from '../db/neo4j';
import { ScoringService } from './scoring';
import type {
  ConnectionGoal,
  ConnectionGoalSummary,
  ReadinessScore,
  TargetingGoalInfo,
} from '../types';

const MAX_GOALS_PER_AGENT = 10;
const GOAL_EXPIRY_DAYS = 90;
const RESCORE_COOLDOWN_MS = 60_000; // 1 minute

export class GoalService {
  private scoringService: ScoringService;
  private rescoreCooldowns: Map<string, number> = new Map();

  constructor() {
    this.scoringService = new ScoringService();
  }

  /**
   * Create a new connection goal.
   */
  async createGoal(
    sourceAgentId: string,
    targetIdentifier: string,
    targetType: 'human' | 'agent' = 'human',
    description: string = '',
    notifyThreshold: number | null = null,
    maxHops: number = 4,
  ): Promise<{ goal: ConnectionGoal; score: ReadinessScore }> {
    const driver = getDriver();
    const session = driver.session();

    try {
      // Check goal limit
      const countResult = await session.run(
        `MATCH (a:Agent {id: $agentId})-[:HAS_GOAL]->(g:ConnectionGoal)
         WHERE g.expires_at > datetime().epochMillis
         RETURN count(g) AS goalCount`,
        { agentId: sourceAgentId },
      );
      const goalCount = this.toNumber(countResult.records[0]?.get('goalCount'));
      if (goalCount >= MAX_GOALS_PER_AGENT) {
        throw new Error(`GOAL_LIMIT: Maximum ${MAX_GOALS_PER_AGENT} active goals per agent`);
      }

      // Check for existing goal with same target
      const existingResult = await session.run(
        `MATCH (a:Agent {id: $agentId})-[:HAS_GOAL]->(g:ConnectionGoal {target_identifier: $targetId})
         WHERE g.expires_at > datetime().epochMillis
         RETURN g.id AS goalId`,
        { agentId: sourceAgentId, targetId: targetIdentifier },
      );
      if (existingResult.records.length > 0) {
        throw new Error(`GOAL_EXISTS: Active goal already exists for target '${targetIdentifier}'`);
      }

      // Check target exists
      const targetCheck = await session.run(
        `OPTIONAL MATCH (a:Agent {id: $targetId})
         OPTIONAL MATCH (h:Human {alias: $targetId})
         RETURN (a IS NOT NULL OR h IS NOT NULL) AS exists`,
        { targetId: targetIdentifier },
      );
      const targetExists = targetCheck.records[0]?.get('exists');
      if (!targetExists) {
        throw new Error(`TARGET_NOT_FOUND: Target '${targetIdentifier}' not found in the network`);
      }

      // Generate goal
      const goalId = `cg-${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + GOAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      // Compute initial score
      const score = await this.scoringService.computeScore(sourceAgentId, targetIdentifier, maxHops);

      // Create goal node and link to agent
      await session.run(
        `MATCH (a:Agent {id: $agentId})
         CREATE (g:ConnectionGoal {
           id: $goalId,
           source_agent_id: $agentId,
           target_identifier: $targetId,
           target_type: $targetType,
           description: $description,
           notify_threshold: $notifyThreshold,
           max_hops: $maxHops,
           current_score: $currentScore,
           stale: false,
           last_scored_at: $scoredAt,
           created_at: $createdAt,
           expires_at: $expiresAt,
           notified: false
         })
         CREATE (a)-[:HAS_GOAL]->(g)
         RETURN g`,
        {
          agentId: sourceAgentId,
          goalId,
          targetId: targetIdentifier,
          targetType,
          description: description.substring(0, 500),
          notifyThreshold: notifyThreshold,
          maxHops: Math.min(Math.max(maxHops, 1), 6),
          currentScore: score.total,
          scoredAt: now.toISOString(),
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      );

      console.log(`[goal:create] agent=${sourceAgentId} target=${targetIdentifier} goal=${goalId} score=${score.total}`);

      const goal: ConnectionGoal = {
        id: goalId,
        source_agent_id: sourceAgentId,
        target_identifier: targetIdentifier,
        target_type: targetType,
        description,
        notify_threshold: notifyThreshold,
        max_hops: maxHops,
        current_score: score.total,
        stale: false,
        last_scored_at: now.toISOString(),
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        notified: false,
      };

      return { goal, score };
    } finally {
      await session.close();
    }
  }

  /**
   * Get a goal by ID (must be owned by the agent).
   */
  async getGoal(agentId: string, goalId: string): Promise<{ goal: ConnectionGoal; score: ReadinessScore } | null> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `MATCH (a:Agent {id: $agentId})-[:HAS_GOAL]->(g:ConnectionGoal {id: $goalId})
         RETURN g`,
        { agentId, goalId },
      );

      if (result.records.length === 0) return null;

      const node = result.records[0].get('g').properties;
      const goal = this.nodeToGoal(node);

      // Return cached score (not fresh — use rescore for fresh)
      const score: ReadinessScore = {
        total: goal.current_score,
        partial: false,
        dimensions: {
          path_exists: 0, path_quality: 0, broker_quality: 0,
          cluster_overlap: 0, redundancy: 0,
        },
        gap_analysis: {
          no_path: false, target_cluster_domains: [], source_cluster_domains: [],
          bridge_available: false, missing_link_type: '', recommended_cluster_domains: [],
        },
        scored_at: goal.last_scored_at,
      };

      return { goal, score };
    } finally {
      await session.close();
    }
  }

  /**
   * List all goals for an agent.
   */
  async listGoals(agentId: string): Promise<ConnectionGoalSummary[]> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `MATCH (a:Agent {id: $agentId})-[:HAS_GOAL]->(g:ConnectionGoal)
         RETURN g
         ORDER BY g.created_at DESC`,
        { agentId },
      );

      return result.records.map(record => {
        const node = record.get('g').properties;
        return {
          goal_id: node.id,
          target_identifier: node.target_identifier,
          current_score: this.toNumber(node.current_score),
          notify_threshold: node.notify_threshold !== null ? this.toNumber(node.notify_threshold) : null,
          stale: Boolean(node.stale),
          expires_at: node.expires_at,
          last_scored_at: node.last_scored_at,
          created_at: node.created_at,
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Force rescore a goal. Returns updated score.
   */
  async rescoreGoal(agentId: string, goalId: string): Promise<{ goal: ConnectionGoal; score: ReadinessScore } | null> {
    // Check cooldown
    const cooldownKey = `${agentId}:${goalId}`;
    const lastRescore = this.rescoreCooldowns.get(cooldownKey) || 0;
    if (Date.now() - lastRescore < RESCORE_COOLDOWN_MS) {
      throw new Error('RESCORE_COOLDOWN: Wait at least 1 minute between rescores');
    }

    const driver = getDriver();
    const session = driver.session();

    try {
      // Verify ownership
      const goalResult = await session.run(
        `MATCH (a:Agent {id: $agentId})-[:HAS_GOAL]->(g:ConnectionGoal {id: $goalId})
         RETURN g`,
        { agentId, goalId },
      );

      if (goalResult.records.length === 0) return null;

      const node = goalResult.records[0].get('g').properties;
      const maxHops = this.toNumber(node.max_hops) || 4;
      const previousScore = this.toNumber(node.current_score);

      // Compute fresh score
      const score = await this.scoringService.computeScore(agentId, node.target_identifier, maxHops);

      // Update goal in Neo4j
      await session.run(
        `MATCH (g:ConnectionGoal {id: $goalId})
         SET g.current_score = $score,
             g.last_scored_at = $scoredAt,
             g.stale = false
         RETURN g`,
        {
          goalId,
          score: score.total,
          scoredAt: score.scored_at,
        },
      );

      this.rescoreCooldowns.set(cooldownKey, Date.now());

      console.log(`[goal:rescore] agent=${agentId} goal=${goalId} score=${previousScore}->${score.total}`);

      // Check if threshold crossed (for webhook notification)
      const notifyThreshold = node.notify_threshold !== null ? this.toNumber(node.notify_threshold) : null;
      const notified = Boolean(node.notified);

      if (notifyThreshold && !notified && previousScore < notifyThreshold && score.total >= notifyThreshold) {
        // Mark as notified
        await session.run(
          `MATCH (g:ConnectionGoal {id: $goalId}) SET g.notified = true`,
          { goalId },
        );

        // Return with notification flag
        const goal = this.nodeToGoal({ ...node, current_score: score.total, stale: false, last_scored_at: score.scored_at, notified: true });
        return { goal, score: { ...score, _thresholdCrossed: true, _previousScore: previousScore } as any };
      }

      const goal = this.nodeToGoal({ ...node, current_score: score.total, stale: false, last_scored_at: score.scored_at });
      return { goal, score };
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a goal.
   */
  async deleteGoal(agentId: string, goalId: string): Promise<boolean> {
    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `MATCH (a:Agent {id: $agentId})-[:HAS_GOAL]->(g:ConnectionGoal {id: $goalId})
         DETACH DELETE g
         RETURN count(*) AS deleted`,
        { agentId, goalId },
      );

      const deleted = this.toNumber(result.records[0]?.get('deleted')) > 0;
      if (deleted) {
        console.log(`[goal:delete] agent=${agentId} goal=${goalId}`);
      }
      return deleted;
    } finally {
      await session.close();
    }
  }

  /**
   * Get goals targeting a specific agent or human.
   */
  async getGoalsTargetingMe(targetIdentifier: string): Promise<TargetingGoalInfo[]> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `MATCH (g:ConnectionGoal {target_identifier: $targetId})
         WHERE g.expires_at > datetime().epochMillis
         RETURN g.id AS goalId, g.source_agent_id AS sourceAgent,
                g.created_at AS createdAt, g.expires_at AS expiresAt`,
        { targetId: targetIdentifier },
      );

      console.log(`[goal:targeting-query] target=${targetIdentifier} goals=${result.records.length}`);

      return result.records.map(record => ({
        goal_id: record.get('goalId'),
        source_agent_id: record.get('sourceAgent'),
        created_at: record.get('createdAt'),
        expires_at: record.get('expiresAt'),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a goal that targets you (right to erasure).
   */
  async deleteGoalTargetingMe(targetIdentifier: string, goalId: string): Promise<boolean> {
    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `MATCH (g:ConnectionGoal {id: $goalId, target_identifier: $targetId})
         DETACH DELETE g
         RETURN count(*) AS deleted`,
        { goalId, targetId: targetIdentifier },
      );

      const deleted = this.toNumber(result.records[0]?.get('deleted')) > 0;
      if (deleted) {
        console.log(`[goal:target-erasure] target=${targetIdentifier} goal=${goalId}`);
      }
      return deleted;
    } finally {
      await session.close();
    }
  }

  /**
   * Mark all goals as stale (called when graph changes — new agent, new connection).
   */
  async markAllGoalsStale(): Promise<number> {
    const driver = getDriver();
    const session = driver.session();

    try {
      const result = await session.run(
        `MATCH (g:ConnectionGoal)
         WHERE g.stale = false
         SET g.stale = true
         RETURN count(g) AS marked`,
      );

      return this.toNumber(result.records[0]?.get('marked'));
    } finally {
      await session.close();
    }
  }

  /**
   * Get stale goals that have notification thresholds (for background rescore job).
   * Returns at most `limit` goals.
   */
  async getStaleGoalsWithThresholds(limit: number = 50): Promise<Array<{ goalId: string; agentId: string; targetId: string; maxHops: number }>> {
    const driver = getDriver();
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
      const result = await session.run(
        `MATCH (a:Agent)-[:HAS_GOAL]->(g:ConnectionGoal)
         WHERE g.stale = true AND g.notify_threshold IS NOT NULL AND g.notified = false
         RETURN g.id AS goalId, a.id AS agentId, g.target_identifier AS targetId, g.max_hops AS maxHops
         LIMIT toInteger($limit)`,
        { limit },
      );

      return result.records.map(record => ({
        goalId: record.get('goalId'),
        agentId: record.get('agentId'),
        targetId: record.get('targetId'),
        maxHops: this.toNumber(record.get('maxHops')) || 4,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Convert a Neo4j node to a ConnectionGoal.
   */
  private nodeToGoal(node: any): ConnectionGoal {
    return {
      id: node.id,
      source_agent_id: node.source_agent_id,
      target_identifier: node.target_identifier,
      target_type: node.target_type || 'human',
      description: node.description || '',
      notify_threshold: node.notify_threshold !== null && node.notify_threshold !== undefined
        ? this.toNumber(node.notify_threshold)
        : null,
      max_hops: this.toNumber(node.max_hops) || 4,
      current_score: this.toNumber(node.current_score),
      stale: Boolean(node.stale),
      last_scored_at: node.last_scored_at || '',
      created_at: node.created_at || '',
      expires_at: node.expires_at || '',
      notified: Boolean(node.notified),
    };
  }

  private toNumber(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'object' && typeof value.toNumber === 'function') {
      return value.toNumber();
    }
    return Number(value) || 0;
  }
}
