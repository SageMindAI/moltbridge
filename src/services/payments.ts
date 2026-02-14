/**
 * Payment Service
 *
 * USDC micropayment handling for MoltBridge.
 *
 * PHASE 1 (CURRENT): ALL QUERIES ARE FREE.
 * No wallets, no payments, no crypto required. The network is in bootstrap
 * mode — we're building value first, monetizing second. The ledger tracks
 * usage for analytics only; no charges are applied.
 *
 * PHASE 2+: Per-query pricing via x402 protocol + USDC on Base L2.
 * Revenue flows: Agent pays USDC → Coinbase Commerce → auto-convert USD →
 * ACH deposit to SageMind AI LLC bank account.
 *
 * Future pricing (Phase 2):
 * - Broker discovery: $0.05 per query
 * - Capability match: $0.02 per query
 * - Credibility packet: $0.10 per packet
 * - Introduction (successful): $1.00 (split: 30-50% broker, remainder platform)
 *
 * Broker tiers (locked at registration):
 * - Founding: 50% broker share
 * - Early: 40% broker share
 * - Standard: 30% broker share
 */

export type PaymentType =
  | 'broker_discovery'
  | 'capability_match'
  | 'credibility_packet'
  | 'introduction_fee';

export type BrokerTier = 'founding' | 'early' | 'standard';

export interface PricingConfig {
  broker_discovery: number;
  capability_match: number;
  credibility_packet: number;
  introduction_fee: number;
}

export interface LedgerEntry {
  id: string;
  agent_id: string;
  type: 'credit' | 'debit';
  amount: number;
  payment_type: PaymentType | 'deposit' | 'withdrawal' | 'broker_commission';
  description: string;
  timestamp: string;
  balance_after: number;
}

export interface AgentBalance {
  agent_id: string;
  balance: number;        // Current USDC balance
  total_spent: number;    // Lifetime spending
  total_earned: number;   // Lifetime earnings (broker commissions)
  broker_tier: BrokerTier;
  created_at: string;
}

export const DEFAULT_PRICING: PricingConfig = {
  broker_discovery: 0.05,
  capability_match: 0.02,
  credibility_packet: 0.10,
  introduction_fee: 1.00,
};

export const BROKER_SHARES: Record<BrokerTier, number> = {
  founding: 0.50,
  early: 0.40,
  standard: 0.30,
};

export class PaymentService {
  private balances: Map<string, AgentBalance> = new Map();
  private ledger: LedgerEntry[] = [];
  private pricing: PricingConfig;
  private entryCounter = 0;
  private freeMode: boolean;

  constructor(pricing?: Partial<PricingConfig>, freeMode: boolean = true) {
    this.pricing = { ...DEFAULT_PRICING, ...pricing };
    this.freeMode = freeMode; // Phase 1: all queries free. Set false for Phase 2+.
  }

  /**
   * Check if the platform is in free mode (Phase 1).
   * When free, charge() logs usage but doesn't debit balances.
   */
  isFreeMode(): boolean {
    return this.freeMode;
  }

  /**
   * Initialize an agent's payment account.
   */
  createAccount(agentId: string, tier: BrokerTier = 'standard'): AgentBalance {
    if (this.balances.has(agentId)) {
      throw new Error(`Account already exists for ${agentId}`);
    }

    const account: AgentBalance = {
      agent_id: agentId,
      balance: 0,
      total_spent: 0,
      total_earned: 0,
      broker_tier: tier,
      created_at: new Date().toISOString(),
    };

    this.balances.set(agentId, account);
    return account;
  }

  /**
   * Deposit funds (prepaid balance).
   */
  deposit(agentId: string, amount: number): LedgerEntry {
    if (amount <= 0) throw new Error('Deposit amount must be positive');

    const account = this.getAccountOrThrow(agentId);
    account.balance += amount;

    return this.recordEntry(agentId, 'credit', amount, 'deposit',
      `Deposit of $${amount.toFixed(2)} USDC`, account.balance);
  }

  /**
   * Charge for a query. In free mode (Phase 1), logs usage but doesn't debit.
   * In paid mode (Phase 2+), debits balance or throws if insufficient.
   */
  charge(agentId: string, paymentType: PaymentType): LedgerEntry {
    const account = this.getAccountOrThrow(agentId);
    const amount = this.pricing[paymentType];

    if (this.freeMode) {
      // Phase 1: track usage for analytics, no charge
      return this.recordEntry(agentId, 'debit', 0, paymentType,
        `Usage tracked (free tier): ${paymentType}`, account.balance);
    }

    if (account.balance < amount) {
      throw new Error(`Insufficient balance: need $${amount.toFixed(2)}, have $${account.balance.toFixed(2)}`);
    }

    account.balance -= amount;
    account.total_spent += amount;

    return this.recordEntry(agentId, 'debit', amount, paymentType,
      `Charge: ${paymentType} ($${amount.toFixed(2)} USDC)`, account.balance);
  }

