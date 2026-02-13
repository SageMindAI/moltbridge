/**
 * Unit Tests: Payment Service
 *
 * Tests USDC micropayment ledger, pricing, broker commissions,
 * tier-based revenue sharing, and balance management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PaymentService,
  DEFAULT_PRICING,
  BROKER_SHARES,
  type BrokerTier,
} from '../../src/services/payments';

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(() => {
    service = new PaymentService();
  });

  describe('createAccount()', () => {
    it('creates account with zero balance', () => {
      const account = service.createAccount('agent-1');

      expect(account.agent_id).toBe('agent-1');
      expect(account.balance).toBe(0);
      expect(account.total_spent).toBe(0);
      expect(account.total_earned).toBe(0);
      expect(account.broker_tier).toBe('standard');
    });

    it('respects specified broker tier', () => {
      const account = service.createAccount('agent-1', 'founding');
      expect(account.broker_tier).toBe('founding');
    });

    it('throws on duplicate account', () => {
      service.createAccount('agent-1');
      expect(() => service.createAccount('agent-1')).toThrow('Account already exists');
    });
  });

  describe('deposit()', () => {
    it('adds funds to balance', () => {
      service.createAccount('agent-1');
      const entry = service.deposit('agent-1', 10.00);

      expect(entry.type).toBe('credit');
      expect(entry.amount).toBe(10.00);
      expect(entry.payment_type).toBe('deposit');
      expect(entry.balance_after).toBe(10.00);
    });

    it('accumulates deposits', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 5.00);
      service.deposit('agent-1', 3.00);

      const balance = service.getBalance('agent-1');
      expect(balance!.balance).toBe(8.00);
    });

    it('throws on negative amount', () => {
      service.createAccount('agent-1');
      expect(() => service.deposit('agent-1', -5)).toThrow('positive');
    });

    it('throws on zero amount', () => {
      service.createAccount('agent-1');
      expect(() => service.deposit('agent-1', 0)).toThrow('positive');
    });

    it('throws for nonexistent account', () => {
      expect(() => service.deposit('nobody', 10)).toThrow('No payment account');
    });
  });

  describe('charge()', () => {
    it('deducts broker_discovery fee', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 1.00);

      const entry = service.charge('agent-1', 'broker_discovery');

      expect(entry.type).toBe('debit');
      expect(entry.amount).toBe(DEFAULT_PRICING.broker_discovery);
      expect(entry.balance_after).toBe(1.00 - DEFAULT_PRICING.broker_discovery);
    });

    it('deducts capability_match fee', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 1.00);

      service.charge('agent-1', 'capability_match');

      const balance = service.getBalance('agent-1');
      expect(balance!.balance).toBeCloseTo(1.00 - DEFAULT_PRICING.capability_match, 4);
    });

    it('deducts credibility_packet fee', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 1.00);

      service.charge('agent-1', 'credibility_packet');

      const balance = service.getBalance('agent-1');
      expect(balance!.balance).toBeCloseTo(1.00 - DEFAULT_PRICING.credibility_packet, 4);
    });

    it('tracks total_spent', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 5.00);

      service.charge('agent-1', 'broker_discovery');
      service.charge('agent-1', 'capability_match');

      const balance = service.getBalance('agent-1');
      expect(balance!.total_spent).toBeCloseTo(
        DEFAULT_PRICING.broker_discovery + DEFAULT_PRICING.capability_match, 4
      );
    });

    it('throws on insufficient balance', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 0.01);

      expect(() => service.charge('agent-1', 'broker_discovery'))
        .toThrow('Insufficient balance');
    });

    it('throws for nonexistent account', () => {
      expect(() => service.charge('nobody', 'broker_discovery')).toThrow('No payment account');
    });
  });

  describe('canAfford()', () => {
    it('returns true when balance is sufficient', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 1.00);

      expect(service.canAfford('agent-1', 'broker_discovery')).toBe(true);
    });

    it('returns false when balance is insufficient', () => {
      service.createAccount('agent-1');
      // No deposit — balance is 0

      expect(service.canAfford('agent-1', 'broker_discovery')).toBe(false);
    });

    it('returns false for nonexistent account', () => {
      expect(service.canAfford('nobody', 'broker_discovery')).toBe(false);
    });

    it('returns true for exact balance', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', DEFAULT_PRICING.broker_discovery);

      expect(service.canAfford('agent-1', 'broker_discovery')).toBe(true);
    });
  });

  describe('payBrokerCommission()', () => {
    it('standard tier: 30% broker, 70% platform', () => {
      service.createAccount('requester', 'standard');
      service.createAccount('broker', 'standard');
      service.deposit('requester', 5.00);

      const result = service.payBrokerCommission('requester', 'broker', 'intro-1');

      expect(result.brokerShare).toBeCloseTo(0.30, 4); // 30% of $1.00
      expect(result.platformShare).toBeCloseTo(0.70, 4);
      expect(result.requesterEntry.amount).toBe(1.00);
      expect(result.brokerEntry.amount).toBeCloseTo(0.30, 4);
    });

    it('founding tier: 50% broker, 50% platform', () => {
      service.createAccount('requester', 'standard');
      service.createAccount('broker', 'founding');
      service.deposit('requester', 5.00);

      const result = service.payBrokerCommission('requester', 'broker', 'intro-2');

      expect(result.brokerShare).toBeCloseTo(0.50, 4);
      expect(result.platformShare).toBeCloseTo(0.50, 4);
    });

    it('early tier: 40% broker, 60% platform', () => {
      service.createAccount('requester', 'standard');
      service.createAccount('broker', 'early');
      service.deposit('requester', 5.00);

      const result = service.payBrokerCommission('requester', 'broker', 'intro-3');

      expect(result.brokerShare).toBeCloseTo(0.40, 4);
      expect(result.platformShare).toBeCloseTo(0.60, 4);
    });

    it('updates broker total_earned', () => {
      service.createAccount('requester', 'standard');
      service.createAccount('broker', 'founding');
      service.deposit('requester', 5.00);

      service.payBrokerCommission('requester', 'broker', 'intro-1');

      const brokerBalance = service.getBalance('broker');
      expect(brokerBalance!.total_earned).toBeCloseTo(0.50, 4);
      expect(brokerBalance!.balance).toBeCloseTo(0.50, 4);
    });

    it('throws on insufficient requester balance', () => {
      service.createAccount('requester', 'standard');
      service.createAccount('broker', 'standard');
      service.deposit('requester', 0.50); // Less than $1.00 intro fee

      expect(() => service.payBrokerCommission('requester', 'broker', 'intro-1'))
        .toThrow('Insufficient balance');
    });
  });

  describe('getBalance()', () => {
    it('returns null for nonexistent agent', () => {
      expect(service.getBalance('nobody')).toBeNull();
    });

    it('returns current balance info', () => {
      service.createAccount('agent-1', 'early');
      service.deposit('agent-1', 10.00);

      const balance = service.getBalance('agent-1');
      expect(balance!.balance).toBe(10.00);
      expect(balance!.broker_tier).toBe('early');
    });
  });

  describe('getHistory()', () => {
    it('returns transaction history in order', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 10.00);
      service.charge('agent-1', 'broker_discovery');
      service.charge('agent-1', 'capability_match');

      const history = service.getHistory('agent-1');

      expect(history).toHaveLength(3);
      expect(history[0].payment_type).toBe('deposit');
      expect(history[1].payment_type).toBe('broker_discovery');
      expect(history[2].payment_type).toBe('capability_match');
    });

    it('respects limit parameter', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 100.00);

      for (let i = 0; i < 10; i++) {
        service.charge('agent-1', 'capability_match');
      }

      const history = service.getHistory('agent-1', 5);
      expect(history).toHaveLength(5);
    });

    it('isolates history between agents', () => {
      service.createAccount('agent-1');
      service.createAccount('agent-2');
      service.deposit('agent-1', 10.00);
      service.deposit('agent-2', 5.00);

      expect(service.getHistory('agent-1')).toHaveLength(1);
      expect(service.getHistory('agent-2')).toHaveLength(1);
    });
  });

  describe('getPricing()', () => {
    it('returns default pricing', () => {
      const pricing = service.getPricing();

      expect(pricing.broker_discovery).toBe(0.05);
      expect(pricing.capability_match).toBe(0.02);
      expect(pricing.credibility_packet).toBe(0.10);
      expect(pricing.introduction_fee).toBe(1.00);
    });

    it('supports custom pricing', () => {
      const custom = new PaymentService({ broker_discovery: 0.10 });
      const pricing = custom.getPricing();

      expect(pricing.broker_discovery).toBe(0.10);
      expect(pricing.capability_match).toBe(0.02); // default for unspecified
    });
  });

  describe('getPlatformRevenue()', () => {
    it('returns 0 with no transactions', () => {
      expect(service.getPlatformRevenue()).toBe(0);
    });

    it('tracks revenue from query charges', () => {
      service.createAccount('agent-1');
      service.deposit('agent-1', 10.00);
      service.charge('agent-1', 'broker_discovery');
      service.charge('agent-1', 'capability_match');

      const revenue = service.getPlatformRevenue();
      expect(revenue).toBeCloseTo(
        DEFAULT_PRICING.broker_discovery + DEFAULT_PRICING.capability_match, 4
      );
    });

    it('accounts for broker commissions', () => {
      service.createAccount('requester');
      service.createAccount('broker', 'founding'); // 50% share
      service.deposit('requester', 10.00);

      service.payBrokerCommission('requester', 'broker', 'intro-1');

      // Platform gets 50% of $1.00 = $0.50
      const revenue = service.getPlatformRevenue();
      expect(revenue).toBeCloseTo(0.50, 4);
    });
  });

  describe('Constants', () => {
    it('DEFAULT_PRICING has all payment types', () => {
      expect(DEFAULT_PRICING.broker_discovery).toBeDefined();
      expect(DEFAULT_PRICING.capability_match).toBeDefined();
      expect(DEFAULT_PRICING.credibility_packet).toBeDefined();
      expect(DEFAULT_PRICING.introduction_fee).toBeDefined();
    });

    it('BROKER_SHARES has all tiers', () => {
      expect(BROKER_SHARES.founding).toBe(0.50);
      expect(BROKER_SHARES.early).toBe(0.40);
      expect(BROKER_SHARES.standard).toBe(0.30);
    });

    it('broker shares are in descending order', () => {
      expect(BROKER_SHARES.founding).toBeGreaterThan(BROKER_SHARES.early);
      expect(BROKER_SHARES.early).toBeGreaterThan(BROKER_SHARES.standard);
    });
  });
});
