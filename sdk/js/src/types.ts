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
