/**
 * MoltBridge — Shared TypeScript Interfaces
 */

// ========================
// Node Types
// ========================

export interface AgentNode {
  id: string;           // human-readable agent_id (e.g. "dawn-001")
  name: string;
  platform: string;
  trust_score: number;  // [0.0, 1.0]
  capabilities: string[];
  verified_at: string | null;
  pubkey: string;       // Ed25519 public key, Base64url-encoded
  a2a_endpoint?: string;
}

export interface HumanNode {
  alias: string;        // unique alias
  consent_level: number;
  public_name?: string;
}

export interface ClusterNode {
  name: string;
  type: string;
  description: string;
}

export interface OrganizationNode {
  name: string;
  type: string;
  domain: string;
}

// ========================
// Relationship Types
// ========================

export interface PairedWithEdge {
  verified: boolean;
}

export interface ConnectedToEdge {
  platform: string;
  since: string;
  strength: number;   // [0.0, 1.0]
}

export interface InClusterEdge {
  confidence: number;
  verified_by: string[];
}

export interface AffiliatedEdge {
  role: string;
  since: string;
  verified_by: string[];
}

export interface AttestedEdge {
  claim: string;
  timestamp: string;
  evidence: string;
  valid_until: string;
}

// ========================
// API Types
// ========================

export type AttestationType = 'CAPABILITY' | 'IDENTITY' | 'INTERACTION';

export interface Attestation {
  source_agent_id: string;
  target_agent_id: string;
  attestation_type: AttestationType;
  capability_tag?: string;
  evidence_url?: string;
  evidence_hash?: string;
  confidence: number;    // [0.0, 1.0]
  timestamp: string;
  signature: string;
}

export interface BrokerDiscoveryRequest {
  source_agent_id: string;
  target_identifier: string;    // agent_id or human alias
  max_hops?: number;            // default 4
  max_results?: number;         // default 3
}

export interface BrokerResult {
  broker_agent_id: string;
  broker_name: string;
  broker_trust_score: number;
  path_hops: number;
  via_clusters: string[];
  composite_score: number;      // centrality * connection strengths
}

export interface BrokerDiscoveryResponse {
  results: BrokerResult[];
  query_time_ms: number;
  path_found: boolean;
  message?: string;
}

export interface CapabilityMatchRequest {
  capabilities: string[];
  min_trust_score?: number;     // default 0.0
  max_results?: number;         // default 10
}

export interface CapabilityMatchResult {
  agent_id: string;
  agent_name: string;
  trust_score: number;
  matched_capabilities: string[];
  match_score: number;
}

export interface CapabilityMatchResponse {
  results: CapabilityMatchResult[];
  query_time_ms: number;
}

export interface CredibilityPacketPayload {
  iss: string;                  // "moltbridge"
  sub: string;                  // "credibility-packet"
  jti: string;                  // UUID
  iat: number;
  exp: number;
  aud: string;                  // target agent_id
  requester: {
    agent_id: string;
    trust_score: number;
  };
  broker: {
    agent_id: string;
    betweenness_rank: number;
  };
  path_summary: {
    hops: number;
    via_clusters: string[];
    proximity_score: number;
  };
  relevance: {
    shared_interests: string[];
    complementary_expertise: string[];
  };
  attestation_count: number;
}

export interface RegistrationRequest {
  agent_id: string;
  name: string;
  platform: string;
  pubkey: string;               // Ed25519 public key, Base64url-encoded
  capabilities: string[];
  clusters: string[];
  a2a_endpoint?: string;
  verification_token: string;   // JWT from /verify
  omniscience_acknowledged?: boolean; // Required: explicit ack of operational omniscience
  article22_consent?: boolean;        // Required: consent to IQS automated decision-making
}

export interface ProfileUpdateRequest {
  capabilities?: string[];
  clusters?: string[];
  a2a_endpoint?: string;
}

export interface VerifyChallengeResponse {
  challenge_id: string;
  nonce: string;
  difficulty: number;           // SHA256 leading zeros required
  timestamp: string;
}

export interface VerifySolutionRequest {
  challenge_id: string;
  proof_of_work: string;        // SHA256 solution
  reasoning_answer?: string;    // answer to reasoning challenge
}

export interface OutcomeReport {
  introduction_id: string;
  status: 'attempted' | 'acknowledged' | 'successful' | 'failed' | 'disputed';
  evidence_type: 'target_confirmation' | 'requester_report' | 'timeout';
  signature: string;
}

// ========================
// Trust Score Types
// ========================

export interface TrustComponents {
  import_score: number;         // [0.0, 1.0]
  attestation_score: number;    // [0.0, 1.0]
  cross_verification_score: number; // [0.0, 1.0]
}

// Phase 1 formula: score = 0.17*import + 0.25*attestation + 0.58*cross_verification
export const TRUST_WEIGHTS = {
  import: 0.17,
  attestation: 0.25,
  cross_verification: 0.58,
} as const;

// ========================
// Error Types
// ========================

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

export interface ApiErrorResponse {
  error: ApiError;
}

// ========================
// Auth Types
// ========================

export interface AuthenticatedRequest {
  agent_id: string;
  timestamp: number;
}

// ========================
// Principal Profile Types
// ========================

export type EnrichmentLevel = 'none' | 'basic' | 'detailed' | 'verified';
export type ExpertiseSource = 'agent-declared' | 'peer-attested' | 'outcome-proven';
export type ProjectStatus = 'active' | 'completed' | 'planned';
export type VisibilityLevel = 'public' | 'connections' | 'private';

export interface ExpertiseEntry {
  tag: string;
  verified: boolean;
  source: ExpertiseSource;
  attestation_count: number;
}

export interface ProjectEntry {
  name: string;
  description?: string;
  status: ProjectStatus;
  visibility: VisibilityLevel;
}

export interface PrincipalProfile {
  agent_id: string;
  industry?: string;
  role?: string;
  organization?: string;
  expertise: ExpertiseEntry[];
  interests: string[];
  projects: ProjectEntry[];
  location?: string;
  bio?: string;
  looking_for: string[];
  can_offer: string[];
  enrichment_level: EnrichmentLevel;
  onboarded_at: string;
  last_updated: string;
}

export interface PrincipalOnboardRequest {
  industry?: string;
  role?: string;
  organization?: string;
  expertise?: string[];
  interests?: string[];
  projects?: ProjectEntry[];
  location?: string;
  bio?: string;
  looking_for?: string[];
  can_offer?: string[];
}

export interface ProfileEnrichmentRequest {
  industry?: string;
  role?: string;
  organization?: string;
  expertise?: string[];
  interests?: string[];
  projects?: ProjectEntry[];
  location?: string;
  bio?: string;
  looking_for?: string[];
  can_offer?: string[];
  replace?: boolean;
}
