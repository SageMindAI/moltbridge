/**
 * Mock Neo4j Driver for unit tests
 *
 * Provides a configurable mock that simulates Neo4j session.run() responses.
 */

import { vi } from 'vitest';

export interface MockRecord {
  get(key: string): any;
}

export interface MockRunResult {
  records: MockRecord[];
}

/**
 * Create a mock record that responds to .get() calls
 */
export function mockRecord(data: Record<string, any>): MockRecord {
  return {
    get(key: string) {
      return data[key];
    },
  };
}

/**
 * Create a mock Neo4j session
 */
export function createMockSession(responses?: MockRunResult[]) {
  let callIndex = 0;
  const defaultResponse: MockRunResult = { records: [] };

  const session = {
    run: vi.fn().mockImplementation(() => {
      const response = responses?.[callIndex] ?? defaultResponse;
      callIndex++;
      return Promise.resolve(response);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return session;
}

/**
 * Create a mock Neo4j driver
 */
export function createMockDriver(session?: ReturnType<typeof createMockSession>) {
  const mockSession = session ?? createMockSession();

  return {
    session: vi.fn().mockReturnValue(mockSession),
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Set up the neo4j module mock.
 * Call this in vi.mock() callbacks.
 */
export function mockNeo4jModule(driver?: ReturnType<typeof createMockDriver>) {
  const mockDriver = driver ?? createMockDriver();

  return {
    getDriver: vi.fn().mockReturnValue(mockDriver),
    verifyConnectivity: vi.fn().mockResolvedValue(true),
    closeDriver: vi.fn().mockResolvedValue(undefined),
  };
}
