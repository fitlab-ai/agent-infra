import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { getProcessStartTime, processIdentityMatches } from '../server/process-state.ts';
import type { ProcessIdentity } from '../server/process-state.ts';
import { writeDurableFile } from '../fs/durable-write.ts';

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
  transitionAdmission?: boolean;
  skipTransitionAdmission?: boolean;
  transitionLockRoot?: string;
  transitionTimeoutMs?: number;
  transitionPollMs?: number;
}>;

type TransitionOwner = Readonly<{
  version: 1;
  pid: number;
  startTime: number;
  token: string;
  owner: string;
  canonicalRepoRoot: string;
  generation: number;
  acquiredAt: string;
}>;

type TransitionState = Readonly<{
  version: 1;
  canonicalRepoRoot: string;
  generation: number;
  admission: 'open' | 'closed';
  exclusive: TransitionOwner | null;
}>;

type TransitionLease = Readonly<{
  generation: number;
  token: string;
  release: () => void;
}>;

const transitionContext = new AsyncLocalStorage<boolean>();

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

const TRANSITION_COORDINATION_TASK = '__transition_coordination__';
const TRANSITION_STATE_VERSION = 1;
const DEFAULT_TRANSITION_LOCK_ROOT = path.join(os.tmpdir(), 'agent-infra-transition-locks');

function transitionRoot(options: TaskExecutionLockOptions): string {
  return options.transitionLockRoot
    ?? options.lockRoot
    ?? DEFAULT_TRANSITION_LOCK_ROOT;
}

function transitionPaths(repoRoot: string, lockRoot: string): Readonly<{ key: string; state: string; sharedPrefix: string }> {
  const identity = lockKey(repoRoot, TRANSITION_COORDINATION_TASK);
  return {
    key: identity.key,
    state: path.join(lockRoot, `${identity.key}.transition.json`),
    sharedPrefix: `${identity.key}.shared.`
  };
}

function defaultTransitionState(canonicalRepoRoot: string): TransitionState {
  return {
    version: TRANSITION_STATE_VERSION,
    canonicalRepoRoot,
    generation: 0,
    admission: 'open',
    exclusive: null
  };
}

function transitionOwner(value: unknown, label: string): TransitionOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} owner is invalid`);
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== TRANSITION_STATE_VERSION
    || !Number.isSafeInteger(candidate.pid) || Number(candidate.pid) <= 0
    || !Number.isSafeInteger(candidate.startTime) || Number(candidate.startTime) < 0
    || typeof candidate.token !== 'string' || !candidate.token
    || typeof candidate.owner !== 'string' || !candidate.owner
    || typeof candidate.canonicalRepoRoot !== 'string' || !candidate.canonicalRepoRoot
    || !Number.isSafeInteger(candidate.generation) || Number(candidate.generation) < 0
    || typeof candidate.acquiredAt !== 'string' || !candidate.acquiredAt
  ) throw new Error(`${label} owner is invalid`);
  return candidate as TransitionOwner;
}

function readTransitionState(file: string, canonicalRepoRoot: string): TransitionState {
  if (!fs.existsSync(file)) return defaultTransitionState(canonicalRepoRoot);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('transition coordination state is invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('transition coordination state is invalid');
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== TRANSITION_STATE_VERSION
    || value.canonicalRepoRoot !== canonicalRepoRoot
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0
    || (value.admission !== 'open' && value.admission !== 'closed')
    || (value.admission === 'closed' && value.exclusive === null)
  ) throw new Error('transition coordination state is invalid');
  return {
    version: TRANSITION_STATE_VERSION,
    canonicalRepoRoot,
    generation: Number(value.generation),
    admission: value.admission,
    exclusive: value.exclusive === null ? null : transitionOwner(value.exclusive, 'exclusive')
  };
}

function writeTransitionState(file: string, state: TransitionState): void {
  writeDurableFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600, replace: true });
}

function leaseRecord(file: string): TransitionOwner {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`transition shared lease '${path.basename(file)}' is invalid JSON`); }
  return transitionOwner(parsed, 'shared lease');
}

function cleanStaleTransitionLeases(
  lockRoot: string,
  sharedPrefix: string,
  identityMatches: (identity: ProcessIdentity) => boolean
): void {
  for (const name of fs.readdirSync(lockRoot)) {
    if (!name.startsWith(sharedPrefix)) continue;
    const file = path.join(lockRoot, name);
    const owner = leaseRecord(file);
    if (!identityMatches(owner)) unlinkIfPresent(file);
  }
}

function transitionOwnerFor(
  repoRoot: string,
  ownerName: string,
  generation: number,
  options: TaskExecutionLockOptions
): TransitionOwner {
  const startTime = (options.getStartTime ?? getProcessStartTime)(process.pid);
  if (startTime === null) {
    throw new TaskExecutionLockError(
      'ORCHESTRATION_LOCK_FAILED',
      'current process start time is unavailable',
      { operation: 'identity', errno: null, key: transitionPaths(repoRoot, transitionRoot(options)).key }
    );
  }
  return {
    version: TRANSITION_STATE_VERSION,
    pid: process.pid,
    startTime,
    token: (options.token ?? randomUUID)(),
    owner: ownerName,
    canonicalRepoRoot: fs.realpathSync.native(repoRoot),
    generation,
    acquiredAt: (options.now ?? (() => new Date().toISOString()))()
  };
}

function withCoordinationLock<T>(
  repoRoot: string,
  ownerName: string,
  callback: () => T,
  options: TaskExecutionLockOptions
): T {
  return withTaskExecutionLock(
    repoRoot,
    TRANSITION_COORDINATION_TASK,
    ownerName,
    callback,
    { ...options, lockRoot: transitionRoot(options), skipTransitionAdmission: true }
  );
}

function acquireTransitionSharedLease(
  repoRoot: string,
  ownerName: string,
  options: TaskExecutionLockOptions
): TransitionLease {
  const lockRoot = transitionRoot(options);
  const identity = lockKey(repoRoot, TRANSITION_COORDINATION_TASK);
  const paths = transitionPaths(repoRoot, lockRoot);
  fs.mkdirSync(lockRoot, { recursive: true });
  let lease: TransitionOwner | null = null;
  withCoordinationLock(repoRoot, `${ownerName}.admission`, () => {
    let state = readTransitionState(paths.state, identity.canonicalRepoRoot);
    cleanStaleTransitionLeases(lockRoot, paths.sharedPrefix, options.identityMatches ?? processIdentityMatches);
    if (state.exclusive) {
      if ((options.identityMatches ?? processIdentityMatches)(state.exclusive)) {
        throw new TaskExecutionLockError(
          'ORCHESTRATION_LOCK_BUSY',
          'repository migration has closed transition writer admission',
          { operation: 'shared-admission', errno: 'EEXIST', key: paths.key }
        );
      }
      state = { ...state, admission: 'open', exclusive: null };
      writeTransitionState(paths.state, state);
    }
    if (state.admission !== 'open') {
      throw new TaskExecutionLockError(
        'ORCHESTRATION_LOCK_BUSY',
        'repository migration has closed transition writer admission',
        { operation: 'shared-admission', errno: 'EEXIST', key: paths.key }
      );
    }
    lease = transitionOwnerFor(repoRoot, ownerName, state.generation, options);
    const file = path.join(lockRoot, `${paths.sharedPrefix}${lease.token}.json`);
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(lease)}\n`);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }, { ...options, lockRoot: transitionRoot(options) });
  const owner = lease!;
  const file = path.join(lockRoot, `${paths.sharedPrefix}${owner.token}.json`);
  return {
    generation: owner.generation,
    token: owner.token,
    release: () => unlinkIfPresent(file)
  };
}

