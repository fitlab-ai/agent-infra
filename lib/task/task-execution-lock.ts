import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { getProcessStartTime, processIdentityMatches } from '../server/process-state.ts';
import type { ProcessIdentity } from '../server/process-state.ts';

type TaskExecutionLockErrorCode =
  | 'ORCHESTRATION_LOCK_BUSY'
  | 'ORCHESTRATION_LOCK_UNSUPPORTED'
  | 'ORCHESTRATION_LOCK_FAILED';

type TaskExecutionLockOwner = Readonly<{
  version: 2;
  pid: number;
  startTime: number;
  token: string;
  owner: string;
  canonicalRepoRoot: string;
  taskId: string;
  acquiredAt: string;
}>;

type LinkOperation = 'acquire' | 'quarantine';
type LinkDisposition = 'exists' | 'missing' | TaskExecutionLockError;

type TaskExecutionLockOptions = Readonly<{
  lockRoot?: string;
  token?: () => string;
  now?: () => string;
  getStartTime?: (pid: number) => number | null;
  identityMatches?: (identity: ProcessIdentity) => boolean;
  linkSync?: (existingPath: string, newPath: string) => void;
}>;

class TaskExecutionLockError extends Error {
  readonly code: TaskExecutionLockErrorCode;
  readonly detail: Readonly<{ operation: string; errno: string | null; key: string }>;

  constructor(
    code: TaskExecutionLockErrorCode,
    message: string,
    detail: Readonly<{ operation: string; errno: string | null; key: string }>
  ) {
    super(message);
    this.name = 'TaskExecutionLockError';
    this.code = code;
    this.detail = detail;
  }
}

function errno(error: unknown): string | null {
  const value = (error as NodeJS.ErrnoException | null)?.code;
  return typeof value === 'string' ? value : null;
}

function mapLinkError(operation: LinkOperation, error: unknown, key: string): LinkDisposition {
  const code = errno(error);
  if (code === 'EEXIST') return 'exists';
  if (operation === 'quarantine' && code === 'ENOENT') return 'missing';
  const detail = { operation, errno: code, key };
  if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) {
    return new TaskExecutionLockError(
      'ORCHESTRATION_LOCK_UNSUPPORTED',
      `lifecycle lock hard-link operation '${operation}' is unsupported`,
      detail
    );
  }
  return new TaskExecutionLockError(
    'ORCHESTRATION_LOCK_FAILED',
    `lifecycle lock hard-link operation '${operation}' failed`,
    detail
  );
}

function lockKey(repoRoot: string, taskId: string): Readonly<{ canonicalRepoRoot: string; key: string }> {
  const canonicalRepoRoot = fs.realpathSync.native(repoRoot);
  const key = createHash('sha256').update(`${canonicalRepoRoot}\0${taskId}`).digest('hex');
  return { canonicalRepoRoot, key };
}

function parseOwner(raw: string, key: string): TaskExecutionLockOwner {
  try {
    const value = JSON.parse(raw) as Partial<TaskExecutionLockOwner> | null;
    if (
      value !== null
      && value.version === 2
      && Number.isSafeInteger(value.pid)
      && (value.pid ?? 0) > 0
      && typeof value.startTime === 'number'
      && Number.isSafeInteger(value.startTime)
      && value.startTime >= 0
      && typeof value.token === 'string'
      && value.token.length > 0
      && typeof value.owner === 'string'
      && typeof value.canonicalRepoRoot === 'string'
      && typeof value.taskId === 'string'
      && typeof value.acquiredAt === 'string'
    ) {
      return value as TaskExecutionLockOwner;
    }
  } catch {
    // Fall through to the stable lock failure below.
  }
  throw new TaskExecutionLockError(
    'ORCHESTRATION_LOCK_FAILED',
    'lifecycle lock owner record is invalid',
    { operation: 'read', errno: null, key }
  );
}

function unlinkIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function reclaimStaleLock(
  fixed: string,
  quarantine: string,
  snapshot: string,
  key: string,
  link: (existingPath: string, newPath: string) => void
): void {
  let linked = false;
  try {
    link(fixed, quarantine);
    linked = true;
  } catch (error) {
    const disposition = mapLinkError('quarantine', error, key);
    if (disposition === 'missing') return;
    if (disposition === 'exists') {
      try {
        const quarantineSnapshot = fs.readFileSync(quarantine, 'utf8');
        const fixedStat = fs.statSync(fixed);
        const quarantineStat = fs.statSync(quarantine);
        if (quarantineSnapshot === snapshot && sameInode(fixedStat, quarantineStat)) {
          unlinkIfPresent(quarantine);
        }
      } catch (readError) {
        if (errno(readError) !== 'ENOENT') throw readError;
      }
      return;
    }
    if (disposition instanceof TaskExecutionLockError) throw disposition;
  }
  try {
    const fixedSnapshot = fs.readFileSync(fixed, 'utf8');
    const fixedStat = fs.statSync(fixed);
    const quarantineStat = fs.statSync(quarantine);
    if (fixedSnapshot === snapshot && sameInode(fixedStat, quarantineStat)) unlinkIfPresent(fixed);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  } finally {
    if (linked) unlinkIfPresent(quarantine);
  }
}