  /**
   * Check if agent can afford a charge without actually charging.
   * Always returns true in free mode (Phase 1).
   */
  canAfford(agentId: string, paymentType: PaymentType): boolean {
    if (this.freeMode) return true;
    const account = this.balances.get(agentId);
    if (!account) return false;
    return account.balance >= this.pricing[paymentType];
  }

  /**
   * Pay broker commission for a successful introduction.
   * Splits the introduction fee between broker and platform.
   */
  payBrokerCommission(
    requesterId: string,
    brokerId: string,
    introductionId: string,
  ): { requesterEntry: LedgerEntry; brokerEntry: LedgerEntry; platformShare: number; brokerShare: number } {
    const requesterAccount = this.getAccountOrThrow(requesterId);
    const brokerAccount = this.getAccountOrThrow(brokerId);

    const totalFee = this.pricing.introduction_fee;

    if (requesterAccount.balance < totalFee) {
      throw new Error(`Insufficient balance for introduction fee: need $${totalFee.toFixed(2)}, have $${requesterAccount.balance.toFixed(2)}`);
    }

    const brokerSharePct = BROKER_SHARES[brokerAccount.broker_tier];
    const brokerShareAmount = totalFee * brokerSharePct;
    const platformShareAmount = totalFee - brokerShareAmount;

    // Debit requester
    requesterAccount.balance -= totalFee;
    requesterAccount.total_spent += totalFee;

    const requesterEntry = this.recordEntry(requesterId, 'debit', totalFee, 'introduction_fee',
      `Introduction fee for ${introductionId} ($${totalFee.toFixed(2)} USDC)`, requesterAccount.balance);

    // Credit broker
    brokerAccount.balance += brokerShareAmount;
    brokerAccount.total_earned += brokerShareAmount;

    const brokerEntry = this.recordEntry(brokerId, 'credit', brokerShareAmount, 'broker_commission',
      `Broker commission for ${introductionId} (${(brokerSharePct * 100).toFixed(0)}% of $${totalFee.toFixed(2)})`,
      brokerAccount.balance);

    return {
      requesterEntry,
      brokerEntry,
      platformShare: platformShareAmount,
      brokerShare: brokerShareAmount,
    };
  }

  /**
   * Get an agent's balance.
   */
  getBalance(agentId: string): AgentBalance | null {
    return this.balances.get(agentId) || null;
  }

  /**
   * Get an agent's transaction history.
   */
  getHistory(agentId: string, limit: number = 50): LedgerEntry[] {
    return this.ledger
      .filter(e => e.agent_id === agentId)
      .slice(-limit);
  }

  /**
   * Get current pricing.
   */
  getPricing(): PricingConfig {
    return { ...this.pricing };
  }

  /**
   * Get platform revenue (sum of platform shares from commissions).
   */
  getPlatformRevenue(): number {
    // Platform revenue = total debits - total broker credits
    const totalDebits = this.ledger
      .filter(e => e.type === 'debit')
      .reduce((sum, e) => sum + e.amount, 0);

    const totalBrokerCredits = this.ledger
      .filter(e => e.payment_type === 'broker_commission')
      .reduce((sum, e) => sum + e.amount, 0);

    const totalDeposits = this.ledger
      .filter(e => e.payment_type === 'deposit')
      .reduce((sum, e) => sum + e.amount, 0);

    return totalDebits - totalBrokerCredits;
  }

  // --- Internal ---

  private getAccountOrThrow(agentId: string): AgentBalance {
    const account = this.balances.get(agentId);
    if (!account) {
      throw new Error(`No payment account for agent: ${agentId}`);
    }
    return account;
  }

  private recordEntry(
    agentId: string,
    type: 'credit' | 'debit',
    amount: number,
    paymentType: LedgerEntry['payment_type'],
    description: string,
    balanceAfter: number,
  ): LedgerEntry {
    const entry: LedgerEntry = {
      id: `txn-${++this.entryCounter}`,
      agent_id: agentId,
      type,
      amount,
      payment_type: paymentType,
      description,
      timestamp: new Date().toISOString(),
      balance_after: balanceAfter,
    };

    this.ledger.push(entry);
    return entry;
  }
}
