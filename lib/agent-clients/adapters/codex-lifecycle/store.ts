import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createCodexLifecycleState,
  expireCodexLifecycleState,
  reduceCodexLifecycleEvent
} from './evidence.ts';
import type {
  CodexLifecycleEvent,
  CodexLifecycleState
} from './evidence.ts';
import type { CodexLifecycleTaskBinding } from './binding.ts';

type StoredCodexLifecycle = Readonly<{
  schemaVersion: 2;
  revision: number;
  taskBinding: CodexLifecycleTaskBinding | null;
  state: CodexLifecycleState;
  consumer: string | null;
  consumedAt: string | null;
  spawnObservedAt: string | null;
  updatedAt: string;
}>;

type CodexLifecycleStoreOptions = Readonly<{
  root?: string;
  taskId?: string;
  cliVersion: string;
  now?: () => string;
}>;

type CodexLifecycleStoreResult = Readonly<{
  path: string;
  revision: number;
  state: CodexLifecycleState;
}>;

type ActiveCodexLifecycleEvidenceQuery = Readonly<{
  nativeAgent: string;
  hookDefinitionHash: string;
}>;

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readRecord(file: string, expectedTaskId?: string): StoredCodexLifecycle {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredCodexLifecycle;
  if (
    value.schemaVersion !== 2
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !value.state
    || value.state.schemaVersion !== 1
    || !(value.taskBinding === null || (
      typeof value.taskBinding === 'object'
      && value.taskBinding !== null
      && /^TASK-[0-9]{8}-[0-9]{6}$/u.test(value.taskBinding.taskId)
      && typeof value.taskBinding.runId === 'string'
      && value.taskBinding.runId.trim() === value.taskBinding.runId
      && value.taskBinding.runId.length > 0
      && typeof value.taskBinding.receiptId === 'string'
      && value.taskBinding.receiptId.trim() === value.taskBinding.receiptId
      && value.taskBinding.receiptId.length > 0
    ))
    || (value.spawnObservedAt != null && (
      typeof value.spawnObservedAt !== 'string'
      || !Number.isFinite(Date.parse(value.spawnObservedAt))
    ))
  ) {
    throw new Error(`Codex lifecycle record '${path.basename(file)}' is invalid`);
  }
  if (expectedTaskId && value.taskBinding?.taskId !== expectedTaskId) {
    throw new Error('Codex lifecycle record belongs to a different task');
  }
  return Object.freeze({ ...value, spawnObservedAt: value.spawnObservedAt ?? null });
}

function recordFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => path.join(root, name));
}

function hasActiveCodexLifecycleEvidence(
  root: string,
  query: ActiveCodexLifecycleEvidenceQuery
): boolean {
  return recordFiles(root).map((file) => readRecord(file)).some((record) => {
    const evidence = record.state.startEvidence;
    return record.consumer === null
      && ['start-ready', 'observed-terminal', 'stop-ready'].includes(record.state.status)
      && evidence?.nativeAgent === query.nativeAgent
      && evidence.hookDefinitionHash === query.hookDefinitionHash;
  });
}

