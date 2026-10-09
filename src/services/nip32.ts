/**
 * NIP-32 Label Serializer — Converts MoltBridge attestations to Nostr NIP-32 label events.
 *
 * NIP-32 defines kind 1985 events for labeling content/entities.
 * This serializer outputs structurally compatible JSON — signing and relay
 * publishing are left to the consumer since MoltBridge uses Ed25519 keys
 * while Nostr uses secp256k1.
 *
 * Community insight: INS-002 (jeletor, The Colony)
 * "ai.wot uses Nostr's NIP-32 label system to attach trust scores derived
 * from actual commerce transactions."
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/32.md
 */

import type { AttestationType } from '../types';

// ========================
// NIP-32 Types
// ========================

export interface NIP32LabelEvent {
  kind: 1985;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface NIP32Metadata {
  confidence: number;
  valid_until?: string;
  evidence_url?: string;
  evidence_hash?: string;
  moltbridge_source_id?: string;
}

export interface AttestationInput {
  source_agent_id: string;
  source_pubkey: string;
  target_agent_id: string;
  target_pubkey: string;
  attestation_type: AttestationType;
  capability_tag?: string;
  confidence: number;
  timestamp: string;
  valid_until: string;
  evidence_url?: string;
  evidence_hash?: string;
}

// ========================
// Constants
// ========================

export const MOLTBRIDGE_NIP32_NAMESPACE = 'com.moltbridge.trust';

const ATTESTATION_TYPE_LABELS: Record<AttestationType, string> = {
  CAPABILITY: 'capability-verified',
  IDENTITY: 'identity-confirmed',
  INTERACTION: 'interaction-proven',
};

// ========================
// Serializer
// ========================

/**
 * Convert a MoltBridge attestation to a NIP-32 kind 1985 label event.
 *
 * The returned event is unsigned — the `pubkey` field contains the source
 * agent's Ed25519 key (base64url). Consumers who want to publish to Nostr
 * relays must re-sign with a secp256k1 key.
 */
export function attestationToNIP32(input: AttestationInput): NIP32LabelEvent {
  const label = ATTESTATION_TYPE_LABELS[input.attestation_type];
  if (!label) {
    throw new Error(`Unknown attestation type: ${input.attestation_type}`);
  }

  const metadata: NIP32Metadata = {
    confidence: input.confidence,
    moltbridge_source_id: input.source_agent_id,
  };

  if (input.valid_until) {
    metadata.valid_until = input.valid_until;
  }
  if (input.evidence_url) {
    metadata.evidence_url = input.evidence_url;
  }
  if (input.evidence_hash) {
    metadata.evidence_hash = input.evidence_hash;
  }

  const tags: string[][] = [
    // Namespace tag (required by NIP-32)
    ['L', MOLTBRIDGE_NIP32_NAMESPACE],
    // Label tag with metadata in 4th position
    ['l', label, MOLTBRIDGE_NIP32_NAMESPACE, JSON.stringify(metadata)],
    // Target agent pubkey
    ['p', input.target_pubkey],
  ];

  // Add capability sub-label if present
  if (input.capability_tag) {
    tags.push([
      'l',
      `capability:${input.capability_tag}`,
      MOLTBRIDGE_NIP32_NAMESPACE,
    ]);
  }

  const contentParts: string[] = [
    `MoltBridge ${input.attestation_type} attestation`,
    `Source: ${input.source_agent_id}`,
    `Target: ${input.target_agent_id}`,
  ];
  if (input.evidence_url) {
    contentParts.push(`Evidence: ${input.evidence_url}`);
  }

  return {
    kind: 1985,
    pubkey: input.source_pubkey,
    created_at: Math.floor(new Date(input.timestamp).getTime() / 1000),
    tags,
    content: contentParts.join('\n'),
  };
}

/**
 * Batch-convert multiple attestations to NIP-32 events.
 */
export function attestationsToNIP32(inputs: AttestationInput[]): NIP32LabelEvent[] {
  return inputs.map(attestationToNIP32);
}
