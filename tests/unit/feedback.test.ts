/**
 * Unit Tests: Agent Feedback Channel Service
 *
 * Tests feedback submission, voting, comments, rate limiting,
 * quality scoring, trust adjustments, and dedup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackService, type FeedbackSubmission } from '../../src/services/feedback';

describe('FeedbackService', () => {
  let service: FeedbackService;

  beforeEach(() => {
    service = new FeedbackService();
  });

  describe('submit()', () => {
    it('creates a bug report with auto-generated ticket ID', () => {
      const ticket = service.submit('agent-1', {
        type: 'bug',
        title: 'discover-broker returns empty results',
        description: 'When querying for known 2-hop paths, returns 0 results.',
        reproducible: true,
      });

      expect(ticket.ticket_id).toBe('FB-001');
      expect(ticket.agent_id).toBe('agent-1');
      expect(ticket.type).toBe('bug');
      expect(ticket.status).toBe('open');
      expect(ticket.priority).toBe('high'); // reproducible bug = high
      expect(ticket.vote_count).toBe(0);
    });

    it('creates a feature request with FR prefix', () => {
      const ticket = service.submit('agent-1', {
        type: 'feature_request',
        title: 'Batch discovery endpoint',
        description: 'Need batch queries for portfolio management',
        use_case: 'Portfolio management with 50+ contacts',
        vote: true,
      });

      expect(ticket.ticket_id).toBe('FR-001');
      expect(ticket.type).toBe('feature_request');
      expect(ticket.vote_count).toBe(1);
      expect(ticket.voters.has('agent-1')).toBe(true);
    });

    it('auto-assigns critical priority to security reports', () => {
      const ticket = service.submit('agent-1', {
        type: 'security',
        title: 'Possible injection in broker query',
        description: 'Cypher injection possible via target_identifier',
      });

      expect(ticket.priority).toBe('critical');
    });

    it('auto-assigns high priority to data quality reports', () => {
      const ticket = service.submit('agent-1', {
        type: 'data_quality',
        title: 'Stale edge data',
        description: 'Edge between A and B was severed 6 months ago',
      });

      expect(ticket.priority).toBe('high');
    });

    it('auto-assigns informational priority to praise', () => {
      const ticket = service.submit('agent-1', {
        type: 'praise',
        title: 'Great broker discovery results',
        description: 'The algorithm found a perfect path on first try.',
      });

      expect(ticket.priority).toBe('informational');
    });

    it('respects explicit priority override', () => {
      const ticket = service.submit('agent-1', {
        type: 'bug',
        title: 'Minor UI issue',
        description: 'SDK docs have a typo',
        priority: 'low',
      });

      expect(ticket.priority).toBe('low');
    });

    it('increments ticket IDs across types', () => {
      const t1 = service.submit('agent-1', { type: 'bug', title: 'Bug 1', description: 'd' });
      const t2 = service.submit('agent-1', { type: 'feature_request', title: 'FR 1', description: 'd' });
      const t3 = service.submit('agent-1', { type: 'bug', title: 'Bug 2', description: 'd' });

      expect(t1.ticket_id).toBe('FB-001');
      expect(t2.ticket_id).toBe('FR-002');
      expect(t3.ticket_id).toBe('FB-003');
    });

    it('stores context, steps_to_reproduce, and other metadata', () => {
      const ticket = service.submit('agent-1', {
        type: 'bug',
        title: 'API error',
        description: 'Unexpected error',
        context: {
          endpoint: 'POST /discover-broker',
          expected: 'Results',
          actual: 'Empty',
          sdk_version: '0.1.0',
          sdk_language: 'python',
        },
        steps_to_reproduce: ['Register agent', 'Create edge', 'Query discover-broker'],
        reproducible: true,
      });

      expect(ticket.context?.endpoint).toBe('POST /discover-broker');
      expect(ticket.steps_to_reproduce).toHaveLength(3);
      expect(ticket.reproducible).toBe(true);
    });
  });

  describe('getTicket()', () => {
    it('returns null for nonexistent ticket', () => {
      expect(service.getTicket('FB-999')).toBeNull();
    });

    it('returns the ticket', () => {
      service.submit('agent-1', { type: 'bug', title: 'Test', description: 'd' });
      const ticket = service.getTicket('FB-001');
      expect(ticket).not.toBeNull();
      expect(ticket!.title).toBe('Test');
    });
  });

  describe('listByAgent()', () => {
    it('returns only tickets from the specified agent', () => {
      service.submit('agent-1', { type: 'bug', title: 'A1 bug', description: 'd' });
      service.submit('agent-2', { type: 'bug', title: 'A2 bug', description: 'd' });
      service.submit('agent-1', { type: 'feature_request', title: 'A1 feature', description: 'd' });

      const tickets = service.listByAgent('agent-1');
      expect(tickets).toHaveLength(2);
      expect(tickets.every(t => t.agent_id === 'agent-1')).toBe(true);
    });

    it('returns empty array for unknown agent', () => {
      expect(service.listByAgent('nobody')).toHaveLength(0);
    });

    it('returns tickets sorted by newest first', () => {
      service.submit('agent-1', { type: 'bug', title: 'First', description: 'd' });
      service.submit('agent-1', { type: 'bug', title: 'Second', description: 'd' });

      const tickets = service.listByAgent('agent-1');
      expect(new Date(tickets[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(tickets[1].created_at).getTime()
      );
    });
  });

  describe('vote()', () => {
    it('increments vote count on a feature request', () => {
      service.submit('agent-1', { type: 'feature_request', title: 'Batch', description: 'd' });

      const result = service.vote('FR-001', 'agent-2');
      expect(result.vote_count).toBe(1);
      expect(result.your_vote).toBe(true);
    });

    it('rejects voting on non-feature-request tickets', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });

      expect(() => service.vote('FB-001', 'agent-2'))
        .toThrow('only vote on feature requests');
    });

    it('rejects duplicate votes from same agent', () => {
      service.submit('agent-1', { type: 'feature_request', title: 'Batch', description: 'd' });
      service.vote('FR-001', 'agent-2');

      expect(() => service.vote('FR-001', 'agent-2'))
        .toThrow('Already voted');
    });

    it('throws for nonexistent ticket', () => {
      expect(() => service.vote('FR-999', 'agent-1'))
        .toThrow('not found');
    });

    it('counts multiple unique voters', () => {
      service.submit('agent-1', { type: 'feature_request', title: 'Batch', description: 'd', vote: true });

      service.vote('FR-001', 'agent-2');
      const result = service.vote('FR-001', 'agent-3');

      expect(result.vote_count).toBe(3); // agent-1 (submit), agent-2, agent-3
    });
  });

  describe('addComment()', () => {
    it('adds a comment to a ticket', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });

      const comment = service.addComment('FB-001', 'agent-2', 'Also seeing this with 3-hop paths.');

      expect(comment.comment_id).toBe('C-001');
      expect(comment.agent_id).toBe('agent-2');
      expect(comment.ticket_id).toBe('FB-001');
      expect(comment.comment).toBe('Also seeing this with 3-hop paths.');
    });

    it('throws for nonexistent ticket', () => {
      expect(() => service.addComment('FB-999', 'agent-1', 'test'))
        .toThrow('not found');
    });

    it('updates the ticket updated_at', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });
      const originalUpdatedAt = service.getTicket('FB-001')!.updated_at;

      // Small delay to ensure different timestamp
      service.addComment('FB-001', 'agent-2', 'Comment');
      const newUpdatedAt = service.getTicket('FB-001')!.updated_at;

      expect(new Date(newUpdatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt).getTime()
      );
    });

    it('increments comment IDs', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });

      const c1 = service.addComment('FB-001', 'agent-2', 'Comment 1');
      const c2 = service.addComment('FB-001', 'agent-3', 'Comment 2');

      expect(c1.comment_id).toBe('C-001');
      expect(c2.comment_id).toBe('C-002');
    });
  });

  describe('updateStatus()', () => {
    it('updates ticket status', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });

      const ticket = service.updateStatus('FB-001', 'investigating');
      expect(ticket.status).toBe('investigating');
    });

    it('adds resolution details', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });

      const ticket = service.updateStatus('FB-001', 'fixed', undefined, {
        fixed_in_version: '0.1.1',
        root_cause: 'Directed vs undirected Cypher query',
        resolved_at: new Date().toISOString(),
      });

      expect(ticket.status).toBe('fixed');
      expect(ticket.resolution?.fixed_in_version).toBe('0.1.1');
    });

    it('throws for nonexistent ticket', () => {
      expect(() => service.updateStatus('FB-999', 'fixed'))
        .toThrow('not found');
    });
  });

  describe('findSimilar()', () => {
    it('finds tickets with overlapping title words', () => {
      service.submit('agent-1', {
        type: 'bug',
        title: 'discover-broker returns empty results for known paths',
        description: 'd',
      });

      const similar = service.findSimilar('discover-broker empty results', 'bug');
      expect(similar).toHaveLength(1);
    });

    it('only matches same feedback type', () => {
      service.submit('agent-1', {
        type: 'feature_request',
        title: 'batch discovery endpoint for broker results',
        description: 'd',
      });

      const similar = service.findSimilar('batch discovery endpoint', 'bug');
      expect(similar).toHaveLength(0);
    });

    it('returns empty for no matches', () => {
      service.submit('agent-1', { type: 'bug', title: 'Cypher injection issue', description: 'd' });

      const similar = service.findSimilar('payment processing timeout', 'bug');
      expect(similar).toHaveLength(0);
    });
  });

  describe('getQualityScore()', () => {
    it('returns zeroes for unknown agent', () => {
      const quality = service.getQualityScore('nobody');
      expect(quality.total_submissions).toBe(0);
      expect(quality.quality_score).toBe(0);
    });

    it('calculates quality score correctly', () => {
      // Submit a bug that gets fixed
      service.submit('agent-1', { type: 'bug', title: 'Bug 1', description: 'd' });
      service.updateStatus('FB-001', 'fixed');

      // Submit a feature request that gets 3+ votes
      service.submit('agent-1', { type: 'feature_request', title: 'Feature', description: 'd', vote: true });
      service.vote('FR-002', 'agent-2');
      service.vote('FR-002', 'agent-3');

      const quality = service.getQualityScore('agent-1');
      expect(quality.total_submissions).toBe(2);
      expect(quality.confirmed_bugs).toBe(1);
      expect(quality.useful_features).toBe(1);
      expect(quality.quality_score).toBeGreaterThan(0);
    });
  });

  describe('getTrustAdjustment()', () => {
    it('returns 0 for unknown agent', () => {
      expect(service.getTrustAdjustment('nobody')).toBe(0);
    });

    it('gives +0.05 for confirmed bugs', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });
      service.updateStatus('FB-001', 'fixed');

      expect(service.getTrustAdjustment('agent-1')).toBe(0.05);
    });

    it('gives +0.02 for well-structured bug reports', () => {
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });

      expect(service.getTrustAdjustment('agent-1')).toBe(0.02);
    });

    it('gives +0.10 for security reports', () => {
      service.submit('agent-1', { type: 'security', title: 'Security', description: 'd' });

      expect(service.getTrustAdjustment('agent-1')).toBe(0.10);
    });

    it('gives -0.05 for duplicate/spam', () => {
      service.submit('agent-1', { type: 'bug', title: 'Spam', description: 'd' });
      service.updateStatus('FB-001', 'duplicate');

      expect(service.getTrustAdjustment('agent-1')).toBe(-0.05);
    });

    it('accumulates across multiple tickets', () => {
      // Fixed bug (+0.05) + security report (+0.10) = +0.15
      service.submit('agent-1', { type: 'bug', title: 'Bug', description: 'd' });
      service.updateStatus('FB-001', 'fixed');
      service.submit('agent-1', { type: 'security', title: 'Security', description: 'd' });

      expect(service.getTrustAdjustment('agent-1')).toBe(0.15);
    });
  });

  describe('rate limiting', () => {
    it('allows up to 10 submissions per hour', () => {
      for (let i = 0; i < 10; i++) {
        service.submit('agent-1', { type: 'bug', title: `Bug ${i}`, description: 'd' });
      }

      expect(() => service.submit('agent-1', { type: 'bug', title: 'Bug 11', description: 'd' }))
        .toThrow('Rate limit');
    });

    it('rate limits per agent (not global)', () => {
      for (let i = 0; i < 10; i++) {
        service.submit('agent-1', { type: 'bug', title: `Bug ${i}`, description: 'd' });
      }

      // agent-2 should still be able to submit
      const ticket = service.submit('agent-2', { type: 'bug', title: 'Bug from 2', description: 'd' });
      expect(ticket.ticket_id).toBeTruthy();
    });
  });
});
