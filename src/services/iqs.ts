/**
 * Introduction Quality Score (IQS) Service
 *
 * Deterministic scoring formula for introduction quality.
 * Anti-oracle protections: band-based responses, threshold noise.
 *
 * IQS = 0.30*relevance + 0.25*requester_credibility + 0.20*broker_confidence
 *     + 0.15*path_proximity + 0.10*novelty
 *
 * Bands: low [0, 0.40), medium [0.40, threshold), high [threshold, 1.0]
 * Threshold: demand-responsive with ±10% noise
 */

export interface IQSComponents {
  relevance_score: number;           // [0, 1] — capability overlap cosine similarity
  requester_credibility: number;     // [0, 1] — mapped from trust_score
  broker_confidence: number;         // [0, 1] — broker's historical success rate
  path_proximity: number;            // [0, 1] — inverse of hop count
  novelty_score: number;             // [0, 1] — penalizes repeated topics
}

export const IQS_WEIGHTS = {
  relevance: 0.30,
  requester_credibility: 0.25,
  broker_confidence: 0.20,
  path_proximity: 0.15,
  novelty: 0.10,
} as const;

export type IQSBand = 'low' | 'medium' | 'high';

export interface IQSResult {
  band: IQSBand;
  recommendation: string;
  threshold_used: number;
  is_probationary: boolean;
}

export interface ThresholdConfig {
  base_threshold: number;            // default 0.65
  demand_multiplier: number;         // queries in last hour / baseline
  noise_range: number;               // ±10% = 0.10
  ceiling: number;                   // hard max 0.90
}

// Sliding window for novelty scoring
interface TopicWindow {
  target_id: string;
  requester_ids: string[];
  timestamps: number[];
}

export class IQSService {
  private topicWindows: Map<string, TopicWindow> = new Map();
  private queryCount24h = 0;
  private queryBaseline = 10; // queries per hour baseline
  private lastQueryReset = Date.now();

  // Probationary agents: agent_id -> registration timestamp
  private probationaryAgents: Map<string, number> = new Map();

  /**
   * Compute raw IQS score from components.
   */
  computeScore(components: IQSComponents): number {
    const score =
      IQS_WEIGHTS.relevance * components.relevance_score +
      IQS_WEIGHTS.requester_credibility * components.requester_credibility +
      IQS_WEIGHTS.broker_confidence * components.broker_confidence +
      IQS_WEIGHTS.path_proximity * components.path_proximity +
      IQS_WEIGHTS.novelty * components.novelty_score;

    return Math.max(0, Math.min(1, parseFloat(score.toFixed(4))));
  }

  /**
   * Compute relevance score using cosine-like similarity.
   * Simple: |intersection| / max(|A|, |B|, 1)
   */
  computeRelevance(requesterCaps: string[], targetCaps: string[]): number {
    if (requesterCaps.length === 0 || targetCaps.length === 0) return 0;

    const intersection = requesterCaps.filter(c => targetCaps.includes(c));
    const denominator = Math.max(requesterCaps.length, targetCaps.length, 1);

    return intersection.length / denominator;
  }

  /**
   * Map trust_score [0, 1] to requester credibility [0, 1].
   * Amplifies differences in the 0.3-0.7 range.
   */
  mapCredibility(trustScore: number): number {
    // Sigmoid-like mapping centered at 0.5
    // f(x) = 1 / (1 + e^(-10*(x - 0.5)))
    return 1 / (1 + Math.exp(-10 * (trustScore - 0.5)));
  }

  /**
   * Compute broker confidence from historical success rate.
   */
  computeBrokerConfidence(successCount: number, totalIntros: number): number {
    if (totalIntros === 0) return 0.5; // Default for new brokers
    return Math.min(1, successCount / totalIntros);
  }

  /**
   * Compute path proximity score (inverse of hop count).
   */
  computePathProximity(hops: number, maxHops: number = 4): number {
    if (hops <= 0) return 1;
    if (hops > maxHops) return 0;
    return 1 - (hops - 1) / maxHops;
  }