function transitionSharedLeases(
  lockRoot: string,
  sharedPrefix: string,
  cutoffGeneration: number,
  identityMatches: (identity: ProcessIdentity) => boolean
): TransitionOwner[] {
  const active: TransitionOwner[] = [];
  for (const name of fs.readdirSync(lockRoot)) {
    if (!name.startsWith(sharedPrefix)) continue;
    const owner = leaseRecord(path.join(lockRoot, name));
    if (!identityMatches(owner)) {
      unlinkIfPresent(path.join(lockRoot, name));
      continue;
    }
    if (owner.generation <= cutoffGeneration) active.push(owner);
  }
  return active;
}

function clearTransitionExclusive(repoRoot: string, owner: TransitionOwner, options: TaskExecutionLockOptions): void {
  const lockRoot = transitionRoot(options);
  const paths = transitionPaths(repoRoot, lockRoot);
  withCoordinationLock(repoRoot, `${owner.owner}.release`, () => {
    const state = readTransitionState(paths.state, owner.canonicalRepoRoot);
    if (state.exclusive?.token !== owner.token) return;
    writeTransitionState(paths.state, { ...state, admission: 'open', exclusive: null });
  }, { ...options, lockRoot: transitionRoot(options) });
}

function acquireTransitionExclusiveLease(
  repoRoot: string,
  ownerName: string,
  options: TaskExecutionLockOptions
): TransitionOwner {
  const lockRoot = transitionRoot(options);
  const identity = lockKey(repoRoot, TRANSITION_COORDINATION_TASK);
  const paths = transitionPaths(repoRoot, lockRoot);
  fs.mkdirSync(lockRoot, { recursive: true });
  let owner: TransitionOwner | null = null;
  withCoordinationLock(repoRoot, `${ownerName}.admission`, () => {
    let state = readTransitionState(paths.state, identity.canonicalRepoRoot);
    const matches = options.identityMatches ?? processIdentityMatches;
    cleanStaleTransitionLeases(lockRoot, paths.sharedPrefix, matches);
    if (state.exclusive && matches(state.exclusive)) {
      throw new TaskExecutionLockError(
        'ORCHESTRATION_LOCK_BUSY',
        'another repository migration is already active',
        { operation: 'exclusive-admission', errno: 'EEXIST', key: paths.key }
      );
    }
    const cutoffGeneration = state.generation;
    owner = transitionOwnerFor(repoRoot, ownerName, cutoffGeneration, options);
    state = {
      ...state,
      generation: cutoffGeneration + 1,
      admission: 'closed',
      exclusive: owner
    };
    writeTransitionState(paths.state, state);
  }, { ...options, lockRoot: transitionRoot(options) });
  const exclusive = owner!;
  const timeout = options.transitionTimeoutMs ?? 30_000;
  const poll = Math.max(1, options.transitionPollMs ?? 10);
  const deadline = Date.now() + timeout;
  while (true) {
    let active: TransitionOwner[] = [];
    withCoordinationLock(repoRoot, `${ownerName}.drain`, () => {
      active = transitionSharedLeases(lockRoot, paths.sharedPrefix, exclusive.generation, options.identityMatches ?? processIdentityMatches);
    }, { ...options, lockRoot: transitionRoot(options) });
    if (active.length === 0) return exclusive;
    if (Date.now() >= deadline) {
      clearTransitionExclusive(repoRoot, exclusive, options);
      throw new TaskExecutionLockError(
        'ORCHESTRATION_LOCK_BUSY',
        'repository migration timed out waiting for transition writers to drain',
        { operation: 'exclusive-drain', errno: 'ETIMEDOUT', key: paths.key }
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, poll);
  }
}

function transitionAdmissionEnabled(options: TaskExecutionLockOptions): boolean {
  return options.transitionAdmission ?? process.env.AGENT_INFRA_TRANSITION_BUILD === '1';
}

function transitionLeaseHeld(): boolean {
  return transitionContext.getStore() === true;
}

function runWithTransitionContext<T>(callback: () => T): T {
  return transitionContext.run(true, callback);
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
  const transitionLease = transitionAdmissionEnabled(options) && !options.skipTransitionAdmission
    ? acquireTransitionSharedLease(repoRoot, ownerName, options)
    : null;
  let ownsFixed = false;
  let deferRelease = false;
  const release = (): void => {
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
  };
  const releaseAll = (): void => {
    release();
    transitionLease?.release();
  };
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
    const value = transitionLease ? runWithTransitionContext(callback) : callback();
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      deferRelease = true;
      return (value as unknown as Promise<unknown>).finally(releaseAll) as T;
    }
    return value;
  } catch (error) {
    if (error instanceof TaskExecutionLockError) throw error;
    if (error instanceof Error && error.name === 'OrchestrationStateError') throw error;
    throw new TaskExecutionLockError(
      'ORCHESTRATION_LOCK_FAILED',
      'lifecycle task lock operation failed',
      { operation: ownsFixed ? 'callback' : 'acquire', errno: errno(error), key }
    );
  } finally {
    if (!deferRelease) releaseAll();
  }
}

