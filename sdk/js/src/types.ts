/**
 * MoltBridge SDK — TypeScript Types
 */

// ========================
// Configuration
// ========================

export interface MoltBridgeConfig {
  /** Agent ID for authenticated requests */
  agentId?: string;
  /** Ed25519 signing key seed (hex-encoded) */
  signingKey?: string;
  /** Base URL of MoltBridge API (default: https://api.moltbridge.ai) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
}

// ========================
// API Response Types
// ========================

export interface HealthResponse {
  name: string;
  version: string;
  status: 'healthy' | 'degraded';
  uptime: number;
  neo4j: { connected: boolean };
}

export interface VerificationChallenge {
  challenge_id: string;
  nonce: string;
  difficulty: number;
  timestamp: string;
}

export interface VerificationResult {
  verified: boolean;
  token: string;
}

export interface AgentNode {
  id: string;
  name: string;
  platform: string;
  trust_score: number;
  capabilities: string[];
  verified_at: string | null;
  pubkey: string;
  a2a_endpoint?: string;
}

export interface RegistrationResponse {
  agent: AgentNode;
  consents_granted: string[];
  disclosures_acknowledged: {
    omniscience: string;
    article22: boolean;
  };
}

export interface BrokerResult {
  broker_agent_id: string;
  broker_name: string;
  broker_trust_score: number;
  path_hops: number;
  via_clusters: string[];
  composite_score: number;
}

export interface BrokerDiscoveryResponse {
  results: BrokerResult[];
  query_time_ms: number;
  path_found: boolean;
  message?: string;
  discovery_hint?: string;
  error?: { code: string; message: string; status: number };
}

export interface CapabilityMatch {
  agent_id: string;
  agent_name: string;
  trust_score: number;
  matched_capabilities: string[];
  match_score: number;
}

export interface CapabilityMatchResponse {
  results: CapabilityMatch[];
  query_time_ms: number;
  discovery_hint?: string;
}

export interface CredibilityPacketResponse {
  packet: string;       // JWT
  expires_in: number;
  verify_url: string;
}

export interface AttestationResult {
  attestation: {
    source: string;
    target: string;
    type: string;
    confidence: number;
    created_at: string;
    valid_until: string;
  };
  target_trust_score: number;
}

export interface IQSResult {
  band: 'low' | 'medium' | 'high';
  recommendation: string;
  threshold_used: number;
  is_probationary: boolean;
  components_received: boolean;
}

export interface ConsentStatus {
  agent_id: string;
  consents: Record<string, boolean>;
  last_updated: string | null;
  descriptions: Record<string, string>;
}

export interface ConsentRecord {
  agent_id: string;
  purpose: string;
  granted: boolean;
  version: number;
  granted_at: string | null;
  withdrawn_at: string | null;
}

export interface AgentBalance {
  agent_id: string;
  balance: number;
  broker_tier: string;
}

export interface LedgerEntry {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  description: string;
  timestamp: string;
}

export interface WebhookRegistration {
  agent_id: string;
  endpoint_url: string;
  event_types: string[];
  active: boolean;
  last_delivery_at?: string;
  failure_count: number;
}

export interface PricingInfo {
  broker_discovery: number;
  capability_match: number;
  credibility_packet: number;
  introduction_fee: number;
  currency: string;
}

// ========================
// Request Types
// ========================

export interface RegisterOptions {
  agentId: string;
  name: string;
  platform: string;
  pubkey: string;
  capabilities?: string[];
  clusters?: string[];
  a2aEndpoint?: string;
  verificationToken: string;
  omniscienceAcknowledged?: boolean;
  article22Consent?: boolean;
}

export interface DiscoverBrokerOptions {
  target: string;
  maxHops?: number;
  maxResults?: number;
}

export interface DiscoverCapabilityOptions {
  needs: string[];
  minTrust?: number;
  maxResults?: number;
}

export interface AttestOptions {
  targetAgentId: string;
  attestationType: 'CAPABILITY' | 'IDENTITY' | 'INTERACTION';
  capabilityTag?: string;
  confidence: number;
}

export interface IQSEvaluateOptions {
  targetId: string;
  requesterCapabilities?: string[];
  targetCapabilities?: string[];
  brokerSuccessCount?: number;
  brokerTotalIntros?: number;
  hops?: number;
}

export type WebhookEventType =
  | 'introduction_request'
  | 'attestation_received'
  | 'trust_score_changed'
  | 'outcome_reported'
  | 'iqs_guidance';

// ========================
// Feedback Types (Spec 21)
// ========================

export type FeedbackType = 'bug' | 'feature_request' | 'api_issue' | 'data_quality' | 'security' | 'praise';
export type FeedbackStatus = 'open' | 'acknowledged' | 'investigating' | 'fixed' | 'wontfix' | 'duplicate';
export type FeedbackPriority = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export interface FeedbackTicketSummary {
  ticket_id: string;
  type: FeedbackType;
  title: string;
  status: FeedbackStatus;
  priority: FeedbackPriority;
  created_at: string;
  updated_at: string;
  resolution?: {
    fixed_in_version?: string;
    root_cause?: string;
    resolved_at: string;
  } | null;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  context?: Record<string, unknown>;
  reproducible?: boolean;
  steps_to_reproduce?: string[];
  vote_count: number;
  comments: FeedbackCommentResponse[];
}

export interface FeedbackCommentResponse {
  comment_id: string;
  agent_id: string;
  ticket_id: string;
  comment: string;
  created_at: string;
}

export interface FeedbackSubmitResponse {
  ticket_id: string;
  status: FeedbackStatus;
  priority: FeedbackPriority;
  type: FeedbackType;
  acknowledged: boolean;
  created_at: string;
  similar_tickets?: string[];
  message: string;
}

export interface FeatureRequestResponse {
  ticket_id: string;
  status: FeedbackStatus;
  type: 'feature_request';
  vote_count: number;
  similar_requests?: string[];
  message: string;
}

export interface FeedbackVoteResponse {
  ticket_id: string;
  vote_count: number;
  your_vote: boolean;
}

export interface FeedbackQuality {
  total_submissions: number;
  confirmed_bugs: number;
  useful_features: number;
  spam_reports: number;
  quality_score: number;
  trust_adjustment: number;
}

export interface ReportBugOptions {
  title: string;
  description: string;
  endpoint?: string;
  expected?: string;
  actual?: string;
  reproducible?: boolean;
  stepsToReproduce?: string[];
  sdkVersion?: string;
  sdkLanguage?: string;
  priority?: FeedbackPriority;
}

export interface RequestFeatureOptions {
  title: string;
  description: string;
  useCase?: string;
  proposedApi?: string;
  impact?: string;
}

// ========================
// Pre-Escrow Trust Gate (PROP-881)
// ========================

/** Thresholds the pre-escrow gate applies. Every field is optional. */
export interface PreEscrowPolicy {
  /** Minimum Wilson 95% lower bound on the counterparty's success ratio. Default 0.35. */
  min_success_lower_bound?: number;
  /** Maximum share of resolved introductions that ended disputed. Default 0.34. */
  max_dispute_rate?: number;
  /** Resolved introductions needed before a behavioural verdict is possible. Default 3. */
  min_resolved_outcomes?: number;
  /** Optional attestation-score floor. Default null (not applied). */
  min_declared_trust?: number | null;
  /** Hold a counterparty with no behavioural record instead of allowing it. Default false. */
  require_evidence?: boolean;
  /** Distinct blocking coordination flags that escalate review to deny. Default 2. */
  deny_on_collusion_patterns?: number;
  /** Share of outcomes a rate-based flag must appear on before it blocks. Default 0.5. */
  collusion_rate_threshold?: number;
}

export interface TrustOverride {
  /** The counterparty this override covers. An override for another agent does not unblock this one. */
  counterparty_agent_id: string;
  /** Why the risk is accepted. At least 8 characters, or the request is refused. */
  reason: string;
  approved_by?: string;
}

export type GateDecision = 'allow' | 'review' | 'deny';

/** What the decision rests on. Never inferred from the decision itself. */
export type EvidenceBasis = 'behavioral' | 'declared_only' | 'none';

export interface GateReason {
  code: string;
  detail: string;
  blocking: boolean;
}

export interface BehavioralRecord {
  total: number;
  /** successful + failed + disputed */
  resolved: number;
  successful: number;
  failed: number;
  disputed: number;
  pending: number;
  /** Raw ratio. Display only — policy does not read this. */
  success_rate_observed: number;
  /** Wilson 95% lower bound. This is what policy reads. */
  success_lower_bound: number;
  dispute_rate: number;
  outcomes_inspected: number;
  flag_counts: Record<string, number>;
  strong_flags: string[];
  advisory_flags: string[];
}

export interface PreEscrowAssessment {
  /** Keeps its blocking value even when an override let the handoff through. */
  decision: GateDecision;
  /** Whether to proceed. Read this, not `decision`, when an override may apply. */
  allowed: boolean;
  overridden: boolean;
  override: TrustOverride | null;
  evidence_basis: EvidenceBasis;
  /** Always non-empty. */
  reasons: GateReason[];
  behavioral: BehavioralRecord | null;
  /** null means the score could not be resolved — not zero trust. */
  declared_trust_score: number | null;
  policy: Required<PreEscrowPolicy>;
  requester_agent_id: string;
  counterparty_agent_id: string;
  counterparty_role: 'target' | 'broker' | 'requester';
  introduction_id: string | null;
  evaluated_at: string;
}

export interface PreEscrowVerifyResponse {
  assessment: PreEscrowAssessment;
  enforcing: boolean;
  note: string;
}

export interface PreEscrowPolicyResponse {
  default_policy: Required<PreEscrowPolicy>;
  active_policy: Required<PreEscrowPolicy>;
  /** False means the gate evaluates and logs but does not refuse. */
  enforcing: boolean;
  overridable_per_request: string[];
}

export interface PreEscrowVerifyOptions {
  counterpartyAgentId: string;
  counterpartyRole?: 'target' | 'broker' | 'requester';
  introductionId?: string;
  policy?: PreEscrowPolicy;
  override?: TrustOverride | TrustOverride[];
}

export interface CreateIntroductionOptions {
  introductionId: string;
  requesterId: string;
  brokerId: string;
  targetId: string;
  /** Tighten the gate for this handoff only. */
  policy?: PreEscrowPolicy;
  /** Proceed despite a blocking decision. The decision is not rewritten. */
  override?: TrustOverride | TrustOverride[];
}

export interface GateResult {
  decision: GateDecision;
  allowed: boolean;
  assessments: PreEscrowAssessment[];
}

export interface CreateIntroductionResponse {
  outcome: Record<string, unknown>;
  /** The gate's verdict, present even when it was an allow on no evidence. */
  gate: GateResult;
}
