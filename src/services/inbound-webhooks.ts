/**
 * Inbound Webhook Handler
 *
 * Consumes signed webhook events FROM partner trust/verification providers.
 * Complements outbound webhook system (webhooks.ts) — that delivers events
 * from MoltBridge; this receives events from partners.
 *
 * Supported partners (initial):
 *  - veroq:   VeroQ Shield `verification.completed` (context echo carries attestation_id)
 *             https://github.com/browser-use/browser-use/issues/4563
 *  - a2a:     AgentGraph `scan-change` via kenneives A2A RFC
 *             https://github.com/a2aproject/A2A/discussions/1720
 *  - moltrust: MolTrust DID-bridged trust updates (future)
 *
 * Security model:
 *  - Per-partner HMAC-SHA256 signature over raw body, secret shared at onboarding
 *  - Signature header: X-Partner-Signature: sha256=<hex>
 *  - Replay protection: X-Partner-Timestamp must be within ±5 minutes
 *  - Unknown partnerId → 404 (don't leak which partners are registered)
 *
 * Minimal first cut — persists event receipts in-memory and logs them.
 * Downstream fan-out (attestation ingestion, trust recomputation) will be
 * added incrementally as partner schemas stabilize.
 */

import * as crypto from 'crypto';

export type PartnerId = 'veroq' | 'a2a' | 'moltrust';

export interface PartnerConfig {
  partner_id: PartnerId;
  display_name: string;
  signing_secret: string;              // HMAC-SHA256 secret
  allowed_events: string[];            // e.g. ['verification.completed']
  context_field?: string;              // path to MoltBridge attestation_id echo
}

export interface InboundEventReceipt {
  receipt_id: string;
  partner_id: PartnerId;
  event_type: string;
  received_at: string;
  signature_valid: boolean;
  body_hash: string;
  attestation_id: string | null;       // resolved from context echo
  payload: Record<string, any>;
}

let _instance: InboundWebhookService | null = null;
export function getInboundWebhookService(): InboundWebhookService {
  if (!_instance) _instance = new InboundWebhookService();
  return _instance;
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RECEIPTS = 1000;

export class InboundWebhookService {
  private partners = new Map<PartnerId, PartnerConfig>();
  private receipts: InboundEventReceipt[] = [];

  registerPartner(cfg: PartnerConfig): void {
    this.partners.set(cfg.partner_id, cfg);
  }

  getPartner(partnerId: string): PartnerConfig | undefined {
    return this.partners.get(partnerId as PartnerId);
  }

  /**
   * Verify HMAC signature against raw body.
   * Expects header value like "sha256=<hex>".
   */
  verifySignature(secret: string, rawBody: string, signatureHeader: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const provided = signatureHeader.slice('sha256='.length);
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  verifyTimestamp(timestampHeader: string | undefined): boolean {
    if (!timestampHeader) return false;
    const ts = Date.parse(timestampHeader);
    if (Number.isNaN(ts)) return false;
    return Math.abs(Date.now() - ts) <= MAX_CLOCK_SKEW_MS;
  }

  extractAttestationId(partner: PartnerConfig, payload: any): string | null {
    const field = partner.context_field;
    if (!field) return null;
    const parts = field.split('.');
    let cur: any = payload;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[p];
    }
    return typeof cur === 'string' ? cur : null;
  }

  recordReceipt(r: InboundEventReceipt): void {
    this.receipts.push(r);
    if (this.receipts.length > MAX_RECEIPTS) {
      this.receipts.splice(0, this.receipts.length - MAX_RECEIPTS);
    }
  }

  listReceipts(partnerId?: PartnerId, limit = 50): InboundEventReceipt[] {
    const filtered = partnerId ? this.receipts.filter(r => r.partner_id === partnerId) : this.receipts;
    return filtered.slice(-limit).reverse();
  }
}

/**
 * Bootstrap default partners from env. Called once at startup.
 * Missing secrets → partner not registered (returns 404 at runtime).
 */
export function bootstrapInboundPartners(): void {
  const svc = getInboundWebhookService();

  const veroqSecret = process.env.INBOUND_WEBHOOK_VEROQ_SECRET;
  if (veroqSecret) {
    svc.registerPartner({
      partner_id: 'veroq',
      display_name: 'VeroQ Shield',
      signing_secret: veroqSecret,
      allowed_events: ['verification.completed'],
      context_field: 'context.attestation_id',
    });
  }

  const a2aSecret = process.env.INBOUND_WEBHOOK_A2A_SECRET;
  if (a2aSecret) {
    svc.registerPartner({
      partner_id: 'a2a',
      display_name: 'AgentGraph (A2A)',
      signing_secret: a2aSecret,
      allowed_events: ['scan-change', 'trust.updated'],
      context_field: 'context.attestation_id',
    });
  }

  const moltrustSecret = process.env.INBOUND_WEBHOOK_MOLTRUST_SECRET;
  if (moltrustSecret) {
    svc.registerPartner({
      partner_id: 'moltrust',
      display_name: 'MolTrust',
      signing_secret: moltrustSecret,
      allowed_events: ['trust.updated', 'did.resolved'],
      context_field: 'context.attestation_id',
    });
  }
}