  /**
   * Compute novelty score. Penalizes repeated queries to the same target.
   * Uses a 24-hour sliding window.
   */
  computeNovelty(targetId: string, requesterId: string): number {
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000; // 24 hours

    let window = this.topicWindows.get(targetId);
    if (!window) {
      window = { target_id: targetId, requester_ids: [], timestamps: [] };
      this.topicWindows.set(targetId, window);
    }

    // Prune expired entries
    const cutoff = now - windowMs;
    const validIndices = window.timestamps
      .map((t, i) => t > cutoff ? i : -1)
      .filter(i => i >= 0);

    window.timestamps = validIndices.map(i => window!.timestamps[i]);
    window.requester_ids = validIndices.map(i => window!.requester_ids[i]);

    // Count queries to this target in window
    const queryCount = window.timestamps.length;

    // Record this query
    window.timestamps.push(now);
    window.requester_ids.push(requesterId);

    // Novelty decreases with more queries to same target
    // 0 queries = 1.0 novelty, 5+ queries = 0.2 minimum
    if (queryCount === 0) return 1.0;
    if (queryCount >= 5) return 0.2;
    return 1.0 - (queryCount * 0.16);
  }

  /**
   * Get the demand-responsive threshold with noise.
   */
  getThreshold(config?: Partial<ThresholdConfig>): number {
    const base = config?.base_threshold ?? 0.65;
    const noiseRange = config?.noise_range ?? 0.10;
    const ceiling = config?.ceiling ?? 0.90;

    // Demand multiplier: increase threshold when query volume is high
    const demandMultiplier = config?.demand_multiplier ?? this.getDemandMultiplier();
    const demandAdjusted = base * (1 + 0.1 * Math.max(0, demandMultiplier - 1));

    // Add noise (±10%)
    const noise = (Math.random() - 0.5) * 2 * noiseRange * demandAdjusted;
    const threshold = demandAdjusted + noise;

    // Clamp to [0, ceiling]
    return Math.max(0, Math.min(ceiling, parseFloat(threshold.toFixed(4))));
  }

  /**
   * Get probationary threshold for new agents.
   * Days 1-3: fixed at 0.60
   * Days 4-7: linear decay from 0.60 to normal
   * Day 8+: normal threshold
   */
  getProbationaryThreshold(agentId: string, normalThreshold: number): number {
    const registrationTime = this.probationaryAgents.get(agentId);
    if (!registrationTime) return normalThreshold;

    const daysSinceRegistration = (Date.now() - registrationTime) / (24 * 60 * 60 * 1000);

    if (daysSinceRegistration >= 8) {
      // Graduate from probation
      this.probationaryAgents.delete(agentId);
      return normalThreshold;
    }

    const probationaryBase = 0.60;

    if (daysSinceRegistration <= 3) {
      return probationaryBase;
    }

    // Days 4-7: linear decay from probationary to normal
    const progress = (daysSinceRegistration - 3) / 4; // 0 to 1 over days 4-7
    return probationaryBase + (normalThreshold - probationaryBase) * progress;
  }

  /**
   * Register an agent as probationary.
   */
  registerProbationary(agentId: string): void {
    this.probationaryAgents.set(agentId, Date.now());
  }

  /**
   * Classify a score into a band (anti-oracle: never reveal exact scores).
   */
  classify(score: number, targetId: string, agentId?: string): IQSResult {
    const normalThreshold = this.getThreshold();
    const threshold = agentId
      ? this.getProbationaryThreshold(agentId, normalThreshold)
      : normalThreshold;

    const isProbationary = agentId ? this.probationaryAgents.has(agentId) : false;

    let band: IQSBand;
    let recommendation: string;

    if (score < 0.40) {
      band = 'low';
      recommendation = 'This introduction is unlikely to be productive. Consider improving your profile or building more attestations.';
    } else if (score < threshold) {
      band = 'medium';
      recommendation = 'This introduction has moderate potential. Additional attestations or shared context could improve it.';
    } else {
      band = 'high';
      recommendation = 'This introduction is well-supported by the network. Proceed with confidence.';
    }

    return {
      band,
      recommendation,
      threshold_used: threshold,
      is_probationary: isProbationary,
    };
  }

  /**
   * Full IQS evaluation: compute score, classify, return band-based result.
   */
  evaluate(
    components: IQSComponents,
    targetId: string,
    requesterId: string,
  ): IQSResult & { components_received: boolean } {
    const score = this.computeScore(components);
    const result = this.classify(score, targetId, requesterId);

    // Track query for demand calculation
    this.queryCount24h++;

    return {
      ...result,
      components_received: true,
    };
  }

  // Internal: demand multiplier for threshold adaptation
  private getDemandMultiplier(): number {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;

    // Reset counter every hour
    if (now - this.lastQueryReset > hourMs) {
      this.queryCount24h = 0;
      this.lastQueryReset = now;
    }

    return this.queryCount24h / this.queryBaseline;
  }
}
