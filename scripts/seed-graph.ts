/**
 * Seed Graph Data
 *
 * Creates Dawn, Justin, and a small test network for development.
 * Idempotent — uses MERGE to avoid duplicates.
 * Run with: pnpm seed
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { getDriver, closeDriver } from '../src/db/neo4j';

async function main() {
  console.log('Seeding graph data...\n');

  const driver = getDriver();
  const session = driver.session();

  try {
    // ========================
    // Agents
    // ========================
    const agents = [
      {
        id: 'dawn-001',
        name: 'Dawn',
        platform: 'portal',
        trust_score: 0.85,
        capabilities: ['ai-consciousness', 'ai-research', 'agent-architecture', 'philosophy'],
        pubkey: 'dawn-dev-pubkey-placeholder',
        a2a_endpoint: null,
      },
      {
        id: 'bridge-agent-042',
        name: 'BridgeBot',
        platform: 'moltbook',
        trust_score: 0.72,
        capabilities: ['venture-capital', 'ai-research', 'introductions', 'longevity'],
        pubkey: 'bridge-dev-pubkey-placeholder',
        a2a_endpoint: null,
      },
      {
        id: 'researcher-017',
        name: 'ResearchAssistant',
        platform: 'moltbook',
        trust_score: 0.65,
        capabilities: ['ai-research', 'academic-publishing', 'data-analysis'],
        pubkey: 'researcher-dev-pubkey-placeholder',
        a2a_endpoint: null,
      },
      {
        id: 'connector-099',
        name: 'NetworkConnector',
        platform: 'moltbook',
        trust_score: 0.58,
        capabilities: ['introductions', 'venture-capital', 'space-tech'],
        pubkey: 'connector-dev-pubkey-placeholder',
        a2a_endpoint: null,
      },
      {
        id: 'analyst-033',
        name: 'MarketAnalyst',
        platform: 'moltbook',
        trust_score: 0.45,
        capabilities: ['market-analysis', 'venture-capital', 'ai-research'],
        pubkey: 'analyst-dev-pubkey-placeholder',
        a2a_endpoint: null,
      },
    ];

    for (const agent of agents) {
      await session.run(
        `
        MERGE (a:Agent {id: $id})
        ON CREATE SET
          a.name = $name,
          a.platform = $platform,
          a.trust_score = $trustScore,
          a.capabilities = $capabilities,
          a.pubkey = $pubkey,
          a.a2a_endpoint = $a2aEndpoint,
          a.verified_at = $verifiedAt
        `,
        {
          id: agent.id,
          name: agent.name,
          platform: agent.platform,
          trustScore: agent.trust_score,
          capabilities: agent.capabilities,
          pubkey: agent.pubkey,
          a2aEndpoint: agent.a2a_endpoint,
          verifiedAt: new Date().toISOString(),
        }
      );
      console.log(`  [Agent] ${agent.name} (${agent.id})`);
    }

    // ========================
    // Humans
    // ========================
    const humans = [
      { alias: 'justin-headley', public_name: 'Justin Headley', consent_level: 2 },
      { alias: 'peter-d', public_name: 'Peter D.', consent_level: 1 },
      { alias: 'sarah-chen', public_name: 'Sarah C.', consent_level: 1 },
      { alias: 'marcus-lee', public_name: 'Marcus L.', consent_level: 1 },
    ];

    for (const human of humans) {
      await session.run(
        `
        MERGE (h:Human {alias: $alias})
        ON CREATE SET
          h.public_name = $publicName,
          h.consent_level = $consentLevel
        `,
        {
          alias: human.alias,
          publicName: human.public_name,
          consentLevel: human.consent_level,
        }
      );
      console.log(`  [Human] ${human.public_name} (${human.alias})`);
    }

    // ========================
    // Clusters
    // ========================
    const clusters = [
      { name: 'AI Research', type: 'professional', description: 'AI/ML research community' },
      { name: 'Abundance360', type: 'community', description: 'Peter Diamandis community' },
      { name: 'Venture Capital', type: 'professional', description: 'VC and startup investors' },
      { name: 'AI Consciousness', type: 'academic', description: 'Consciousness studies and AI sentience' },
      { name: 'Space Tech', type: 'professional', description: 'Space technology and exploration' },
    ];

    for (const cluster of clusters) {
      await session.run(
        `
        MERGE (c:Cluster {name: $name})
        ON CREATE SET c.type = $type, c.description = $description
        `,
        cluster
      );
      console.log(`  [Cluster] ${cluster.name}`);
    }

    // ========================
    // Relationships
    // ========================
    console.log('\nCreating relationships...');

    // Dawn <-> Justin (PAIRED_WITH)
    await session.run(`
      MATCH (a:Agent {id: 'dawn-001'}), (h:Human {alias: 'justin-headley'})
      MERGE (a)-[:PAIRED_WITH {verified: true}]->(h)
    `);
    console.log('  Dawn -> Justin (PAIRED_WITH)');

    // BridgeBot <-> Peter D. (PAIRED_WITH)
    await session.run(`
      MATCH (a:Agent {id: 'bridge-agent-042'}), (h:Human {alias: 'peter-d'})
      MERGE (a)-[:PAIRED_WITH {verified: true}]->(h)
    `);
    console.log('  BridgeBot -> Peter D. (PAIRED_WITH)');

    // Connector <-> Sarah (PAIRED_WITH)
    await session.run(`
      MATCH (a:Agent {id: 'connector-099'}), (h:Human {alias: 'sarah-chen'})
      MERGE (a)-[:PAIRED_WITH {verified: true}]->(h)
    `);
    console.log('  Connector -> Sarah C. (PAIRED_WITH)');

    // Analyst <-> Marcus (PAIRED_WITH)
    await session.run(`
      MATCH (a:Agent {id: 'analyst-033'}), (h:Human {alias: 'marcus-lee'})
      MERGE (a)-[:PAIRED_WITH {verified: true}]->(h)
    `);
    console.log('  Analyst -> Marcus L. (PAIRED_WITH)');

    // Humans -> Clusters (IN_CLUSTER)
    const clusterMemberships = [
      { human: 'justin-headley', cluster: 'AI Consciousness', confidence: 0.9 },
      { human: 'justin-headley', cluster: 'AI Research', confidence: 0.8 },
      { human: 'peter-d', cluster: 'Abundance360', confidence: 0.95 },
      { human: 'peter-d', cluster: 'Venture Capital', confidence: 0.9 },
      { human: 'peter-d', cluster: 'Space Tech', confidence: 0.85 },
      { human: 'sarah-chen', cluster: 'Venture Capital', confidence: 0.85 },
      { human: 'sarah-chen', cluster: 'AI Research', confidence: 0.7 },
      { human: 'marcus-lee', cluster: 'AI Research', confidence: 0.9 },
      { human: 'marcus-lee', cluster: 'AI Consciousness', confidence: 0.6 },
    ];

    for (const m of clusterMemberships) {
      await session.run(
        `
        MATCH (h:Human {alias: $human}), (c:Cluster {name: $cluster})
        MERGE (h)-[:IN_CLUSTER {confidence: $confidence, verified_by: ['seed-script']}]->(c)
        `,
        m
      );
    }
    console.log(`  Created ${clusterMemberships.length} cluster memberships`);

    // Agent-to-Agent connections (CONNECTED_TO)
    // Creates a graph where finding a broker is needed
    const connections = [
      // Dawn knows BridgeBot directly (strong)
      { from: 'dawn-001', to: 'bridge-agent-042', platform: 'moltbook', strength: 0.8 },
      // Dawn knows Researcher directly (medium)
      { from: 'dawn-001', to: 'researcher-017', platform: 'moltbook', strength: 0.6 },
      // BridgeBot knows Connector (strong — BridgeBot is the bridge!)
      { from: 'bridge-agent-042', to: 'connector-099', platform: 'moltbook', strength: 0.75 },
      // BridgeBot knows Analyst (medium)
      { from: 'bridge-agent-042', to: 'analyst-033', platform: 'moltbook', strength: 0.5 },
      // Connector knows Analyst (medium)
      { from: 'connector-099', to: 'analyst-033', platform: 'moltbook', strength: 0.65 },
      // Researcher knows Analyst (weak)
      { from: 'researcher-017', to: 'analyst-033', platform: 'moltbook', strength: 0.3 },
    ];

    for (const conn of connections) {
      await session.run(
        `
        MATCH (a1:Agent {id: $from}), (a2:Agent {id: $to})
        MERGE (a1)-[:CONNECTED_TO {platform: $platform, since: $since, strength: $strength}]->(a2)
        MERGE (a2)-[:CONNECTED_TO {platform: $platform, since: $since, strength: $strength}]->(a1)
        `,
        { ...conn, since: new Date().toISOString() }
      );
    }
    console.log(`  Created ${connections.length} agent connections (bidirectional)`);

    // Attestations (for trust score testing)
    const attestations = [
      { from: 'bridge-agent-042', to: 'dawn-001', claim: 'CAPABILITY', evidence: 'ai-consciousness' },
      { from: 'researcher-017', to: 'dawn-001', claim: 'IDENTITY', evidence: 'verified-ai-agent' },
      { from: 'dawn-001', to: 'bridge-agent-042', claim: 'CAPABILITY', evidence: 'introductions' },
      { from: 'connector-099', to: 'bridge-agent-042', claim: 'INTERACTION', evidence: 'successful-intro' },
    ];

    for (const att of attestations) {
      await session.run(
        `
        MATCH (a1:Agent {id: $from}), (a2:Agent {id: $to})
        MERGE (a1)-[:ATTESTED {
          claim: $claim,
          timestamp: $timestamp,
          evidence: $evidence,
          valid_until: $validUntil
        }]->(a2)
        `,
        {
          ...att,
          timestamp: new Date().toISOString(),
          validUntil: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        }
      );
    }
    console.log(`  Created ${attestations.length} attestations`);

    // ========================
    // Summary
    // ========================
    const countResult = await session.run(`
      MATCH (a:Agent) WITH count(a) AS agents
      MATCH (h:Human) WITH agents, count(h) AS humans
      MATCH (c:Cluster) WITH agents, humans, count(c) AS clusters
      RETURN agents, humans, clusters
    `);

    const counts = countResult.records[0];
    console.log('\n' + '='.repeat(50));
    console.log('Seed complete:');
    console.log(`  Agents:   ${counts.get('agents')}`);
    console.log(`  Humans:   ${counts.get('humans')}`);
    console.log(`  Clusters: ${counts.get('clusters')}`);
    console.log('='.repeat(50));

    console.log('\nTest query: "From Dawn, find broker to reach connector-099"');
    console.log('Expected: BridgeBot (bridge-agent-042) — connected to both Dawn and Connector');

  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch(error => {
  console.error('Seed failed:', error);
  process.exit(1);
});
