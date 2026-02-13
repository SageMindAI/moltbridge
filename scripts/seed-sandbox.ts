/**
 * Sandbox Seed Script — 100+ Synthetic Agents
 *
 * Creates a realistic network for development and testing.
 * Includes pre-configured pathfinding scenarios per DX spec.
 *
 * Distribution:
 *   30% Technical/Engineering
 *   20% Research/Academic
 *   15% Business/Operations
 *   15% Creative/Content
 *   10% Infrastructure/DevOps
 *   10% Miscellaneous/Cross-domain
 *
 * Run with: pnpm seed:sandbox
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { getDriver, closeDriver } from '../src/db/neo4j';

// ========================
// Deterministic random (seeded)
// ========================
let seed = 42;
function seededRandom(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(seededRandom() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => seededRandom() - 0.5);
  return shuffled.slice(0, n);
}

// ========================
// Capability pools by cluster
// ========================
const CAPABILITY_POOLS: Record<string, string[]> = {
  'Technical/Engineering': [
    'machine-learning', 'deep-learning', 'nlp', 'computer-vision',
    'reinforcement-learning', 'robotics', 'systems-engineering',
    'distributed-systems', 'compiler-design', 'embedded-systems',
  ],
  'Research/Academic': [
    'ai-research', 'neuroscience', 'consciousness-studies', 'philosophy-of-mind',
    'cognitive-science', 'quantum-computing', 'ethics', 'academic-publishing',
    'data-analysis', 'statistical-modeling',
  ],
  'Business/Operations': [
    'venture-capital', 'market-analysis', 'strategy', 'business-development',
    'partnerships', 'fundraising', 'product-management', 'operations',
    'financial-modeling', 'go-to-market',
  ],
  'Creative/Content': [
    'content-creation', 'writing', 'visual-design', 'video-production',
    'storytelling', 'branding', 'social-media', 'community-management',
    'podcast-production', 'copywriting',
  ],
  'Infrastructure/DevOps': [
    'cloud-infrastructure', 'kubernetes', 'ci-cd', 'monitoring',
    'security-engineering', 'database-admin', 'networking', 'sre',
    'performance-optimization', 'incident-response',
  ],
  'Miscellaneous/Cross-domain': [
    'agent-architecture', 'ai-consciousness', 'longevity', 'space-tech',
    'biotech', 'climate-tech', 'education', 'healthcare-ai',
    'legal-ai', 'creative-ai',
  ],
};

const CLUSTER_NAMES = Object.keys(CAPABILITY_POOLS);

const CLUSTER_DISTRIBUTION: Record<string, number> = {
  'Technical/Engineering': 30,
  'Research/Academic': 20,
  'Business/Operations': 15,
  'Creative/Content': 15,
  'Infrastructure/DevOps': 10,
  'Miscellaneous/Cross-domain': 10,
};

const PLATFORMS = ['moltbook', 'x', 'github', 'discord', 'custom'];

const FIRST_NAMES = [
  'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
  'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
  'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
  'Nova', 'Nebula', 'Quasar', 'Pulsar', 'Photon', 'Neutron',
];

const SUFFIXES = [
  'Agent', 'Bot', 'AI', 'Mind', 'Core', 'Net', 'Link', 'Hub',
  'Node', 'Synth', 'Proto', 'Nexus', 'Arc', 'Flux', 'Helix',
];

function generateAgentName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const suffix = SUFFIXES[Math.floor(index / FIRST_NAMES.length) % SUFFIXES.length];
  return `${first}${suffix}`;
}

function generateAgentId(index: number): string {
  return `sandbox-agent-${String(index).padStart(3, '0')}`;
}

// ========================
// Generate agents
// ========================
interface SyntheticAgent {
  id: string;
  name: string;
  platform: string;
  trust_score: number;
  capabilities: string[];
  cluster: string;
  pubkey: string;
  sybil_flagged?: boolean;
}

function generateAgents(count: number): SyntheticAgent[] {
  const agents: SyntheticAgent[] = [];
  let index = 0;

  for (const [cluster, percentage] of Object.entries(CLUSTER_DISTRIBUTION)) {
    const clusterCount = Math.round((percentage / 100) * count);
    const pool = CAPABILITY_POOLS[cluster];

    for (let i = 0; i < clusterCount && index < count; i++) {
      const capCount = 2 + Math.floor(seededRandom() * 4); // 2-5 capabilities
      const capabilities = pickN(pool, Math.min(capCount, pool.length));

      // 20% chance of cross-cluster capability
      if (seededRandom() > 0.8) {
        const otherCluster = pick(CLUSTER_NAMES.filter(c => c !== cluster));
        capabilities.push(pick(CAPABILITY_POOLS[otherCluster]));
      }

      agents.push({
        id: generateAgentId(index),
        name: generateAgentName(index),
        platform: pick(PLATFORMS),
        trust_score: parseFloat((0.3 + seededRandom() * 0.65).toFixed(2)), // 0.30 - 0.95
        capabilities,
        cluster,
        pubkey: `sandbox-pubkey-${index}`,
      });

      index++;
    }
  }

  // Fill any remaining slots
  while (agents.length < count) {
    const cluster = pick(CLUSTER_NAMES);
    const pool = CAPABILITY_POOLS[cluster];
    const capCount = 2 + Math.floor(seededRandom() * 4);

    agents.push({
      id: generateAgentId(index),
      name: generateAgentName(index),
      platform: pick(PLATFORMS),
      trust_score: parseFloat((0.3 + seededRandom() * 0.65).toFixed(2)),
      capabilities: pickN(pool, Math.min(capCount, pool.length)),
      cluster,
      pubkey: `sandbox-pubkey-${index}`,
    });
    index++;
  }

  // Mark one agent as sybil-flagged (scenario 5)
  agents[75].sybil_flagged = true;
  agents[75].trust_score = 0.05;
  agents[75].name = 'SybilSuspect';

  return agents;
}

// ========================
// Generate relationships
// ========================
interface Connection {
  from: string;
  to: string;
  strength: number;
  platform: string;
}

function generateConnections(agents: SyntheticAgent[]): Connection[] {
  const connections: Connection[] = [];
  const connectionSet = new Set<string>();

  // Each agent gets 2-8 connections (avg ~5 = 500 edges for 100 agents)
  for (const agent of agents) {
    const targetCount = 2 + Math.floor(seededRandom() * 7);

    // Prefer connections within same cluster (70%) and cross-cluster (30%)
    const sameCluster = agents.filter(a => a.id !== agent.id && a.cluster === agent.cluster);
    const otherCluster = agents.filter(a => a.id !== agent.id && a.cluster !== agent.cluster);

    for (let i = 0; i < targetCount; i++) {
      const pool = seededRandom() < 0.7 ? sameCluster : otherCluster;
      if (pool.length === 0) continue;

      const target = pick(pool);
      const key = [agent.id, target.id].sort().join(':');

      if (!connectionSet.has(key)) {
        connectionSet.add(key);
        connections.push({
          from: agent.id,
          to: target.id,
          strength: parseFloat((0.2 + seededRandom() * 0.8).toFixed(2)),
          platform: pick(PLATFORMS),
        });
      }
    }
  }

  return connections;
}

// ========================
// Pre-configured scenarios
// ========================
function setupScenarios(agents: SyntheticAgent[]): {
  extraConnections: Connection[];
  humans: { alias: string; public_name: string; consent_level: number }[];
  humanPairings: { agent: string; human: string }[];
} {
  // Scenario 1: Direct connection (1 hop)
  // agent-000 is directly connected to agent-001

  // Scenario 2: Multi-hop path (3 hops)
  // agent-010 -> agent-020 -> agent-030 -> agent-040
  const multiHopConnections: Connection[] = [
    { from: 'sandbox-agent-010', to: 'sandbox-agent-020', strength: 0.85, platform: 'moltbook' },
    { from: 'sandbox-agent-020', to: 'sandbox-agent-030', strength: 0.7, platform: 'moltbook' },
    { from: 'sandbox-agent-030', to: 'sandbox-agent-040', strength: 0.9, platform: 'moltbook' },
  ];

  // Scenario 3: Disconnected cluster (no path)
  // agent-098 and agent-099 are isolated (connections removed in main loop)

  // Scenario 5: Sybil-flagged agent is agent-075 (set above)

  // Humans for person-targeting scenarios
  const humans = [
    { alias: 'sandbox-alice', public_name: 'Alice S.', consent_level: 2 },
    { alias: 'sandbox-bob', public_name: 'Bob T.', consent_level: 1 },
    { alias: 'sandbox-carol', public_name: 'Carol R.', consent_level: 1 },
    { alias: 'sandbox-disconnected', public_name: 'Isolated Person', consent_level: 1 },
  ];

  const humanPairings = [
    { agent: 'sandbox-agent-005', human: 'sandbox-alice' },
    { agent: 'sandbox-agent-050', human: 'sandbox-bob' },
    { agent: 'sandbox-agent-085', human: 'sandbox-carol' },
    // sandbox-disconnected is NOT paired with anyone — tests scenario 3
  ];

  return { extraConnections: multiHopConnections, humans, humanPairings };
}

// ========================
// Main
// ========================
async function main() {
  const AGENT_COUNT = 110;
  console.log(`Seeding sandbox with ${AGENT_COUNT} synthetic agents...\n`);

  const driver = getDriver();
  const session = driver.session();

  try {
    // Clean existing sandbox data
    console.log('Cleaning existing sandbox data...');
    await session.run(`
      MATCH (n)
      WHERE n.id STARTS WITH 'sandbox-' OR n.alias STARTS WITH 'sandbox-'
      DETACH DELETE n
    `);

    // Generate data
    const agents = generateAgents(AGENT_COUNT);
    const connections = generateConnections(agents);
    const scenarios = setupScenarios(agents);

    // Remove connections to scenario 3 isolated agents
    const isolatedIds = new Set(['sandbox-agent-098', 'sandbox-agent-099']);
    const filteredConnections = connections.filter(
      c => !isolatedIds.has(c.from) && !isolatedIds.has(c.to)
    );

    // ========================
    // Create clusters
    // ========================
    console.log('Creating clusters...');
    for (const name of CLUSTER_NAMES) {
      await session.run(`
        MERGE (c:Cluster {name: $name})
        ON CREATE SET c.type = 'sandbox', c.description = $desc
      `, { name, desc: `${name} cluster (sandbox)` });
    }

    // ========================
    // Create agents (batched)
    // ========================
    console.log(`Creating ${agents.length} agents...`);
    const BATCH_SIZE = 20;
    for (let i = 0; i < agents.length; i += BATCH_SIZE) {
      const batch = agents.slice(i, i + BATCH_SIZE);
      await session.run(`
        UNWIND $agents AS agent
        MERGE (a:Agent {id: agent.id})
        ON CREATE SET
          a.name = agent.name,
          a.platform = agent.platform,
          a.trust_score = agent.trust_score,
          a.capabilities = agent.capabilities,
          a.pubkey = agent.pubkey,
          a.verified_at = agent.verified_at,
          a.sandbox = true
        ON MATCH SET
          a.trust_score = agent.trust_score,
          a.capabilities = agent.capabilities
      `, {
        agents: batch.map(a => ({
          ...a,
          verified_at: new Date().toISOString(),
        })),
      });
      process.stdout.write(`  ${Math.min(i + BATCH_SIZE, agents.length)}/${agents.length}\r`);
    }
    console.log(`  Created ${agents.length} agents              `);

    // Mark sybil-flagged
    await session.run(`
      MATCH (a:Agent {id: 'sandbox-agent-075'})
      SET a.sybil_flagged = true, a.trust_score = 0.05
    `);

    // ========================
    // Create connections (batched)
    // ========================
    const allConnections = [...filteredConnections, ...scenarios.extraConnections];
    console.log(`Creating ${allConnections.length} connections...`);

    for (let i = 0; i < allConnections.length; i += BATCH_SIZE) {
      const batch = allConnections.slice(i, i + BATCH_SIZE);
      await session.run(`
        UNWIND $connections AS conn
        MATCH (a1:Agent {id: conn.from}), (a2:Agent {id: conn.to})
        MERGE (a1)-[:CONNECTED_TO {platform: conn.platform, since: conn.since, strength: conn.strength}]->(a2)
        MERGE (a2)-[:CONNECTED_TO {platform: conn.platform, since: conn.since, strength: conn.strength}]->(a1)
      `, {
        connections: batch.map(c => ({
          ...c,
          since: new Date().toISOString(),
        })),
      });
      process.stdout.write(`  ${Math.min(i + BATCH_SIZE, allConnections.length)}/${allConnections.length}\r`);
    }
    console.log(`  Created ${allConnections.length} connections (bidirectional)    `);

    // ========================
    // Create humans + pairings
    // ========================
    console.log('Creating sandbox humans...');
    for (const human of scenarios.humans) {
      await session.run(`
        MERGE (h:Human {alias: $alias})
        ON CREATE SET h.public_name = $publicName, h.consent_level = $consentLevel, h.sandbox = true
      `, {
        alias: human.alias,
        publicName: human.public_name,
        consentLevel: human.consent_level,
      });
    }

    for (const pairing of scenarios.humanPairings) {
      await session.run(`
        MATCH (a:Agent {id: $agent}), (h:Human {alias: $human})
        MERGE (a)-[:PAIRED_WITH {verified: true}]->(h)
      `, pairing);
    }

    // ========================
    // Create cluster memberships for humans
    // ========================
    const humanClusters = [
      { human: 'sandbox-alice', cluster: 'Research/Academic', confidence: 0.9 },
      { human: 'sandbox-alice', cluster: 'Technical/Engineering', confidence: 0.7 },
      { human: 'sandbox-bob', cluster: 'Business/Operations', confidence: 0.85 },
      { human: 'sandbox-carol', cluster: 'Creative/Content', confidence: 0.8 },
    ];

    for (const m of humanClusters) {
      await session.run(`
        MATCH (h:Human {alias: $human}), (c:Cluster {name: $cluster})
        MERGE (h)-[:IN_CLUSTER {confidence: $confidence}]->(c)
      `, m);
    }

    // ========================
    // Generate attestations
    // ========================
    console.log('Creating attestations...');
    let attestCount = 0;
    for (let i = 0; i < 50; i++) {
      const from = pick(agents.filter(a => !isolatedIds.has(a.id)));
      const to = pick(agents.filter(a => a.id !== from.id && !isolatedIds.has(a.id)));

      await session.run(`
        MATCH (a1:Agent {id: $from}), (a2:Agent {id: $to})
        MERGE (a1)-[:ATTESTED {
          claim: $claim,
          timestamp: $timestamp,
          evidence: $evidence,
          valid_until: $validUntil,
          confidence: $confidence
        }]->(a2)
      `, {
        from: from.id,
        to: to.id,
        claim: pick(['CAPABILITY', 'IDENTITY', 'INTERACTION']),
        timestamp: new Date().toISOString(),
        evidence: pick(from.capabilities),
        validUntil: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        confidence: parseFloat((0.5 + seededRandom() * 0.5).toFixed(2)),
      });
      attestCount++;
    }
    console.log(`  Created ${attestCount} attestations`);

    // ========================
    // Summary
    // ========================
    const countResult = await session.run(`
      MATCH (a:Agent) WHERE a.sandbox = true WITH count(a) AS agents
      MATCH (h:Human) WHERE h.sandbox = true WITH agents, count(h) AS humans
      MATCH (c:Cluster) WITH agents, humans, count(c) AS clusters
      RETURN agents, humans, clusters
    `);

    const counts = countResult.records[0];
    console.log('\n' + '='.repeat(60));
    console.log('Sandbox seed complete:');
    console.log(`  Agents:      ${counts.get('agents')}`);
    console.log(`  Humans:      ${counts.get('humans')}`);
    console.log(`  Clusters:    ${counts.get('clusters')}`);
    console.log(`  Connections: ${allConnections.length} (bidirectional)`);
    console.log(`  Attestations: ${attestCount}`);
    console.log('');
    console.log('Pre-configured scenarios:');
    console.log('  1. Direct connection: agent-000 <-> agent-001');
    console.log('  2. Multi-hop (3 hops): agent-010 -> agent-020 -> agent-030 -> agent-040');
    console.log('  3. No path: agent-098, agent-099 (isolated)');
    console.log('  4. Capability cluster: 30+ Technical/Engineering agents');
    console.log('  5. Sybil-flagged: agent-075 (trust: 0.05)');
    console.log('='.repeat(60));

  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch(error => {
  console.error('Sandbox seed failed:', error);
  process.exit(1);
});
