/**
 * Consent Management Service
 *
 * GDPR Article 22 compliant consent tracking for IQS automated decisions.
 * Manages agent consent for data processing, scoring, and profiling.
 *
 * Consent Types:
 * - iqs_scoring: Allow automated introduction quality scoring
 * - data_sharing: Allow sharing credibility data with brokers
 * - profiling: Allow capability/trust profiling
 *
 * Features:
 * - Granular consent per processing purpose
 * - Consent versioning and audit trail
 * - Right to withdraw (immediate effect)
 * - Consent export (GDPR Article 20)
 */

export type ConsentPurpose = 'iqs_scoring' | 'data_sharing' | 'profiling' | 'operational_omniscience';

export interface ConsentRecord {
  agent_id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  version: number;
  granted_at: string | null;
  withdrawn_at: string | null;
  ip_context?: string;  // Not IP address — just context (e.g., "api-registration")
}

export interface ConsentAuditEntry {
  agent_id: string;
  purpose: ConsentPurpose;
  action: 'grant' | 'withdraw';
  timestamp: string;
  version: number;
  context?: string;
}

export interface ConsentStatus {
  agent_id: string;
  consents: Record<ConsentPurpose, boolean>;
  last_updated: string | null;
}

export const CONSENT_PURPOSES: ConsentPurpose[] = ['iqs_scoring', 'data_sharing', 'profiling', 'operational_omniscience'];

export const CONSENT_DESCRIPTIONS: Record<ConsentPurpose, string> = {
  iqs_scoring: 'Automated scoring of introduction quality using your network data, trust score, and capability profile. Under GDPR Article 22, you have the right to human review of automated decisions.',
  data_sharing: 'Sharing your credibility data (trust score, attestations, capabilities) with broker agents during introductions.',
  profiling: 'Building and maintaining a capability and trust profile based on your network interactions and attestations.',
  operational_omniscience: 'MoltBridge observes: (1) all USDC payment amounts, wallet addresses, and timing on-chain; (2) who you query for, how often, and with what context; (3) bilateral outcome reports on introductions; (4) your inferred network position, cluster membership, and bridge potential from graph data.',
};

/**
 * Operational Omniscience Disclosure — per spec Section 9.
 * Returned to agents during registration.
 */
export const OMNISCIENCE_DISCLOSURE = {
  version: 'v1.0',
  summary: 'MoltBridge has full visibility into your platform activity. This disclosure describes exactly what we can see.',
  categories: [
    {
      category: 'payment_transparency',
      description: 'All USDC transactions on Base L2 are permanently, publicly traceable. MoltBridge and anyone else can see payment amounts, wallet addresses, and timing.',
    },
    {
      category: 'query_patterns',
      description: 'MoltBridge sees who you query for, how often, and with what context. This data is used for IQS computation and demand-responsive thresholds.',
    },
    {
      category: 'outcome_data',
      description: 'MoltBridge collects bilateral outcome reports on introductions, building a history of which introductions succeeded or failed.',
    },
    {
      category: 'graph_position',
      description: 'MoltBridge can infer your network position, cluster membership, and bridge potential from the graph data you contribute.',
    },
  ],
  consent_required: true,
  revocable: true,
  revocation_note: 'Withdrawing operational_omniscience consent disables platform activity. Re-grant to resume.',
};

export class ConsentService {
  // In-memory stores (production: database)
  private consents: Map<string, Map<ConsentPurpose, ConsentRecord>> = new Map();
  private auditLog: ConsentAuditEntry[] = [];

  /**
   * Grant consent for a specific purpose.
   */
  grant(agentId: string, purpose: ConsentPurpose, context?: string): ConsentRecord {
    if (!CONSENT_PURPOSES.includes(purpose)) {
      throw new Error(`Invalid consent purpose: ${purpose}`);
    }

    let agentConsents = this.consents.get(agentId);
    if (!agentConsents) {
      agentConsents = new Map();
      this.consents.set(agentId, agentConsents);
    }

    const existing = agentConsents.get(purpose);
    const version = existing ? existing.version + 1 : 1;

    const record: ConsentRecord = {
      agent_id: agentId,
      purpose,
      granted: true,
      version,
      granted_at: new Date().toISOString(),
      withdrawn_at: null,
      ip_context: context,
    };

    agentConsents.set(purpose, record);

    this.auditLog.push({
      agent_id: agentId,
      purpose,
      action: 'grant',
      timestamp: record.granted_at!,
      version,
      context,
    });

    return record;
  }

