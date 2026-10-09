import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { InboundWebhookService } from '../../src/services/inbound-webhooks';

function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('InboundWebhookService', () => {
  let svc: InboundWebhookService;
  const secret = 'test-secret';

  beforeEach(() => {
    svc = new InboundWebhookService();
    svc.registerPartner({
      partner_id: 'veroq',
      display_name: 'VeroQ Shield',
      signing_secret: secret,
      allowed_events: ['verification.completed'],
      context_field: 'context.attestation_id',
    });
  });

  it('verifies a valid signature', () => {
    const body = '{"event":"verification.completed"}';
    expect(svc.verifySignature(secret, body, sign(secret, body))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(secret, '{"event":"verification.completed"}');
    expect(svc.verifySignature(secret, '{"event":"tampered"}', sig)).toBe(false);
  });

  it('rejects malformed signature header', () => {
    expect(svc.verifySignature(secret, 'x', 'md5=abc')).toBe(false);
    expect(svc.verifySignature(secret, 'x', '')).toBe(false);
  });

  it('enforces ±5 minute timestamp window', () => {
    expect(svc.verifyTimestamp(new Date().toISOString())).toBe(true);
    expect(svc.verifyTimestamp(new Date(Date.now() - 10 * 60 * 1000).toISOString())).toBe(false);
    expect(svc.verifyTimestamp(undefined)).toBe(false);
    expect(svc.verifyTimestamp('not-a-date')).toBe(false);
  });

  it('extracts attestation id from nested context', () => {
    const partner = svc.getPartner('veroq')!;
    const id = svc.extractAttestationId(partner, { context: { attestation_id: 'att_123' } });
    expect(id).toBe('att_123');
    expect(svc.extractAttestationId(partner, {})).toBeNull();
    expect(svc.extractAttestationId(partner, { context: {} })).toBeNull();
  });

  it('returns undefined partner for unknown id', () => {
    expect(svc.getPartner('nope')).toBeUndefined();
  });

  it('records and lists receipts with cap', () => {
    for (let i = 0; i < 5; i++) {
      svc.recordReceipt({
        receipt_id: `r${i}`,
        partner_id: 'veroq',
        event_type: 'verification.completed',
        received_at: new Date().toISOString(),
        signature_valid: true,
        body_hash: 'h',
        attestation_id: null,
        payload: {},
      });
    }
    const list = svc.listReceipts('veroq', 3);
    expect(list).toHaveLength(3);
    expect(list[0].receipt_id).toBe('r4'); // newest first
  });
});