function cleanStaleCandidates(
  lockRoot: string,
  key: string,
  identityMatches: (identity: ProcessIdentity) => boolean
): void {
  const prefix = `${key}.candidate.`;
  for (const name of fs.readdirSync(lockRoot)) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(lockRoot, name);
    try {
      const owner = parseOwner(fs.readFileSync(candidate, 'utf8'), key);
      if (!identityMatches(owner)) unlinkIfPresent(candidate);
    } catch {
      // A malformed candidate never owns the fixed lock and is left for manual diagnosis.
    }
  }
}

function withTaskExecutionLock<T>(
  repoRoot: string,
  taskId: string,
  ownerName: string,
  callback: () => T,
  options: TaskExecutionLockOptions = {}
): T {
  let identity: Readonly<{ canonicalRepoRoot: string; key: string }>;
  try {
    identity = lockKey(repoRoot, taskId);
  } catch (error) {
    throw new TaskExecutionLockError(
      'ORCHESTRATION_LOCK_FAILED',
      'failed to canonicalize the repository for lifecycle locking',
      { operation: 'canonicalize', errno: errno(error), key: 'unresolved' }
    );
  }
  const { canonicalRepoRoot, key } = identity;
  const lockRoot = options.lockRoot ?? path.join(os.tmpdir(), 'agent-infra-lifecycle-locks');
  const token = (options.token ?? randomUUID)();
  const candidate = path.join(lockRoot, `${key}.candidate.${process.pid}.${token}`);
  const fixed = path.join(lockRoot, `${key}.lock`);
  const link = options.linkSync ?? fs.linkSync;
  const startTime = (options.getStartTime ?? getProcessStartTime)(process.pid);
  if (startTime === null) {
    throw new TaskExecutionLockError(
      'ORCHESTRATION_LOCK_FAILED',
      'current process start time is unavailable',
      { operation: 'identity', errno: null, key }
    );
  }
  const owner: TaskExecutionLockOwner = {
    version: 2,
    pid: process.pid,
    startTime,
    token,
    owner: ownerName,
    canonicalRepoRoot,
    taskId,
    acquiredAt: (options.now ?? (() => new Date().toISOString()))()
  };
  const serialized = `${JSON.stringify(owner)}\n`;
  let ownsFixed = false;
  try {
    fs.mkdirSync(lockRoot, { recursive: true });
    cleanStaleCandidates(lockRoot, key, options.identityMatches ?? processIdentityMatches);
    const descriptor = fs.openSync(candidate, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, serialized);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        link(candidate, fixed);
        ownsFixed = true;
        break;
      } catch (error) {
        const disposition = mapLinkError('acquire', error, key);
        if (disposition instanceof TaskExecutionLockError) throw disposition;
        let snapshot: string;
        let current: TaskExecutionLockOwner;
        try {
          snapshot = fs.readFileSync(fixed, 'utf8');
          current = parseOwner(snapshot, key);
        } catch (readError) {
          if (errno(readError) === 'ENOENT') continue;
          throw readError;
        }
        if ((options.identityMatches ?? processIdentityMatches)(current)) {
          throw new TaskExecutionLockError(
            'ORCHESTRATION_LOCK_BUSY',
            'another lifecycle operation holds the task lock',
            { operation: 'acquire', errno: 'EEXIST', key }
          );
        }
        reclaimStaleLock(fixed, `${fixed}.quarantine.${current.token}`, snapshot, key, link);
      }
    }
    if (!ownsFixed) {
      throw new TaskExecutionLockError(
        'ORCHESTRATION_LOCK_BUSY',
        'lifecycle task lock could not be acquired after stale recovery',
        { operation: 'acquire', errno: 'EEXIST', key }
      );
    }
    unlinkIfPresent(candidate);
    return callback();
  } catch (error) {
    if (error instanceof TaskExecutionLockError) throw error;
    if (error instanceof Error && error.name === 'OrchestrationStateError') throw error;
    throw new TaskExecutionLockError(
      'ORCHESTRATION_LOCK_FAILED',
      'lifecycle task lock operation failed',
      { operation: ownsFixed ? 'callback' : 'acquire', errno: errno(error), key }
    );
  } finally {
    try {
      unlinkIfPresent(candidate);
    } catch {
      // Candidate cleanup is best-effort and must not replace the primary result.
    }
    if (ownsFixed) {
      try {
        const current = parseOwner(fs.readFileSync(fixed, 'utf8'), key);
        if (current.token === token) unlinkIfPresent(fixed);
      } catch {
        // A missing or replaced fixed lock is not owned by this invocation.
      }
    }
  }
}

export { TaskExecutionLockError, lockKey, mapLinkError, withTaskExecutionLock };
export type { LinkDisposition, LinkOperation, TaskExecutionLockErrorCode, TaskExecutionLockOptions, TaskExecutionLockOwner };
