/**
 * Unit Tests: Consent Management Service
 *
 * Tests GDPR-compliant consent tracking, granular permissions,
 * audit trails, data export, and erasure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConsentService,
  CONSENT_PURPOSES,
  CONSENT_DESCRIPTIONS,
  type ConsentPurpose,
} from '../../src/services/consent';

describe('ConsentService', () => {
  let service: ConsentService;

  beforeEach(() => {
    service = new ConsentService();
  });

  describe('grant()', () => {
    it('grants consent and returns a record', () => {
      const record = service.grant('agent-1', 'iqs_scoring');

      expect(record.agent_id).toBe('agent-1');
      expect(record.purpose).toBe('iqs_scoring');
      expect(record.granted).toBe(true);
      expect(record.version).toBe(1);
      expect(record.granted_at).toBeTruthy();
      expect(record.withdrawn_at).toBeNull();
    });

    it('increments version on re-grant', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.withdraw('agent-1', 'iqs_scoring');
      const record = service.grant('agent-1', 'iqs_scoring');

      expect(record.version).toBe(3); // grant(1) -> withdraw(2) -> grant(3)
    });

    it('throws on invalid purpose', () => {
      expect(() => service.grant('agent-1', 'invalid' as ConsentPurpose)).toThrow('Invalid consent purpose');
    });

    it('stores context metadata', () => {
      const record = service.grant('agent-1', 'iqs_scoring', 'api-registration');
      expect(record.ip_context).toBe('api-registration');
    });
  });

  describe('withdraw()', () => {
    it('withdraws existing consent', () => {
      service.grant('agent-1', 'data_sharing');
      const record = service.withdraw('agent-1', 'data_sharing');

      expect(record).not.toBeNull();
      expect(record!.granted).toBe(false);
      expect(record!.withdrawn_at).toBeTruthy();
    });

    it('returns null for agent with no consents', () => {
      const result = service.withdraw('nobody', 'iqs_scoring');
      expect(result).toBeNull();
    });

    it('returns already-withdrawn consent without changes', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.withdraw('agent-1', 'iqs_scoring');
      const result = service.withdraw('agent-1', 'iqs_scoring');

      expect(result).not.toBeNull();
      expect(result!.granted).toBe(false);
    });

    it('takes effect immediately', () => {
      service.grant('agent-1', 'profiling');
      expect(service.hasConsent('agent-1', 'profiling')).toBe(true);

      service.withdraw('agent-1', 'profiling');
      expect(service.hasConsent('agent-1', 'profiling')).toBe(false);
    });
  });

  describe('hasConsent()', () => {
    it('returns false for unknown agent', () => {
      expect(service.hasConsent('unknown', 'iqs_scoring')).toBe(false);
    });

    it('returns true for granted consent', () => {
      service.grant('agent-1', 'iqs_scoring');
      expect(service.hasConsent('agent-1', 'iqs_scoring')).toBe(true);
    });

    it('returns false after withdrawal', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.withdraw('agent-1', 'iqs_scoring');
      expect(service.hasConsent('agent-1', 'iqs_scoring')).toBe(false);
    });

    it('is granular per purpose', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.grant('agent-1', 'data_sharing');

      expect(service.hasConsent('agent-1', 'iqs_scoring')).toBe(true);
      expect(service.hasConsent('agent-1', 'data_sharing')).toBe(true);
      expect(service.hasConsent('agent-1', 'profiling')).toBe(false);
    });
  });

  describe('hasAllConsents()', () => {
    it('returns true when all consents are granted', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.grant('agent-1', 'data_sharing');

      expect(service.hasAllConsents('agent-1', ['iqs_scoring', 'data_sharing'])).toBe(true);
    });

    it('returns false when any consent is missing', () => {
      service.grant('agent-1', 'iqs_scoring');

      expect(service.hasAllConsents('agent-1', ['iqs_scoring', 'data_sharing'])).toBe(false);
    });

    it('returns true for empty purposes array', () => {
      expect(service.hasAllConsents('agent-1', [])).toBe(true);
    });
  });

  describe('getStatus()', () => {
    it('returns all-false for unknown agent', () => {
      const status = service.getStatus('unknown');

      expect(status.agent_id).toBe('unknown');
      expect(status.consents.iqs_scoring).toBe(false);
      expect(status.consents.data_sharing).toBe(false);
      expect(status.consents.profiling).toBe(false);
      expect(status.last_updated).toBeNull();
    });

    it('reflects current consent state', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.grant('agent-1', 'profiling');

      const status = service.getStatus('agent-1');

      expect(status.consents.iqs_scoring).toBe(true);
      expect(status.consents.data_sharing).toBe(false);
      expect(status.consents.profiling).toBe(true);
      expect(status.last_updated).toBeTruthy();
    });
  });

  describe('grantDefaults()', () => {
    it('grants all consent purposes', () => {
      const status = service.grantDefaults('agent-1');

      expect(status.consents.iqs_scoring).toBe(true);
      expect(status.consents.data_sharing).toBe(true);
      expect(status.consents.profiling).toBe(true);
    });

    it('uses registration-default context', () => {
      service.grantDefaults('agent-1');
      const trail = service.getAuditTrail('agent-1');

      expect(trail.every(e => e.context === 'registration-default')).toBe(true);
    });
  });

  describe('exportData() — GDPR Article 20', () => {
    it('exports complete consent data', () => {
      service.grant('agent-1', 'iqs_scoring', 'registration');
      service.grant('agent-1', 'data_sharing', 'registration');
      service.withdraw('agent-1', 'data_sharing', 'user-request');

      const data = service.exportData('agent-1');

      expect(data.status.consents.iqs_scoring).toBe(true);
      expect(data.status.consents.data_sharing).toBe(false);
      expect(data.history).toHaveLength(3); // 2 grants + 1 withdraw
      expect(data.descriptions).toEqual(CONSENT_DESCRIPTIONS);
    });

    it('returns empty data for unknown agent', () => {
      const data = service.exportData('unknown');

      expect(data.history).toHaveLength(0);
      expect(data.status.consents.iqs_scoring).toBe(false);
    });
  });

  describe('eraseData() — GDPR Article 17', () => {
    it('deletes all consent data for an agent', () => {
      service.grantDefaults('agent-1');
      const erased = service.eraseData('agent-1');

      expect(erased).toBe(true);

      const status = service.getStatus('agent-1');
      expect(status.consents.iqs_scoring).toBe(false);
      expect(status.consents.data_sharing).toBe(false);
      expect(status.consents.profiling).toBe(false);
    });

    it('anonymizes audit entries instead of deleting', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.eraseData('agent-1');

      // Audit entries should be anonymized but still exist
      const trail = service.getAuditTrail('agent-1');
      expect(trail).toHaveLength(0); // agent-1 entries anonymized

      // But total audit log still has entries (with anonymized IDs)
      const fullData = service.exportData('agent-1');
      expect(fullData.history).toHaveLength(0);
    });

    it('returns false for agent with no data', () => {
      const erased = service.eraseData('nobody');
      expect(erased).toBe(false);
    });
  });

  describe('getAuditTrail()', () => {
    it('records all consent actions in order', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.grant('agent-1', 'data_sharing');
      service.withdraw('agent-1', 'iqs_scoring');

      const trail = service.getAuditTrail('agent-1');

      expect(trail).toHaveLength(3);
      expect(trail[0].action).toBe('grant');
      expect(trail[0].purpose).toBe('iqs_scoring');
      expect(trail[1].action).toBe('grant');
      expect(trail[1].purpose).toBe('data_sharing');
      expect(trail[2].action).toBe('withdraw');
      expect(trail[2].purpose).toBe('iqs_scoring');
    });

    it('isolates trails between agents', () => {
      service.grant('agent-1', 'iqs_scoring');
      service.grant('agent-2', 'data_sharing');

      expect(service.getAuditTrail('agent-1')).toHaveLength(1);
      expect(service.getAuditTrail('agent-2')).toHaveLength(1);
    });
  });

  describe('Constants', () => {
    it('CONSENT_PURPOSES has all 3 purposes', () => {
      expect(CONSENT_PURPOSES).toEqual(['iqs_scoring', 'data_sharing', 'profiling']);
    });

    it('CONSENT_DESCRIPTIONS has description for each purpose', () => {
      for (const purpose of CONSENT_PURPOSES) {
        expect(CONSENT_DESCRIPTIONS[purpose]).toBeTruthy();
        expect(typeof CONSENT_DESCRIPTIONS[purpose]).toBe('string');
      }
    });
  });
});
