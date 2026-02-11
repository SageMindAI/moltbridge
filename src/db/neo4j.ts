/**
 * Neo4j Driver — Singleton connection manager
 */

import neo4j, { Driver } from 'neo4j-driver';

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const user = process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASSWORD;

    if (!uri || !user || !password) {
      throw new Error('Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD environment variables');
    }

    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

export async function verifyConnectivity(): Promise<boolean> {
  try {
    const d = getDriver();
    await d.verifyConnectivity();
    return true;
  } catch (error) {
    console.error('[Neo4j] Connectivity check failed:', error);
    return false;
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