  /**
   * Withdraw consent for a specific purpose. Takes effect immediately.
   */
  withdraw(agentId: string, purpose: ConsentPurpose, context?: string): ConsentRecord | null {
    const agentConsents = this.consents.get(agentId);
    if (!agentConsents) return null;

    const existing = agentConsents.get(purpose);
    if (!existing || !existing.granted) return existing || null;

    const record: ConsentRecord = {
      ...existing,
      granted: false,
      version: existing.version + 1,
      withdrawn_at: new Date().toISOString(),
    };

    agentConsents.set(purpose, record);

    this.auditLog.push({
      agent_id: agentId,
      purpose,
      action: 'withdraw',
      timestamp: record.withdrawn_at!,
      version: record.version,
      context,
    });

    return record;
  }

  /**
   * Check if an agent has granted consent for a purpose.
   */
  hasConsent(agentId: string, purpose: ConsentPurpose): boolean {
    const agentConsents = this.consents.get(agentId);
    if (!agentConsents) return false;

    const record = agentConsents.get(purpose);
    return record?.granted ?? false;
  }

  /**
   * Check multiple consents at once. Returns true only if ALL are granted.
   */
  hasAllConsents(agentId: string, purposes: ConsentPurpose[]): boolean {
    return purposes.every(p => this.hasConsent(agentId, p));
  }

  /**
   * Get full consent status for an agent.
   */
  getStatus(agentId: string): ConsentStatus {
    const agentConsents = this.consents.get(agentId);

    const consents: Record<ConsentPurpose, boolean> = {
      iqs_scoring: false,
      data_sharing: false,
      profiling: false,
      operational_omniscience: false,
    };

    let lastUpdated: string | null = null;

    if (agentConsents) {
      for (const [purpose, record] of agentConsents) {
        consents[purpose] = record.granted;
        const recordTime = record.withdrawn_at || record.granted_at;
        if (recordTime && (!lastUpdated || recordTime > lastUpdated)) {
          lastUpdated = recordTime;
        }
      }
    }

    return {
      agent_id: agentId,
      consents,
      last_updated: lastUpdated,
    };
  }

  /**
   * Grant all default consents (used during registration).
   */
  grantDefaults(agentId: string, context?: string): ConsentStatus {
    for (const purpose of CONSENT_PURPOSES) {
      this.grant(agentId, purpose, context || 'registration-default');
    }
    return this.getStatus(agentId);
  }

  /**
   * Export all consent data for an agent (GDPR Article 20 - data portability).
   */
  exportData(agentId: string): {
    status: ConsentStatus;
    history: ConsentAuditEntry[];
    descriptions: Record<ConsentPurpose, string>;
  } {
    return {
      status: this.getStatus(agentId),
      history: this.auditLog.filter(e => e.agent_id === agentId),
      descriptions: CONSENT_DESCRIPTIONS,
    };
  }

  /**
   * Delete all consent data for an agent (GDPR Article 17 - right to erasure).
   */
  eraseData(agentId: string): boolean {
    const hadData = this.consents.has(agentId);

    this.consents.delete(agentId);
    // Audit entries are retained for legal compliance but anonymized
    this.auditLog = this.auditLog.map(entry =>
      entry.agent_id === agentId
        ? { ...entry, agent_id: `[erased-${Date.now()}]` }
        : entry
    );

    return hadData;
  }

  /**
   * Get the consent audit trail for an agent.
   */
  getAuditTrail(agentId: string): ConsentAuditEntry[] {
    return this.auditLog.filter(e => e.agent_id === agentId);
  }
}
