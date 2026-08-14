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

type StoredCodexLifecycle = Readonly<{
  schemaVersion: 1;
  revision: number;
  state: CodexLifecycleState;
  consumer: string | null;
  consumedAt: string | null;
  updatedAt: string;
}>;

type CodexLifecycleStoreOptions = Readonly<{
  root?: string;
  cliVersion: string;
  now?: () => string;
}>;

type CodexLifecycleStoreResult = Readonly<{
  path: string;
  revision: number;
  state: CodexLifecycleState;
}>;

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readRecord(file: string): StoredCodexLifecycle {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredCodexLifecycle;
  if (
    value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !value.state
    || value.state.schemaVersion !== 1
  ) {
    throw new Error(`Codex lifecycle record '${path.basename(file)}' is invalid`);
  }
  return value;
}

function recordFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => path.join(root, name));
}

function writeRecord(file: string, record: StoredCodexLifecycle, expectedRevision: number): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
  try {
    const actualRevision = fs.existsSync(file) ? readRecord(file).revision : 0;
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
  const root = options.root ?? path.join(process.cwd(), '.agents', 'workspace', '.runtime', 'codex-lifecycle');
  const now = options.now ?? (() => new Date().toISOString());
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);

  function withWriteLock<T>(operation: () => T): T {
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
      const child = readRecord(file).state.child;
      return child?.childThreadId === childThreadId;
    });
  }

  function locate(event: CodexLifecycleEvent): string {
    if (event.type === 'hook-spawn') {
      return path.join(root, `${digest(`${event.sessionId}\0${event.turnId}\0${event.toolUseId}`)}.json`);
    }
    if (event.type === 'hook-child') {
      const matches = recordFiles(root).filter((file) => {
        const state = readRecord(file).state;
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
    return withWriteLock(() => {
      const file = locate(event);
      const current = fs.existsSync(file)
        ? readRecord(file)
        : Object.freeze({
            schemaVersion: 1 as const,
            revision: 0,
            state: createCodexLifecycleState(options.cliVersion),
            consumer: null,
            consumedAt: null,
            updatedAt: now()
          });
      if (current.consumer) throw new Error(`Codex lifecycle evidence was already consumed by '${current.consumer}'`);
      const nextState = reduceCodexLifecycleEvent(current.state, event);
      const next = Object.freeze({
        schemaVersion: 1 as const,
        revision: current.revision + 1,
        state: nextState,
        consumer: null,
        consumedAt: null,
        updatedAt: now()
      });
      writeRecord(file, next, current.revision);
      return Object.freeze({ path: file, revision: next.revision, state: next.state });
    });
  }

  function read(childThreadId: string): StoredCodexLifecycle {
    const matches = findByChild(childThreadId);
    if (matches.length !== 1) throw new Error(`Codex lifecycle child '${childThreadId}' was not found uniquely`);
    return readRecord(matches[0]!);
  }

  function consume(
    childThreadId: string,
    consumer: string,
    expectedHookDefinitionHash?: string
  ): StoredCodexLifecycle {
    if (!consumer.trim()) throw new Error('Codex lifecycle consumer is required');
    return withWriteLock(() => {
      const matches = findByChild(childThreadId);
      if (matches.length !== 1) throw new Error(`Codex lifecycle child '${childThreadId}' was not found uniquely`);
      const file = matches[0]!;
      const current = readRecord(file);
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
      writeRecord(file, next, current.revision);
      return next;
    });
  }

  function expireBefore(cutoff: string): number {
    return withWriteLock(() => {
      let changed = 0;
      for (const file of recordFiles(root)) {
        const current = readRecord(file);
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
        }), current.revision);
        changed += 1;
      }
      return changed;
    });
  }

  return Object.freeze({ root, apply, consume, expireBefore, read });
}

export { createCodexLifecycleStore };
export type {
  CodexLifecycleStoreOptions,
  CodexLifecycleStoreResult,
  StoredCodexLifecycle
};