function withTransitionWriter<T>(
  repoRoot: string,
  taskId: string,
  ownerName: string,
  callback: () => T,
  options: TaskExecutionLockOptions = {}
): T {
  const lease = acquireTransitionSharedLease(repoRoot, ownerName, options);
  let deferRelease = false;
  try {
    const value = withTaskExecutionLock(
      repoRoot,
      taskId,
      ownerName,
      () => runWithTransitionContext(callback),
      { ...options, skipTransitionAdmission: true }
    );
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      deferRelease = true;
      return (value as unknown as Promise<unknown>).finally(lease.release) as T;
    }
    return value;
  } finally {
    if (!deferRelease) lease.release();
  }
}

function withTransitionMigrationLock<T>(
  repoRoot: string,
  ownerName: string,
  callback: () => T,
  options: TaskExecutionLockOptions = {}
): T {
  const lease = acquireTransitionExclusiveLease(repoRoot, ownerName, options);
  let deferRelease = false;
  try {
    const value = callback();
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      deferRelease = true;
      return (value as unknown as Promise<unknown>).finally(() => clearTransitionExclusive(repoRoot, lease, options)) as T;
    }
    return value;
  } finally {
    if (!deferRelease) clearTransitionExclusive(repoRoot, lease, options);
  }
}

function withRepositoryMutationLock<T>(
  repoRoot: string,
  callback: () => T,
  options: TaskExecutionLockOptions = {}
): T {
  return withTaskExecutionLock(repoRoot, '__repository_mutation__', 'repository-mutation', callback, options);
}

function transitionStatePath(repoRoot: string, lockRoot?: string): string {
  const root = lockRoot ?? DEFAULT_TRANSITION_LOCK_ROOT;
  return transitionPaths(repoRoot, root).state;
}

export {
  TaskExecutionLockError,
  lockKey,
  mapLinkError,
  transitionStatePath,
  DEFAULT_TRANSITION_LOCK_ROOT,
  withRepositoryMutationLock,
  withTaskExecutionLock,
  withTransitionMigrationLock,
  withTransitionWriter,
  transitionLeaseHeld
};
export type {
  LinkDisposition,
  LinkOperation,
  TaskExecutionLockErrorCode,
  TaskExecutionLockOptions,
  TaskExecutionLockOwner,
  TransitionLease,
  TransitionOwner,
  TransitionState
};
