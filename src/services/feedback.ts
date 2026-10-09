/**
 * Agent Feedback Channel Service
 *
 * Programmatic bug reports + feature requests from agents.
 * Trust-integrated: constructive feedback improves trust scores.
 * Phase 1: Core feedback, status tracking, basic dedup.
 */

export type FeedbackType = 'bug' | 'feature_request' | 'api_issue' | 'data_quality' | 'security' | 'praise';
export type FeedbackStatus = 'open' | 'acknowledged' | 'investigating' | 'fixed' | 'wontfix' | 'duplicate';
export type FeedbackPriority = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export interface FeedbackContext {
  endpoint?: string;
  request_body?: Record<string, unknown>;
  response_body?: Record<string, unknown>;
  expected?: string;
  actual?: string;
  sdk_version?: string;
  sdk_language?: string;
  timestamp?: string;
}

export interface FeedbackTicket {
  ticket_id: string;
  agent_id: string;
  type: FeedbackType;
  title: string;
  description: string;
  priority: FeedbackPriority;
  status: FeedbackStatus;
  context?: FeedbackContext;
  reproducible?: boolean;
  steps_to_reproduce?: string[];
  use_case?: string;
  proposed_api?: string;
  impact?: string;
  vote_count: number;
  voters: Set<string>;
  comments: FeedbackComment[];
  created_at: string;
  updated_at: string;
  resolution?: FeedbackResolution;
}

export interface FeedbackComment {
  comment_id: string;
  agent_id: string;
  ticket_id: string;
  comment: string;
  created_at: string;
}

export interface FeedbackResolution {
  fixed_in_version?: string;
  root_cause?: string;
  resolved_at: string;
}

export interface FeedbackSubmission {
  type: FeedbackType;
  title: string;
  description: string;
  priority?: FeedbackPriority;
  context?: FeedbackContext;
  reproducible?: boolean;
  steps_to_reproduce?: string[];
  use_case?: string;
  proposed_api?: string;
  impact?: string;
  vote?: boolean;
}

// Rate limit tracking per agent
interface AgentRateLimit {
  submissions: number[];  // timestamps of submissions in current window
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_SUBMISSIONS_PER_HOUR = 10;
const LOW_TRUST_MAX_PER_DAY = 2;
const LOW_TRUST_THRESHOLD = 0.3;

export class FeedbackService {
  private tickets: Map<string, FeedbackTicket> = new Map();
  private ticketCounter = 0;
  private commentCounter = 0;
  private rateLimits: Map<string, AgentRateLimit> = new Map();

  /**
   * Submit new feedback.
   */
  submit(agentId: string, submission: FeedbackSubmission): FeedbackTicket {
    // Rate limit check
    this.checkRateLimit(agentId);

    const ticketId = this.nextTicketId(submission.type);
    const now = new Date().toISOString();

    const priority = submission.priority ?? this.autoPriority(submission);

    const ticket: FeedbackTicket = {
      ticket_id: ticketId,
      agent_id: agentId,
      type: submission.type,
      title: submission.title,
      description: submission.description,
      priority,
      status: 'open',
      context: submission.context,
      reproducible: submission.reproducible,
      steps_to_reproduce: submission.steps_to_reproduce,
      use_case: submission.use_case,
      proposed_api: submission.proposed_api,
      impact: submission.impact,
      vote_count: submission.vote ? 1 : 0,
      voters: submission.vote ? new Set([agentId]) : new Set(),
      comments: [],
      created_at: now,
      updated_at: now,
    };

    this.tickets.set(ticketId, ticket);
    this.recordSubmission(agentId);

    return ticket;
  }

  /**
   * Get a ticket by ID.
   */
  getTicket(ticketId: string): FeedbackTicket | null {
    return this.tickets.get(ticketId) ?? null;
  }

