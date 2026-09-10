import os from 'node:os';

export const TEST_CONCURRENCY_ENV = 'AGENT_INFRA_TEST_CONCURRENCY';

export function defaultTestConcurrency() {
  return Math.max(1, os.availableParallelism() * 2);
}

export function parseTestConcurrency(value) {
  if (value === undefined) return defaultTestConcurrency();
  if (!/^[1-9]\d*$/.test(value)) throw invalidConcurrency();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidConcurrency();
  return parsed;
}

export function testConcurrencyFromEnv(environment = process.env) {
  return parseTestConcurrency(environment[TEST_CONCURRENCY_ENV]);
}

function invalidConcurrency() {
  return new Error(`${TEST_CONCURRENCY_ENV} must be a positive safe integer`);
}
