/**
 * Bootstrap Neo4j Schema
 *
 * Creates constraints and indexes. Idempotent — safe to run multiple times.
 * Run with: pnpm bootstrap
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { getDriver, closeDriver } from '../src/db/neo4j';

const CONSTRAINTS = [
  {
    name: 'agent_id_unique',
    query: 'CREATE CONSTRAINT agent_id_unique IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE',
  },
  {
    name: 'human_alias_unique',
    query: 'CREATE CONSTRAINT human_alias_unique IF NOT EXISTS FOR (h:Human) REQUIRE h.alias IS UNIQUE',
  },
  {
    name: 'cluster_name_unique',
    query: 'CREATE CONSTRAINT cluster_name_unique IF NOT EXISTS FOR (c:Cluster) REQUIRE c.name IS UNIQUE',
  },
  {
    name: 'org_name_unique',
    query: 'CREATE CONSTRAINT org_name_unique IF NOT EXISTS FOR (o:Organization) REQUIRE o.name IS UNIQUE',
  },
];

const INDEXES = [
  {
    name: 'agent_trust_idx',
    query: 'CREATE INDEX agent_trust_idx IF NOT EXISTS FOR (a:Agent) ON (a.trust_score)',
  },
  {
    name: 'agent_capabilities_idx',
    query: 'CREATE INDEX agent_capabilities_idx IF NOT EXISTS FOR (a:Agent) ON (a.capabilities)',
  },
];

async function main() {
  console.log('Bootstrapping Neo4j schema...\n');

  const driver = getDriver();
  const session = driver.session();

  try {
    // Create constraints
    for (const constraint of CONSTRAINTS) {
      try {
        await session.run(constraint.query);
        console.log(`  [OK] Constraint: ${constraint.name}`);
      } catch (error: any) {
        if (error.message?.includes('already exists')) {
          console.log(`  [--] Constraint already exists: ${constraint.name}`);
        } else {
          console.error(`  [!!] Failed: ${constraint.name}:`, error.message);
        }
      }
    }

    console.log('');

    // Create indexes
    for (const index of INDEXES) {
      try {
        await session.run(index.query);
        console.log(`  [OK] Index: ${index.name}`);
      } catch (error: any) {
        if (error.message?.includes('already exists')) {
          console.log(`  [--] Index already exists: ${index.name}`);
        } else {
          console.error(`  [!!] Failed: ${index.name}:`, error.message);
        }
      }
    }

    console.log('\nSchema bootstrap complete.');
  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch(error => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
