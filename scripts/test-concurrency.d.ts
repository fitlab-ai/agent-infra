export const TEST_CONCURRENCY_ENV: string;
export function defaultTestConcurrency(): number;
export function parseTestConcurrency(value: string | undefined): number;
export function testConcurrencyFromEnv(environment?: NodeJS.ProcessEnv): number;