function writeRecord(file: string, record: StoredCodexLifecycle, expectedRevision: number, expectedTaskId?: string): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
  try {
    const actualRevision = fs.existsSync(file) ? readRecord(file, expectedTaskId).revision : 0;
    if (actualRevision !== expectedRevision) {
      throw new Error(`Codex lifecycle revision changed from ${expectedRevision} to ${actualRevision}`);
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function createCodexLifecycleStore(options: CodexLifecycleStoreOptions) {
  if (options.taskId !== undefined && !/^TASK-[0-9]{8}-[0-9]{6}$/u.test(options.taskId)) {
    throw new Error('Codex lifecycle store task id is invalid');
  }
  const root = options.root ?? '';
  if (!root) throw new Error('Codex lifecycle store root is required');
  const now = options.now ?? (() => new Date().toISOString());

  function withWriteLock<T>(operation: () => T): T {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const lock = path.join(root, '.write.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let descriptor: number | null = null;
    while (descriptor === null) {
      try {
        descriptor = fs.openSync(lock, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw lockError;
        }
        if (Date.now() >= deadline) throw new Error('Codex lifecycle store is busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }
    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  }

  function findByChild(childThreadId: string): string[] {
    return recordFiles(root).filter((file) => {
      const child = readRecord(file, options.taskId).state.child;
      return child?.childThreadId === childThreadId;
    });
  }

  function locate(event: CodexLifecycleEvent): string {
    if (event.type === 'hook-spawn') {
      return path.join(root, `${digest(`${event.sessionId}\0${event.turnId}\0${event.toolUseId}`)}.json`);
    }
    if (event.type === 'hook-child') {
      const matches = recordFiles(root).filter((file) => {
        const state = readRecord(file, options.taskId).state;
        return state.spawn?.sessionId === event.parentThreadId
          && state.spawn.nativeAgent === event.nativeAgent
          && (!state.child || state.child.childThreadId === event.childThreadId);
      });
      if (matches.length !== 1) {
        throw new Error(matches.length === 0
          ? 'Codex lifecycle parent session and agent correlation was not found'
          : 'Codex lifecycle parent session and agent correlation is ambiguous');
      }
      return matches[0]!;
    }
    const matches = findByChild(event.childThreadId);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Codex lifecycle child '${event.childThreadId}' was not found`
        : `Codex lifecycle child '${event.childThreadId}' is ambiguous`);
    }
    return matches[0]!;
  }

  function apply(event: CodexLifecycleEvent): CodexLifecycleStoreResult {
    if (event.type === 'hook-spawn' && options.taskId
      && (!event.taskBinding || event.taskBinding.taskId !== options.taskId)) {
      throw new Error('Codex lifecycle spawn task binding does not match its task store');
    }
    if (event.type !== 'hook-spawn') locate(event);
    return withWriteLock(() => {
      const file = locate(event);
      const observedAt = now();
      const binding = event.type === 'hook-spawn' ? event.taskBinding ?? null : null;
      const current = fs.existsSync(file)
        ? readRecord(file, options.taskId)
        : Object.freeze({
            schemaVersion: 2 as const,
            revision: 0,
            taskBinding: binding,
            state: createCodexLifecycleState(options.cliVersion),
            consumer: null,
            consumedAt: null,
            spawnObservedAt: null,
            updatedAt: observedAt
          });
      if (options.taskId && current.taskBinding?.taskId !== options.taskId) {
        throw new Error('Codex lifecycle record belongs to a different task');
      }
      if (current.revision === 0 && !current.taskBinding && options.taskId) {
        throw new Error('Codex lifecycle record has no task binding');
      }
      if (current.revision > 0 && binding && JSON.stringify(current.taskBinding) !== JSON.stringify(binding)) {
        throw new Error('Codex lifecycle task binding does not match the stored spawn');
      }
      if (current.consumer) throw new Error(`Codex lifecycle evidence was already consumed by '${current.consumer}'`);
      const nextState = reduceCodexLifecycleEvent(current.state, event);
      const next = Object.freeze({
        schemaVersion: 2 as const,
        revision: current.revision + 1,
        taskBinding: current.taskBinding,
        state: nextState,
        consumer: null,
        consumedAt: null,
        spawnObservedAt: event.type === 'hook-spawn' && current.revision === 0
          ? observedAt
          : current.spawnObservedAt,
        updatedAt: observedAt
      });
      writeRecord(file, next, current.revision, options.taskId);
      return Object.freeze({ path: file, revision: next.revision, state: next.state });
    });
  }

  function applyToSpawn(
    identity: Readonly<{ sessionId: string; turnId: string; toolUseId: string; taskBinding: CodexLifecycleTaskBinding }>,
    event: Extract<CodexLifecycleEvent, { type: 'hook-child' }>
  ): CodexLifecycleStoreResult {
    const file = path.join(root, `${digest(`${identity.sessionId}\0${identity.turnId}\0${identity.toolUseId}`)}.json`);
    if (!fs.existsSync(file)) throw new Error('Codex lifecycle spawn identity was not found');
    const before = readRecord(file, options.taskId);
    if ((options.taskId && before.taskBinding?.taskId !== options.taskId)
      || JSON.stringify(before.taskBinding) !== JSON.stringify(identity.taskBinding)) {
      throw new Error('Codex lifecycle task binding does not match the stored spawn');
    }
    return withWriteLock(() => {
      const current = readRecord(file, options.taskId);
      if (JSON.stringify(current.taskBinding) !== JSON.stringify(identity.taskBinding)) {
        throw new Error('Codex lifecycle task binding does not match the stored spawn');
      }
      if (current.consumer) throw new Error(`Codex lifecycle evidence was already consumed by '${current.consumer}'`);
      if (
        current.state.spawn?.sessionId !== identity.sessionId
        || current.state.spawn.turnId !== identity.turnId
        || current.state.spawn.toolUseId !== identity.toolUseId
      ) throw new Error('Codex lifecycle spawn identity does not match the stored event');
      const nextState = reduceCodexLifecycleEvent(current.state, event);
      const next = Object.freeze({
        ...current,
        revision: current.revision + 1,
        state: nextState,
        updatedAt: now()
      });
      writeRecord(file, next, current.revision, options.taskId);
      return Object.freeze({ path: file, revision: next.revision, state: next.state });
    });
  }

  function findByParent(parentThreadId: string): readonly StoredCodexLifecycle[] {
    const matches = recordFiles(root)
      .map((file) => readRecord(file, options.taskId))
      .filter((record) => record.state.startEvidence?.parentThreadId === parentThreadId
        && ['start-ready', 'observed-terminal', 'stop-ready'].includes(record.state.status));
    const unconsumed = matches.filter((record) => !record.consumer);
    if (unconsumed.length > 1) throw new Error(`Codex lifecycle parent '${parentThreadId}' has ambiguous active children`);
    if (unconsumed.length === 1) return Object.freeze(unconsumed);
    return Object.freeze(matches
      .filter((record) => record.consumer && record.state.status === 'stop-ready')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  function findByTaskBinding(binding: CodexLifecycleTaskBinding): readonly StoredCodexLifecycle[] {
    return Object.freeze(recordFiles(root)
      .map((file) => readRecord(file, options.taskId))
      .filter((record) => record.taskBinding?.taskId === binding.taskId
        && record.taskBinding.runId === binding.runId
        && record.taskBinding.receiptId === binding.receiptId));
  }

  function read(childThreadId: string): StoredCodexLifecycle {
    const matches = findByChild(childThreadId);
    if (matches.length === 0) throw new Error(`Codex lifecycle child '${childThreadId}' was not found uniquely`);
    if (matches.length > 1) throw new Error(`Codex lifecycle child '${childThreadId}' is ambiguous`);
    return readRecord(matches[0]!, options.taskId);
  }

  function consumeInternal(
    childThreadId: string,
    consumer: string,
    expectedHookDefinitionHash?: string,
    expectedTaskBinding?: CodexLifecycleTaskBinding
  ): StoredCodexLifecycle {
    if (!consumer.trim()) throw new Error('Codex lifecycle consumer is required');
    const preflightMatches = findByChild(childThreadId);
    if (preflightMatches.length !== 1) throw new Error(`Codex lifecycle child '${childThreadId}' was not found uniquely`);
    const preflightRecord = readRecord(preflightMatches[0]!, options.taskId);
    if (expectedTaskBinding && JSON.stringify(preflightRecord.taskBinding) !== JSON.stringify(expectedTaskBinding)) {
      throw new Error('Codex lifecycle task binding does not match the expected receipt');
    }
    return withWriteLock(() => {
      const matches = findByChild(childThreadId);
      if (matches.length !== 1) throw new Error(`Codex lifecycle child '${childThreadId}' was not found uniquely`);
      const file = matches[0]!;
      const current = readRecord(file, options.taskId);
      if (expectedTaskBinding && JSON.stringify(current.taskBinding) !== JSON.stringify(expectedTaskBinding)) {
        throw new Error('Codex lifecycle task binding does not match the expected receipt');
      }
      if (current.consumer) {
        if (current.consumer !== consumer) {
          throw new Error(`Codex lifecycle evidence was already consumed by '${current.consumer}'`);
        }
        if (
          expectedHookDefinitionHash
          && current.state.startEvidence?.hookDefinitionHash !== expectedHookDefinitionHash
        ) throw new Error('Codex lifecycle hook definition hash is stale');
        return current;
      }
      if (current.state.status !== 'stop-ready') throw new Error('Codex lifecycle evidence is not stop-ready');
      if (
        expectedHookDefinitionHash
        && current.state.startEvidence?.hookDefinitionHash !== expectedHookDefinitionHash
      ) throw new Error('Codex lifecycle hook definition hash is stale');
      const next = Object.freeze({
        ...current,
        revision: current.revision + 1,
        consumer,
        consumedAt: now(),
        updatedAt: now()
      });
      writeRecord(file, next, current.revision, options.taskId);
      return next;
    });
  }

  function consume(
    childThreadId: string,
    consumer: string,
    expectedHookDefinitionHash?: string,
    expectedTaskBinding?: CodexLifecycleTaskBinding
  ): StoredCodexLifecycle {
    if (!consumer.trim()) throw new Error('Codex lifecycle consumer is required');
    return consumeInternal(childThreadId, consumer, expectedHookDefinitionHash, expectedTaskBinding);
  }

  function expireBefore(cutoff: string): number {
    return withWriteLock(() => {
      let changed = 0;
      for (const file of recordFiles(root)) {
        const current = readRecord(file, options.taskId);
        if (current.updatedAt >= cutoff) continue;
        if (current.consumer || ['invalid', 'expired', 'stop-ready'].includes(current.state.status)) {
          fs.unlinkSync(file);
          changed += 1;
          continue;
        }
        const expiredState = expireCodexLifecycleState(current.state);
        if (expiredState === current.state) continue;
        writeRecord(file, Object.freeze({
          ...current,
          revision: current.revision + 1,
          state: expiredState,
          updatedAt: now()
        }), current.revision, options.taskId);
        changed += 1;
      }
      return changed;
    });
  }

  return Object.freeze({ taskId: options.taskId ?? null, root, apply, applyToSpawn, consume, expireBefore, findByParent, findByTaskBinding, read });
}

export { createCodexLifecycleStore, hasActiveCodexLifecycleEvidence };
export type {
  ActiveCodexLifecycleEvidenceQuery,
  CodexLifecycleStoreOptions,
  CodexLifecycleStoreResult,
  StoredCodexLifecycle
};
