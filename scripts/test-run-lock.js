import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_PATH_ENV = 'AGENT_INFRA_TEST_RUNNER_LOCK_PATH';
const LOCK_TOKEN_ENV = 'AGENT_INFRA_TEST_RUNNER_LOCK_TOKEN';

function testRunLockPath(projectRoot) {
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `agent-infra-test-runner-${digest}.lock`);
}

function readOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.token !== 'string' || !value.token) return null;
    return value;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

async function acquireTestRunLock(
  projectRoot,
  { env = process.env, retryMs = 50, incompleteGraceMs = 5_000 } = {}
) {
  const lockPath = testRunLockPath(projectRoot);
  const inheritedPath = env[LOCK_PATH_ENV];
  const inheritedToken = env[LOCK_TOKEN_ENV];
  if (inheritedPath && inheritedToken && path.resolve(inheritedPath) === lockPath) {
    const owner = readOwner(lockPath);
    if (owner?.token === inheritedToken) {
      return { lockPath, token: inheritedToken, owned: false };
    }
  }

  const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          createdAt: Date.now()
        })}\n`, { mode: 0o600 });
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { lockPath, token, owned: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const owner = readOwner(lockPath);
    const incompleteOwner = !owner && lockAgeMs(lockPath) < incompleteGraceMs;
    if ((owner && processAlive(owner.pid)) || incompleteOwner) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }

    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, stalePath);
      fs.rmSync(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function releaseTestRunLock(lock) {
  if (!lock?.owned) return;
  const owner = readOwner(lock.lockPath);
  if (owner?.token !== lock.token) return;
  const releasePath = `${lock.lockPath}.release-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lock.lockPath, releasePath);
    fs.rmSync(releasePath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function testRunLockEnv(lock) {
  return {
    [LOCK_PATH_ENV]: lock.lockPath,
    [LOCK_TOKEN_ENV]: lock.token
  };
}

export {
  acquireTestRunLock,
  releaseTestRunLock,
  testRunLockEnv,
  testRunLockPath
};
