type TestRunLock = Readonly<{
  lockPath: string;
  token: string;
  owned: boolean;
}>;

type TestRunLockOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  retryMs?: number;
  incompleteGraceMs?: number;
}>;

export function acquireTestRunLock(
  projectRoot: string,
  options?: TestRunLockOptions
): Promise<TestRunLock>;

export function releaseTestRunLock(lock: TestRunLock | null | undefined): void;
export function testRunLockEnv(lock: TestRunLock): NodeJS.ProcessEnv;
export function testRunLockPath(projectRoot: string): string;