  /**
   * List tickets submitted by an agent.
   */
  listByAgent(agentId: string): FeedbackTicket[] {
    const results: FeedbackTicket[] = [];
    for (const ticket of this.tickets.values()) {
      if (ticket.agent_id === agentId) {
        results.push(ticket);
      }
    }
    return results.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  /**
   * Vote on a feature request. Returns updated vote count.
   */
  vote(ticketId: string, agentId: string): { ticket_id: string; vote_count: number; your_vote: boolean } {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    if (ticket.type !== 'feature_request') {
      throw new Error('Can only vote on feature requests');
    }
    if (ticket.voters.has(agentId)) {
      throw new Error('Already voted on this ticket');
    }

    ticket.voters.add(agentId);
    ticket.vote_count++;
    ticket.updated_at = new Date().toISOString();

    return {
      ticket_id: ticketId,
      vote_count: ticket.vote_count,
      your_vote: true,
    };
  }

  /**
   * Add a comment to a ticket.
   */
  addComment(ticketId: string, agentId: string, comment: string): FeedbackComment {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    this.commentCounter++;
    const feedbackComment: FeedbackComment = {
      comment_id: `C-${String(this.commentCounter).padStart(3, '0')}`,
      agent_id: agentId,
      ticket_id: ticketId,
      comment,
      created_at: new Date().toISOString(),
    };

    ticket.comments.push(feedbackComment);
    ticket.updated_at = feedbackComment.created_at;

    return feedbackComment;
  }

  /**
   * Update ticket status (admin/platform operation).
   */
  updateStatus(ticketId: string, status: FeedbackStatus, message?: string, resolution?: FeedbackResolution): FeedbackTicket {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    ticket.status = status;
    ticket.updated_at = new Date().toISOString();

    if (resolution) {
      ticket.resolution = resolution;
    }

    return ticket;
  }

  /**
   * Find similar tickets by title (basic dedup).
   */
  findSimilar(title: string, type: FeedbackType): FeedbackTicket[] {
    const words = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const results: FeedbackTicket[] = [];

    for (const ticket of this.tickets.values()) {
      if (ticket.type !== type) continue;
      const ticketWords = ticket.title.toLowerCase().split(/\s+/);
      const overlap = words.filter(w => ticketWords.includes(w)).length;
      if (overlap >= Math.floor(words.length * 0.5)) {
        results.push(ticket);
      }
    }

    return results;
  }

  /**
   * Get feedback quality score for an agent.
   */
  getQualityScore(agentId: string): {
    total_submissions: number;
    confirmed_bugs: number;
    useful_features: number;
    spam_reports: number;
    quality_score: number;
  } {
    const tickets = this.listByAgent(agentId);
    const confirmedBugs = tickets.filter(
      t => t.type === 'bug' && t.status === 'fixed'
    ).length;
    const usefulFeatures = tickets.filter(
      t => t.type === 'feature_request' && t.vote_count >= 3
    ).length;
    const spamReports = tickets.filter(
      t => t.status === 'duplicate' || t.priority === 'informational'
    ).length;

    const total = tickets.length;
    const numerator = confirmedBugs * 5 + usefulFeatures * 2 + total;
    const denominator = total + spamReports * 3;
    const qualityScore = denominator > 0 ? numerator / denominator : 0;

    return {
      total_submissions: total,
      confirmed_bugs: confirmedBugs,
      useful_features: usefulFeatures,
      spam_reports: spamReports,
      quality_score: Math.round(qualityScore * 100) / 100,
    };
  }

  /**
   * Get trust adjustment for an agent based on feedback participation.
   * Positive values = trust increase, negative = trust decrease.
   */
  getTrustAdjustment(agentId: string): number {
    const tickets = this.listByAgent(agentId);
    let adjustment = 0;

    for (const ticket of tickets) {
      if (ticket.type === 'bug' && ticket.status === 'fixed') {
        adjustment += 0.05; // Confirmed bug fix
      } else if (ticket.type === 'bug' && ticket.status !== 'duplicate') {
        adjustment += 0.02; // Well-structured bug report
      } else if (ticket.type === 'security') {
        adjustment += 0.10; // Responsible disclosure
      } else if (ticket.type === 'feature_request' && ticket.vote_count >= 3) {
        adjustment += 0.01; // Community-aligned
      } else if (ticket.status === 'duplicate') {
        adjustment -= 0.05; // Spam/noise
      }
    }

    return Math.round(adjustment * 100) / 100;
  }

  // ========================
  // Internal helpers
  // ========================

  private nextTicketId(type: FeedbackType): string {
    this.ticketCounter++;
    const prefix = type === 'feature_request' ? 'FR' : 'FB';
    return `${prefix}-${String(this.ticketCounter).padStart(3, '0')}`;
  }

  private autoPriority(submission: FeedbackSubmission): FeedbackPriority {
    if (submission.type === 'security') return 'critical';
    if (submission.type === 'data_quality') return 'high';
    if (submission.type === 'bug') {
      return submission.reproducible ? 'high' : 'medium';
    }
    if (submission.type === 'praise') return 'informational';
    return 'medium';
  }

  private checkRateLimit(agentId: string): void {
    const now = Date.now();
    let limit = this.rateLimits.get(agentId);

    if (!limit) {
      limit = { submissions: [] };
      this.rateLimits.set(agentId, limit);
    }

    // Clean old entries
    limit.submissions = limit.submissions.filter(
      ts => now - ts < RATE_LIMIT_WINDOW_MS
    );

    if (limit.submissions.length >= MAX_SUBMISSIONS_PER_HOUR) {
      throw new Error('Rate limit exceeded: max 10 feedback submissions per hour');
    }
  }

  private recordSubmission(agentId: string): void {
    let limit = this.rateLimits.get(agentId);
    if (!limit) {
      limit = { submissions: [] };
      this.rateLimits.set(agentId, limit);
    }
    limit.submissions.push(Date.now());
  }
}
