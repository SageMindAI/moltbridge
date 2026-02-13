/**
 * Unit Tests: Webhook Event System
 *
 * Tests registration, event emission, delivery queue processing,
 * retry logic, HMAC signing, and auto-disable behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WebhookService,
  type WebhookEventType,
  type WebhookEvent,
} from '../../src/services/webhooks';

describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(() => {
    service = new WebhookService();
  });

  describe('register()', () => {
    it('creates a registration with HMAC secret', () => {
      const reg = service.register('agent-1', 'https://example.com/webhook', ['introduction_request']);

      expect(reg.agent_id).toBe('agent-1');
      expect(reg.endpoint_url).toBe('https://example.com/webhook');
      expect(reg.event_types).toEqual(['introduction_request']);
      expect(reg.secret).toHaveLength(64); // 32 bytes hex
      expect(reg.active).toBe(true);
      expect(reg.failure_count).toBe(0);
      expect(reg.last_delivery_at).toBeNull();
    });

    it('generates unique secrets per registration', () => {
      const reg1 = service.register('agent-1', 'https://a.com/hook', ['introduction_request']);
      const reg2 = service.register('agent-2', 'https://b.com/hook', ['introduction_request']);

      expect(reg1.secret).not.toBe(reg2.secret);
    });

    it('supports multiple event types', () => {
      const types: WebhookEventType[] = ['introduction_request', 'attestation_received', 'trust_score_changed'];
      const reg = service.register('agent-1', 'https://example.com/webhook', types);

      expect(reg.event_types).toEqual(types);
    });
  });

  describe('unregister()', () => {
    it('removes a registration', () => {
      service.register('agent-1', 'https://example.com/webhook', ['introduction_request']);

      const removed = service.unregister('agent-1', 'https://example.com/webhook');
      expect(removed).toBe(true);

      const regs = service.getRegistrations('agent-1');
      expect(regs).toHaveLength(0);
    });

    it('returns false for non-existent registration', () => {
      const removed = service.unregister('nonexistent', 'https://example.com/webhook');
      expect(removed).toBe(false);
    });
  });

  describe('getRegistrations()', () => {
    it('returns all registrations for an agent', () => {
      service.register('agent-1', 'https://a.com/hook1', ['introduction_request']);
      service.register('agent-1', 'https://a.com/hook2', ['attestation_received']);
      service.register('agent-2', 'https://b.com/hook', ['introduction_request']);

      const regs = service.getRegistrations('agent-1');
      expect(regs).toHaveLength(2);
    });

    it('returns empty array for agent with no registrations', () => {
      expect(service.getRegistrations('nobody')).toEqual([]);
    });
  });

  describe('emit()', () => {
    it('queues delivery for matching registrations', () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);
      service.register('agent-2', 'https://b.com/hook', ['introduction_request']);

      const event: WebhookEvent = {
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: { target: 'agent-3' },
      };

      const deliveries = service.emit(event);
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0].status).toBe('pending');
      expect(deliveries[0].attempt).toBe(0);
      expect(deliveries[0].max_attempts).toBe(3);
    });

    it('skips registrations that do not match event type', () => {
      service.register('agent-1', 'https://a.com/hook', ['attestation_received']);

      const event: WebhookEvent = {
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const deliveries = service.emit(event);
      expect(deliveries).toHaveLength(0);
    });

    it('skips inactive registrations', () => {
      const reg = service.register('agent-1', 'https://a.com/hook', ['introduction_request']);
      reg.active = false;

      const event: WebhookEvent = {
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const deliveries = service.emit(event);
      expect(deliveries).toHaveLength(0);
    });
  });

  describe('processQueue()', () => {
    it('delivers events using the delivery function', async () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: { target: 'someone' },
      });

      const deliverFn = vi.fn().mockResolvedValue(true);
      const processed = await service.processQueue(deliverFn);

      expect(processed).toBe(1);
      expect(deliverFn).toHaveBeenCalledOnce();
      expect(deliverFn).toHaveBeenCalledWith(
        'https://a.com/hook',
        expect.any(String),
        expect.any(String),
      );
    });

    it('marks delivery as delivered on success', async () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      await service.processQueue(vi.fn().mockResolvedValue(true));

      const status = service.getQueueStatus();
      expect(status.delivered).toBe(1);
      expect(status.pending).toBe(0);
    });

    it('retries on delivery failure', async () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      const deliverFn = vi.fn().mockResolvedValue(false);
      await service.processQueue(deliverFn);

      const status = service.getQueueStatus();
      expect(status.retrying).toBe(1);
      expect(status.failed).toBe(0);
    });

    it('marks as failed after max attempts', async () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      const deliverFn = vi.fn().mockRejectedValue(new Error('Network error'));

      // Process 3 times (max_attempts = 3)
      // Need to clear next_retry_at for testing
      for (let i = 0; i < 3; i++) {
        // Force next_retry_at to past so retries process immediately
        const queue = (service as any).eventQueue;
        for (const d of queue) {
          d.next_retry_at = null;
        }
        await service.processQueue(deliverFn);
      }

      const status = service.getQueueStatus();
      expect(status.failed).toBe(1);
      expect(status.retrying).toBe(0);
    });

    it('auto-disables registration after 10 consecutive failures', async () => {
      const reg = service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      const deliverFn = vi.fn().mockRejectedValue(new Error('fail'));

      // Emit and fail 10 events (each exhausts 3 retries = 10 failure_count increments)
      for (let i = 0; i < 10; i++) {
        service.emit({
          id: `evt-${i}`,
          type: 'introduction_request',
          timestamp: new Date().toISOString(),
          payload: {},
        });

        for (let attempt = 0; attempt < 3; attempt++) {
          const queue = (service as any).eventQueue;
          for (const d of queue) {
            d.next_retry_at = null;
          }
          await service.processQueue(deliverFn);
        }
      }

      expect(reg.active).toBe(false);
    });

    it('delivers in test mode when no deliverFn provided', async () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      const processed = await service.processQueue();
      expect(processed).toBe(1);

      const status = service.getQueueStatus();
      expect(status.delivered).toBe(1);
    });

    it('handles missing registration gracefully', async () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      // Remove registration before processing
      service.unregister('agent-1', 'https://a.com/hook');

      const processed = await service.processQueue();
      // The delivery is still in the queue and gets processed (status set to failed + continue)
      // but the loop increments processed AFTER the continue, so it counts
      // Actually: `continue` skips the `processed++` at bottom. So 0.
      expect(processed).toBe(0);

      // But the delivery IS marked as failed
      const status = service.getQueueStatus();
      expect(status.failed).toBe(1);
    });
  });

  describe('signPayload() / verifyPayload()', () => {
    it('produces valid HMAC-SHA256 signature', () => {
      const payload = '{"event_id":"evt-1"}';
      const secret = 'test-secret-key';
      const sig = service.signPayload(payload, secret);

      expect(sig).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    });

    it('signature is deterministic', () => {
      const payload = '{"data":"test"}';
      const secret = 'my-secret';

      const sig1 = service.signPayload(payload, secret);
      const sig2 = service.signPayload(payload, secret);
      expect(sig1).toBe(sig2);
    });

    it('different payloads produce different signatures', () => {
      const secret = 'my-secret';
      const sig1 = service.signPayload('payload-1', secret);
      const sig2 = service.signPayload('payload-2', secret);
      expect(sig1).not.toBe(sig2);
    });

    it('different secrets produce different signatures', () => {
      const payload = 'same-payload';
      const sig1 = service.signPayload(payload, 'secret-1');
      const sig2 = service.signPayload(payload, 'secret-2');
      expect(sig1).not.toBe(sig2);
    });

    it('verifyPayload accepts valid signature', () => {
      const payload = '{"test":true}';
      const secret = 'verification-secret';
      const sig = service.signPayload(payload, secret);

      expect(service.verifyPayload(payload, sig, secret)).toBe(true);
    });

    it('verifyPayload rejects tampered payload', () => {
      const secret = 'verification-secret';
      const sig = service.signPayload('original', secret);

      expect(service.verifyPayload('tampered', sig, secret)).toBe(false);
    });

    it('verifyPayload rejects wrong secret', () => {
      const payload = '{"test":true}';
      const sig = service.signPayload(payload, 'correct-secret');

      expect(service.verifyPayload(payload, sig, 'wrong-secret')).toBe(false);
    });
  });

  describe('getQueueStatus()', () => {
    it('returns zeros for empty queue', () => {
      const status = service.getQueueStatus();
      expect(status).toEqual({ pending: 0, retrying: 0, delivered: 0, failed: 0 });
    });

    it('tracks pending deliveries', () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);
      service.register('agent-2', 'https://b.com/hook', ['introduction_request']);

      service.emit({
        id: 'evt-1',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      });

      const status = service.getQueueStatus();
      expect(status.pending).toBe(2);
    });
  });

  describe('Event type filtering', () => {
    it('delivers only to registrations matching the event type', () => {
      service.register('agent-1', 'https://a.com/hook', ['introduction_request']);
      service.register('agent-2', 'https://b.com/hook', ['attestation_received']);
      service.register('agent-3', 'https://c.com/hook', ['introduction_request', 'attestation_received']);

      const introEvent: WebhookEvent = {
        id: 'evt-intro',
        type: 'introduction_request',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const introDeliveries = service.emit(introEvent);
      expect(introDeliveries).toHaveLength(2); // agent-1 and agent-3

      const attestEvent: WebhookEvent = {
        id: 'evt-attest',
        type: 'attestation_received',
        timestamp: new Date().toISOString(),
        payload: {},
      };

      const attestDeliveries = service.emit(attestEvent);
      expect(attestDeliveries).toHaveLength(2); // agent-2 and agent-3
    });
  });
});
