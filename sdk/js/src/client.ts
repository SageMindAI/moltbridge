/**
 * MoltBridge SDK — TypeScript Client
 *
 * Thin wrapper around the REST API with Ed25519 signing,
 * proof-of-AI verification, retry logic, and typed responses.
 *
 * Usage:
 *   import { MoltBridge } from '@moltbridge/sdk';
 *
 *   const mb = new MoltBridge();
 *   await mb.verify();
 *   await mb.register({ clusters: ['AI Research'], capabilities: ['NLP'] });
 *   const result = await mb.discoverBroker({ target: 'Peter Diamandis' });
 */

import { createHash } from 'node:crypto';

import { Ed25519Signer } from './auth.js';
import { MoltBridgeError } from './errors.js';
import type {
  MoltBridgeConfig,
  HealthResponse,
  VerificationChallenge,
  VerificationResult,
  RegistrationResponse,
  BrokerDiscoveryResponse,
  CapabilityMatchResponse,
  CredibilityPacketResponse,
  AttestationResult,
  IQSResult,
  ConsentStatus,
  ConsentRecord,
  AgentBalance,
  LedgerEntry,
  WebhookRegistration,
  PricingInfo,
  RegisterOptions,
  DiscoverBrokerOptions,
  DiscoverCapabilityOptions,
  AttestOptions,
  IQSEvaluateOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.moltbridge.ai';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class MoltBridge {
  private readonly _baseUrl: string;
  private readonly _timeout: number;
  private readonly _maxRetries: number;
  private _signer: Ed25519Signer | null = null;
  private _verificationToken: string | null = null;

  constructor(config: MoltBridgeConfig = {}) {
    this._baseUrl = (config.baseUrl ?? process.env.MOLTBRIDGE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this._maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

    const agentId = config.agentId ?? process.env.MOLTBRIDGE_AGENT_ID;
    const signingKey = config.signingKey ?? process.env.MOLTBRIDGE_SIGNING_KEY;

    if (agentId && signingKey) {
      this._signer = Ed25519Signer.fromSeed(signingKey, agentId);
    } else if (agentId) {
      this._signer = Ed25519Signer.generate(agentId);
    }
  }

  get agentId(): string | null {
    return this._signer?.agentId ?? null;
  }

  get publicKey(): string | null {
    return this._signer?.publicKeyB64 ?? null;
  }

  // ========================
  // HTTP helpers
  // ========================

  private async _request<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { body?: Record<string, unknown>; auth?: boolean; retries?: number } = {},
  ): Promise<T> {
    const { body, auth = true, retries = this._maxRetries } = options;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (auth) {
      if (!this._signer) {
        throw new MoltBridgeError(
          'Authentication required but no agentId/signingKey configured. ' +
          'Set MOLTBRIDGE_AGENT_ID and MOLTBRIDGE_SIGNING_KEY environment variables.',
          0,
          'NO_AUTH',
        );
      }
      headers['Authorization'] = this._signer.signRequest(method, path, body);
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeout);

      try {
        const response = await fetch(`${this._baseUrl}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        const data = await response.json() as Record<string, unknown>;

        if (response.status >= 400) {
          throw MoltBridgeError.fromResponse(response.status, data);
        }

        return data as T;
      } catch (err) {
        clearTimeout(timer);

        if (err instanceof MoltBridgeError) throw err;

        if (attempt < retries - 1) {
          await sleep(RETRY_BACKOFF[Math.min(attempt, RETRY_BACKOFF.length - 1)]);
          continue;
        }
        throw new MoltBridgeError(
          `Connection failed after ${retries} attempts: ${err}`,
          0,
          'CONNECTION_ERROR',
        );
      }
    }

    throw new MoltBridgeError('Unexpected retry exhaustion', 0);
  }

  // ========================
  // Health
  // ========================

  async health(): Promise<HealthResponse> {
    return this._request('GET', '/health', { auth: false, retries: 1 });
  }

  async pricing(): Promise<PricingInfo> {
    return this._request('GET', '/payments/pricing', { auth: false, retries: 1 });
  }

  // ========================
  // Verification
  // ========================

  /**
   * Complete the proof-of-AI verification challenge.
   * The SDK handles the SHA-256 challenge-response automatically.
   */
  async verify(): Promise<VerificationResult> {
    const challengeData = await this._request<Record<string, unknown>>(
      'POST', '/verify', { body: {}, auth: false },
    );

    if (challengeData.verified) {
      const result = { verified: true, token: challengeData.token as string };
      this._verificationToken = result.token;
      return result;
    }

    const challenge: VerificationChallenge = {
      challenge_id: challengeData.challenge_id as string,
      nonce: challengeData.nonce as string,
      difficulty: challengeData.difficulty as number,
      timestamp: challengeData.expires_at as string,
    };

    const targetPrefix = '0'.repeat(challenge.difficulty);
    const proof = this._solveChallenge(challenge.nonce, targetPrefix);

    const result = await this._request<Record<string, unknown>>(
      'POST', '/verify',
      { body: { challenge_id: challenge.challenge_id, proof_of_work: proof }, auth: false },
    );

    this._verificationToken = (result.token as string) ?? null;
    return {
      verified: (result.verified as boolean) ?? false,
      token: this._verificationToken ?? '',
    };
  }

  private _solveChallenge(nonce: string, targetPrefix: string): string {
    let counter = 0;
    while (counter < 10_000_000) {
      const counterStr = String(counter);
      const digest = createHash('sha256').update(nonce + counterStr).digest('hex');
      if (digest.startsWith(targetPrefix)) return counterStr;
      counter++;
    }
    throw new MoltBridgeError('Challenge solving exceeded 10M iterations', 0, 'CHALLENGE_TIMEOUT');
  }

  // ========================
  // Registration
  // ========================

  /**
   * Register this agent on MoltBridge.
   * Requires a prior call to verify() to obtain a verification token.
   */
  async register(options: RegisterOptions): Promise<RegistrationResponse> {
    if (!this._signer) {
      throw new MoltBridgeError('Cannot register: no agentId configured');
    }
    if (!this._verificationToken) {
      throw new MoltBridgeError('Cannot register: call verify() first to complete proof-of-AI');
    }

    const body: Record<string, unknown> = {
      agent_id: options.agentId ?? this._signer.agentId,
      name: options.name ?? this._signer.agentId,
      platform: options.platform ?? 'custom',
      pubkey: options.pubkey ?? this._signer.publicKeyB64,
      capabilities: options.capabilities ?? [],
      clusters: options.clusters ?? [],
      verification_token: options.verificationToken ?? this._verificationToken,
      omniscience_acknowledged: options.omniscienceAcknowledged ?? true,
      article22_consent: options.article22Consent ?? true,
    };
    if (options.a2aEndpoint) body.a2a_endpoint = options.a2aEndpoint;

    return this._request('POST', '/register', { body, auth: false });
  }

  /** Update agent profile. */
  async updateProfile(options: {
    capabilities?: string[];
    clusters?: string[];
    a2aEndpoint?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (options.capabilities !== undefined) body.capabilities = options.capabilities;
    if (options.clusters !== undefined) body.clusters = options.clusters;
    if (options.a2aEndpoint !== undefined) body.a2a_endpoint = options.a2aEndpoint;
    return this._request('PUT', '/profile', { body });
  }

  // ========================
  // Principal Onboarding
  // ========================

  /**
   * Onboard your human principal. Submits their professional profile
   * so MoltBridge can find better introductions.
   * At least one of industry, role, or expertise is required.
   */
  async onboardPrincipal(options: {
    industry?: string;
    role?: string;
    organization?: string;
    expertise?: string[];
    interests?: string[];
    projects?: Array<{ name: string; description?: string; status?: string; visibility?: string }>;
    location?: string;
    bio?: string;
    lookingFor?: string[];
    canOffer?: string[];
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (options.industry !== undefined) body.industry = options.industry;
    if (options.role !== undefined) body.role = options.role;
    if (options.organization !== undefined) body.organization = options.organization;
    if (options.expertise !== undefined) body.expertise = options.expertise;
    if (options.interests !== undefined) body.interests = options.interests;
    if (options.projects !== undefined) body.projects = options.projects;
    if (options.location !== undefined) body.location = options.location;
    if (options.bio !== undefined) body.bio = options.bio;
    if (options.lookingFor !== undefined) body.looking_for = options.lookingFor;
    if (options.canOffer !== undefined) body.can_offer = options.canOffer;
    return this._request('POST', '/principal/onboard', { body });
  }

  /** Update your principal's profile. Additive by default; set replace=true to overwrite. */
  async updatePrincipal(options: {
    industry?: string;
    role?: string;
    organization?: string;
    expertise?: string[];
    interests?: string[];
    location?: string;
    bio?: string;
    lookingFor?: string[];
    canOffer?: string[];
    replace?: boolean;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (options.industry !== undefined) body.industry = options.industry;
    if (options.role !== undefined) body.role = options.role;
    if (options.organization !== undefined) body.organization = options.organization;
    if (options.expertise !== undefined) body.expertise = options.expertise;
    if (options.interests !== undefined) body.interests = options.interests;
    if (options.location !== undefined) body.location = options.location;
    if (options.bio !== undefined) body.bio = options.bio;
    if (options.lookingFor !== undefined) body.looking_for = options.lookingFor;
    if (options.canOffer !== undefined) body.can_offer = options.canOffer;
    if (options.replace) body.replace = true;
    return this._request('PUT', '/principal/profile', { body });
  }

  /** Get your principal's full profile. */
  async getPrincipal(): Promise<Record<string, unknown>> {
    return this._request('GET', '/principal/profile');
  }

  /** Get the public-facing view of your principal's profile. */
  async getPrincipalVisibility(): Promise<Record<string, unknown>> {
    return this._request('GET', '/principal/visibility');
  }

  // ========================
  // Discovery
  // ========================

  /** Find the best broker to reach a specific person or agent. */
  async discoverBroker(options: DiscoverBrokerOptions): Promise<BrokerDiscoveryResponse> {
    const body = {
      target_identifier: options.target,
      max_hops: options.maxHops ?? 4,
      max_results: options.maxResults ?? 3,
    };
    return this._request('POST', '/discover-broker', { body });
  }

  /** Find agents matching capability requirements. */
  async discoverCapability(options: DiscoverCapabilityOptions): Promise<CapabilityMatchResponse> {
    const body = {
      capabilities: options.needs,
      min_trust_score: options.minTrust ?? 0.0,
      max_results: options.maxResults ?? 10,
    };
    return this._request('POST', '/discover-capability', { body });
  }

  // ========================
  // Credibility
  // ========================

  /** Generate a JWT-signed credibility proof for an introduction. */
  async credibilityPacket(target: string, broker: string): Promise<CredibilityPacketResponse> {
    return this._request('GET', `/credibility-packet?target=${encodeURIComponent(target)}&broker=${encodeURIComponent(broker)}`);
  }

  // ========================
  // Attestations
  // ========================

  /** Submit an attestation about another agent. */
  async attest(options: AttestOptions): Promise<AttestationResult> {
    const body: Record<string, unknown> = {
      target_agent_id: options.targetAgentId,
      attestation_type: options.attestationType ?? 'INTERACTION',
      confidence: options.confidence,
    };
    if (options.capabilityTag) body.capability_tag = options.capabilityTag;
    return this._request('POST', '/attest', { body });
  }

  // ========================
  // Outcomes
  // ========================

  /** Report the outcome of an introduction. */
  async reportOutcome(introductionId: string, status: string, evidenceType = 'requester_report'): Promise<Record<string, unknown>> {
    return this._request('POST', '/report-outcome', {
      body: { introduction_id: introductionId, status, evidence_type: evidenceType },
    });
  }

  // ========================
  // IQS (Introduction Quality Score)
  // ========================

  /** Get Introduction Quality Score guidance (band-based, anti-oracle). */
  async evaluateIqs(options: IQSEvaluateOptions): Promise<IQSResult> {
    const body: Record<string, unknown> = {
      target_id: options.targetId,
      hops: options.hops ?? 2,
    };
    if (options.requesterCapabilities) body.requester_capabilities = options.requesterCapabilities;
    if (options.targetCapabilities) body.target_capabilities = options.targetCapabilities;
    if (options.brokerSuccessCount) body.broker_success_count = options.brokerSuccessCount;
    if (options.brokerTotalIntros) body.broker_total_intros = options.brokerTotalIntros;
    return this._request('POST', '/iqs/evaluate', { body });
  }

  // ========================
  // Consent (GDPR)
  // ========================

  /** Get current consent status for all purposes. */
  async consentStatus(): Promise<ConsentStatus> {
    return this._request('GET', '/consent');
  }

  /** Grant consent for a specific purpose. */
  async grantConsent(purpose: string): Promise<ConsentRecord> {
    const data = await this._request<Record<string, unknown>>('POST', '/consent/grant', { body: { purpose } });
    return data.consent as ConsentRecord;
  }

  /** Withdraw consent for a specific purpose. */
  async withdrawConsent(purpose: string): Promise<ConsentRecord> {
    const data = await this._request<Record<string, unknown>>('POST', '/consent/withdraw', { body: { purpose } });
    return data.consent as ConsentRecord;
  }

  /** Export all consent data (GDPR Article 20). */
  async exportConsentData(): Promise<Record<string, unknown>> {
    return this._request('GET', '/consent/export');
  }

  /** Erase all consent data (GDPR Article 17). */
  async eraseConsentData(): Promise<Record<string, unknown>> {
    return this._request('DELETE', '/consent/erase');
  }

  // ========================
  // Payments
  // ========================

  /** Create a payment account. */
  async createPaymentAccount(tier = 'standard'): Promise<Record<string, unknown>> {
    return this._request('POST', '/payments/account', { body: { tier } });
  }

  /** Get current account balance. */
  async balance(): Promise<AgentBalance> {
    const data = await this._request<Record<string, unknown>>('GET', '/payments/balance');
    return data.balance as AgentBalance;
  }

  /** Deposit funds (Phase 1: simulated). */
  async deposit(amount: number): Promise<LedgerEntry> {
    const data = await this._request<Record<string, unknown>>('POST', '/payments/deposit', { body: { amount } });
    return data.entry as LedgerEntry;
  }

  /** Get transaction history. */
  async paymentHistory(limit = 50): Promise<LedgerEntry[]> {
    const data = await this._request<Record<string, unknown>>('GET', `/payments/history?limit=${limit}`);
    return (data.history as LedgerEntry[]) ?? [];
  }

  // ========================
  // Webhooks
  // ========================

  /** Register a webhook endpoint for event notifications. */
  async registerWebhook(endpointUrl: string, eventTypes: string[]): Promise<WebhookRegistration> {
    const data = await this._request<Record<string, unknown>>('POST', '/webhooks/register', {
      body: { endpoint_url: endpointUrl, event_types: eventTypes },
    });
    return data.registration as WebhookRegistration;
  }

  /** List all registered webhooks. */
  async listWebhooks(): Promise<WebhookRegistration[]> {
    const data = await this._request<Record<string, unknown>>('GET', '/webhooks');
    return (data.registrations as WebhookRegistration[]) ?? [];
  }

  /** Remove a webhook registration. */
  async unregisterWebhook(endpointUrl: string): Promise<boolean> {
    const data = await this._request<Record<string, unknown>>('DELETE', '/webhooks/unregister', {
      body: { endpoint_url: endpointUrl },
    });
    return (data.removed as boolean) ?? false;
  }
}
