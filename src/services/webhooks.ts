/**
 * Webhook Event System
 *
 * Delivers events to registered agent endpoints.
 * Supports: introduction_request, attestation_received, trust_score_changed,
 *           outcome_reported, iqs_guidance
 *
 * Features:
 * - Registration and management of webhook endpoints
 * - Event queuing with retry logic (exponential backoff)
 * - Signature verification for webhook payloads
 * - Max 3 retries per delivery attempt
 */

import * as crypto from 'crypto';
import { sign, base64urlEncode } from '../crypto/keys';

export type WebhookEventType =
  | 'introduction_request'
  | 'attestation_received'
  | 'trust_score_changed'
  | 'outcome_reported'
  | 'iqs_guidance';

export interface WebhookRegistration {
  agent_id: string;
  endpoint_url: string;
  event_types: WebhookEventType[];
  secret: string;         // HMAC secret for payload verification
  active: boolean;
  created_at: string;
  last_delivery_at: string | null;
  failure_count: number;
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  payload: Record<string, any>;
}

export interface WebhookDelivery {
  event_id: string;
  registration_id: string;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  attempt: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  delivered_at: string | null;
}

export class WebhookService {
  // In-memory stores (production: database)
  private registrations: Map<string, WebhookRegistration> = new Map();
  private eventQueue: WebhookDelivery[] = [];
  private deliveryLog: WebhookDelivery[] = [];

  /**
   * Register a webhook endpoint for an agent.
   */
  register(
    agentId: string,
    endpointUrl: string,
    eventTypes: WebhookEventType[],
  ): WebhookRegistration {
    // Generate HMAC secret
    const secret = crypto.randomBytes(32).toString('hex');

    const registration: WebhookRegistration = {
      agent_id: agentId,
      endpoint_url: endpointUrl,
      event_types: eventTypes,
      secret,
      active: true,
      created_at: new Date().toISOString(),
      last_delivery_at: null,
      failure_count: 0,
    };

    const key = `${agentId}:${endpointUrl}`;
    this.registrations.set(key, registration);

    return registration;
  }

  /**
   * Unregister a webhook endpoint.
   */
  unregister(agentId: string, endpointUrl: string): boolean {
    const key = `${agentId}:${endpointUrl}`;
    return this.registrations.delete(key);
  }

  /**
   * Get all registrations for an agent.
   */
  getRegistrations(agentId: string): WebhookRegistration[] {
    const results: WebhookRegistration[] = [];
    for (const [key, reg] of this.registrations) {
      if (reg.agent_id === agentId) {
        results.push(reg);
      }
    }
    return results;
  }

  /**
   * Emit an event. Queues delivery to all matching registrations.
   */
  emit(event: WebhookEvent): WebhookDelivery[] {
    const deliveries: WebhookDelivery[] = [];

    for (const [key, reg] of this.registrations) {
      if (!reg.active) continue;
      if (!reg.event_types.includes(event.type)) continue;

      const delivery: WebhookDelivery = {
        event_id: event.id,
        registration_id: key,
        status: 'pending',
        attempt: 0,
        max_attempts: 3,
        next_retry_at: null,
        last_error: null,
        delivered_at: null,
      };

      deliveries.push(delivery);
      this.eventQueue.push(delivery);
    }

    return deliveries;
  }

  /**
   * Process the delivery queue. Call this periodically.
   * Returns the number of deliveries attempted.
   */
  async processQueue(deliverFn?: (url: string, payload: string, signature: string) => Promise<boolean>): Promise<number> {
    const now = new Date();
    let processed = 0;

    const pendingDeliveries = this.eventQueue.filter(d => {
      if (d.status === 'delivered' || d.status === 'failed') return false;
      if (d.next_retry_at && new Date(d.next_retry_at) > now) return false;
      return true;
    });

    for (const delivery of pendingDeliveries) {
      delivery.attempt++;

      const reg = this.registrations.get(delivery.registration_id);
      if (!reg) {
        delivery.status = 'failed';
        delivery.last_error = 'Registration not found';
        continue;
      }

      try {
        // Sign the payload
        const payloadStr = JSON.stringify({ event_id: delivery.event_id });
        const signature = this.signPayload(payloadStr, reg.secret);

        // Deliver
        if (deliverFn) {
          const success = await deliverFn(reg.endpoint_url, payloadStr, signature);
          if (success) {
            delivery.status = 'delivered';
            delivery.delivered_at = new Date().toISOString();
            reg.last_delivery_at = delivery.delivered_at;
            reg.failure_count = 0;
          } else {
            throw new Error('Delivery returned false');
          }
        } else {
          // No delivery function provided — mark as delivered (test mode)
          delivery.status = 'delivered';
          delivery.delivered_at = new Date().toISOString();
        }
      } catch (err: any) {
        delivery.last_error = err.message;

        if (delivery.attempt >= delivery.max_attempts) {
          delivery.status = 'failed';
          reg.failure_count++;

          // Disable after 10 consecutive failures
          if (reg.failure_count >= 10) {
            reg.active = false;
          }
        } else {
          delivery.status = 'retrying';
          // Exponential backoff: 30s, 120s, 480s
          const backoffMs = 30_000 * Math.pow(4, delivery.attempt - 1);
          delivery.next_retry_at = new Date(Date.now() + backoffMs).toISOString();
        }
      }

      processed++;
    }

    // Move completed deliveries to log
    this.deliveryLog.push(
      ...this.eventQueue.filter(d => d.status === 'delivered' || d.status === 'failed')
    );
    this.eventQueue = this.eventQueue.filter(
      d => d.status !== 'delivered' && d.status !== 'failed'
    );

    return processed;
  }

  /**
   * Sign a webhook payload with HMAC-SHA256.
   */
  signPayload(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  /**
   * Verify a webhook payload signature.
   */
  verifyPayload(payload: string, signature: string, secret: string): boolean {
    const expected = this.signPayload(payload, secret);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  }

  /**
   * Get queue status.
   */
  getQueueStatus(): { pending: number; retrying: number; delivered: number; failed: number } {
    const pending = this.eventQueue.filter(d => d.status === 'pending').length;
    const retrying = this.eventQueue.filter(d => d.status === 'retrying').length;
    const delivered = this.deliveryLog.filter(d => d.status === 'delivered').length;
    const failed = this.deliveryLog.filter(d => d.status === 'failed').length;
    return { pending, retrying, delivered, failed };
  }
}
