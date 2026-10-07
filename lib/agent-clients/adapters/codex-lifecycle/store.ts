import crypto from 'node:crypto';
import path from 'node:path';

import {
  mutateDelegationAdapterEvidence,
  mutateDelegationAdapterEvidenceWithinTaskLock,
  readRun
} from '../../../task/orchestration.ts';
import type { DelegationReceipt } from '../../../task/delegation-receipts.ts';
import { resolveTaskRef } from '../../../task/resolve-ref.ts';
import {
  createCodexLifecycleState,
  expireCodexLifecycleState,
  reduceCodexLifecycleEvent
} from './evidence.ts';
import type { CodexLifecycleEvent, CodexLifecycleState } from './evidence.ts';
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

type CodexLifecycleActivationEvidence = Readonly<{
  kind: 'codex-lifecycle-v2';
  hookDefinitionHash: string;
  startRevision: number;
  protocolVersion?: number;
  packageVersion?: string;
  internalExecutableBuildHash?: string;
  lifecycleContractHash?: string;
  hookSource?: 'project' | 'managed' | 'isolated-user';
  hookSourcePathDigest?: string;
  hookSourceHash?: string;
  capabilitySessionId?: string;
  capabilityTurnId?: string;
  capabilityToolUseId?: string;
  spawnToolUseId?: string;
  spawnObservedAt?: string;
  controllerInstanceDigest?: string | null;
  controlGeneration?: string | null;
}>;

type CodexAdapterState = Readonly<{
  records: Readonly<Record<string, StoredCodexLifecycle>>;
  activationEvidence?: CodexLifecycleActivationEvidence;
}>;

type CodexLifecycleStoreOptions = Readonly<{
  repoRoot?: string;
  taskId: string;
  cliVersion: string;
  now?: () => string;
}>;

type CodexLifecycleStoreResult = Readonly<{
  path: string;
  revision: number;
  state: CodexLifecycleState;
}>;

type ActiveCodexLifecycleEvidenceQuery = Readonly<{
  hookDefinitionHash: string;
  identity?: Readonly<{ sessionId: string; turnId: string; toolUseId: string }>;
}>;

function readCodexLifecycleActivationEvidence(receipt: DelegationReceipt): CodexLifecycleActivationEvidence | null {
  const state = storedEvidence(receipt.adapterEvidence?.codex);
  return state.activationEvidence && typeof state.activationEvidence === 'object'
    ? state.activationEvidence
    : null;
}

const NON_PERSISTENT_FAILURES = new Set([
  'CODEX_EVIDENCE_IDENTITY_MISMATCH',
  'CODEX_EVIDENCE_PARENT_MISMATCH',
  'CODEX_EVIDENCE_REPLAY_CONFLICT'
]);

function recordKey(sessionId: string, turnId: string, toolUseId: string): string {
  return crypto.createHash('sha256').update(`${sessionId}\0${turnId}\0${toolUseId}`).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedEvidence(value: unknown): CodexAdapterState {
  if (!isRecord(value) || !isRecord(value.records)) return Object.freeze({ records: Object.freeze({}) });
  return value as unknown as CodexAdapterState;
}

function receipts(taskDir: string): readonly DelegationReceipt[] {
  const run = readRun(taskDir);
  return run ? Object.freeze([...run.receipts, ...(run.pendingDelegation ? [run.pendingDelegation] : [])]) : [];
}

function allRecords(taskDir: string): readonly StoredCodexLifecycle[] {
  return Object.freeze(receipts(taskDir).flatMap((receipt) => {
    const state = storedEvidence(receipt.adapterEvidence?.codex);
    return Object.values(state.records);
  }));
}

function lifecyclePath(taskDir: string): string {
  return path.join(taskDir, '.runtime', 'orchestration.json');
}

function assertCurrentCanApply(
  current: StoredCodexLifecycle,
  binding: CodexLifecycleTaskBinding | null
): void {
  if (current.revision > 0 && binding && JSON.stringify(current.taskBinding) !== JSON.stringify(binding)) {
    throw new Error('Codex lifecycle task binding does not match the stored spawn');
  }
  if (current.consumer) throw new Error(`Codex lifecycle evidence was already consumed by '${current.consumer}'`);
}

function hasActiveCodexLifecycleEvidence(
  taskDir: string,
  query: ActiveCodexLifecycleEvidenceQuery
): boolean {
  return allRecords(taskDir).some((record) => {
    return record.consumer === null
      && !['invalid', 'expired'].includes(record.state.status)
      && record.state.spawn?.hookDefinitionHash === query.hookDefinitionHash
      && (!query.identity || record.state.spawn?.sessionId === query.identity.sessionId
        && record.state.spawn.turnId === query.identity.turnId
        && record.state.spawn.toolUseId === query.identity.toolUseId);
  });
}

function createCodexLifecycleStore(options: CodexLifecycleStoreOptions) {
  if (!/^TASK-[0-9]{8}-[0-9]{6}$/u.test(options.taskId)) {
    throw new Error('Codex lifecycle store task id is invalid');
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const resolved = resolveTaskRef(options.taskId, { repoRoot });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  const taskDir = resolved.taskDir;
  const now = options.now ?? (() => new Date().toISOString());

  function currentBinding(): CodexLifecycleTaskBinding {
    const run = readRun(taskDir);
    const receipt = run?.pendingDelegation;
    if (!run || !receipt || receipt.client !== 'codex') {
      throw new Error('Codex lifecycle evidence has no current task delegation');
    }
    return Object.freeze({ taskId: receipt.taskId, runId: receipt.runId, receiptId: receipt.id });
  }

  function findByChild(childThreadId: string): StoredCodexLifecycle[] {
    return allRecords(taskDir).filter((record) => record.state.child?.childThreadId === childThreadId);
  }

  function locate(event: CodexLifecycleEvent): StoredCodexLifecycle {
    if (event.type === 'hook-spawn') {
      const key = recordKey(event.sessionId, event.turnId, event.toolUseId);
      const existing = allRecords(taskDir).find((record) => record.spawnObservedAt && record.state.spawn
        && recordKey(record.state.spawn.sessionId, record.state.spawn.turnId, record.state.spawn.toolUseId) === key);
      return existing ?? Object.freeze({
        schemaVersion: 2,
        revision: 0,
        taskBinding: event.taskBinding ?? null,
        state: createCodexLifecycleState(options.cliVersion),
        consumer: null,
        consumedAt: null,
        spawnObservedAt: null,
        updatedAt: now()
      });
    }
    if (event.type === 'hook-child') {
      const matches = allRecords(taskDir).filter((record) => record.state.spawn?.sessionId === event.parentThreadId
        && record.state.spawn.nativeAgent === event.nativeAgent
        && (!record.state.child || record.state.child.childThreadId === event.childThreadId));
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

  function update(
    binding: CodexLifecycleTaskBinding,
    key: string,
    mutate: (current: StoredCodexLifecycle | null) => StoredCodexLifecycle,
    taskLockHeld = false
  ): StoredCodexLifecycle {
    let result: StoredCodexLifecycle | null = null;
    const updateState = taskLockHeld ? mutateDelegationAdapterEvidenceWithinTaskLock : mutateDelegationAdapterEvidence;
    updateState(options.taskId, binding.receiptId, 'codex', (value) => {
      const currentState = storedEvidence(value);
      const current = currentState.records[key] ?? null;
      result = mutate(current);
      return Object.freeze({
        ...currentState,
        records: Object.freeze({ ...currentState.records, [key]: result })
      });
    }, { repoRoot, now });
    if (!result) throw new Error('Codex lifecycle record was not updated');
    return result;
  }

  function apply(event: CodexLifecycleEvent): CodexLifecycleStoreResult {
    const existing = event.type === 'hook-spawn' ? null : locate(event);
    const binding = event.type === 'hook-spawn' ? event.taskBinding ?? currentBinding() : existing?.taskBinding;
    if (!binding) throw new Error('Codex lifecycle event has no task receipt binding');
    const key = event.type === 'hook-spawn'
      ? recordKey(event.sessionId, event.turnId, event.toolUseId)
      : existing?.state.spawn
        ? recordKey(existing.state.spawn.sessionId, existing.state.spawn.turnId, existing.state.spawn.toolUseId)
        : '';
    const observedAt = now();
    const next = update(binding, key, (current) => {
      const base = current ?? Object.freeze({
        schemaVersion: 2 as const,
        revision: 0,
        taskBinding: binding,
        state: createCodexLifecycleState(options.cliVersion),
        consumer: null,
        consumedAt: null,
        spawnObservedAt: null,
        updatedAt: observedAt
      });
      assertCurrentCanApply(base, binding);
      const state = reduceCodexLifecycleEvent(base.state, event);
      if (state.status === 'invalid' && state.error && NON_PERSISTENT_FAILURES.has(state.error.code)) {
        throw new Error(`${state.error.code}: ${state.error.message}`);
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        state,
        spawnObservedAt: event.type === 'hook-spawn' && base.revision === 0 ? observedAt : base.spawnObservedAt,
        updatedAt: observedAt
      });
    });
    return Object.freeze({ path: lifecyclePath(taskDir), revision: next.revision, state: next.state });
  }

  function applyToSpawn(
    identity: Readonly<{ sessionId: string; turnId: string; toolUseId: string; taskBinding: CodexLifecycleTaskBinding }>,
    event: Extract<CodexLifecycleEvent, { type: 'hook-child' }>,
    expectedRevision: number
  ): CodexLifecycleStoreResult {
    const key = recordKey(identity.sessionId, identity.turnId, identity.toolUseId);
    const current = allRecords(taskDir).find((record) => record.state.spawn
      && recordKey(record.state.spawn.sessionId, record.state.spawn.turnId, record.state.spawn.toolUseId) === key);
    if (!current) throw new Error('Codex lifecycle spawn identity was not found');
    const next = update(identity.taskBinding, key, (latest) => {
      if (!latest || JSON.stringify(latest.taskBinding) !== JSON.stringify(identity.taskBinding)) {
        throw new Error('Codex lifecycle task binding does not match the stored spawn');
      }
      if (latest.revision !== expectedRevision) {
        throw new Error(`Codex lifecycle revision changed from ${expectedRevision} to ${latest.revision}`);
      }
      if (latest.consumer) throw new Error(`Codex lifecycle evidence was already consumed by '${latest.consumer}'`);
      if (latest.state.spawn?.sessionId !== identity.sessionId
        || latest.state.spawn.turnId !== identity.turnId
        || latest.state.spawn.toolUseId !== identity.toolUseId
        || latest.state.spawn.nativeAgent !== event.nativeAgent
        || event.sessionId !== identity.sessionId
        || event.parentThreadId !== identity.sessionId) {
        throw new Error('Codex lifecycle spawn identity does not match the stored event');
      }
      const state = reduceCodexLifecycleEvent(latest.state, event);
      if (state.status === 'invalid' && state.error && NON_PERSISTENT_FAILURES.has(state.error.code)) {
        throw new Error(`${state.error.code}: ${state.error.message}`);
      }
      return state === latest.state ? latest : Object.freeze({ ...latest, revision: latest.revision + 1, state, updatedAt: now() });
    });
    return Object.freeze({ path: lifecyclePath(taskDir), revision: next.revision, state: next.state });
  }

  function findByParent(parentThreadId: string): readonly StoredCodexLifecycle[] {
    const matches = allRecords(taskDir).filter((record) => record.state.startEvidence?.parentThreadId === parentThreadId
      && ['start-ready', 'observed-terminal', 'stop-ready'].includes(record.state.status));
    const unconsumed = matches.filter((record) => !record.consumer);
    if (unconsumed.length > 1) throw new Error(`Codex lifecycle parent '${parentThreadId}' has ambiguous active children`);
    return Object.freeze(unconsumed.length === 1 ? unconsumed : matches.filter((record) => record.consumer));
  }

  function findByTaskBinding(binding: CodexLifecycleTaskBinding): readonly StoredCodexLifecycle[] {
    return Object.freeze(allRecords(taskDir).filter((record) => record.taskBinding?.runId === binding.runId
      && record.taskBinding.receiptId === binding.receiptId));
  }

  function read(childThreadId: string): StoredCodexLifecycle {
    const matches = findByChild(childThreadId);
    if (matches.length !== 1) throw new Error(`Codex lifecycle child '${childThreadId}' was not found uniquely`);
    return matches[0]!;
  }

  function consume(
    childThreadId: string,
    consumer: string,
    expectedHookDefinitionHash?: string,
    expectedTaskBinding?: CodexLifecycleTaskBinding
  ): StoredCodexLifecycle {
    if (!consumer.trim()) throw new Error('Codex lifecycle consumer is required');
    const current = read(childThreadId);
    const binding = expectedTaskBinding ?? current.taskBinding;
    if (!binding) throw new Error('Codex lifecycle task receipt binding is missing');
    const spawn = current.state.spawn;
    if (!spawn) throw new Error('Codex lifecycle spawn evidence is missing');
    const key = recordKey(spawn.sessionId, spawn.turnId, spawn.toolUseId);
    return update(binding, key, (latest) => {
      if (!latest || expectedTaskBinding && JSON.stringify(latest.taskBinding) !== JSON.stringify(expectedTaskBinding)) {
        throw new Error('Codex lifecycle task binding does not match the expected receipt');
      }
      if (latest.consumer && latest.consumer !== consumer) {
        throw new Error(`Codex lifecycle evidence was already consumed by '${latest.consumer}'`);
      }
      if (latest.state.status !== 'stop-ready') throw new Error('Codex lifecycle evidence is not stop-ready');
      if (expectedHookDefinitionHash && latest.state.startEvidence?.hookDefinitionHash !== expectedHookDefinitionHash) {
        throw new Error('Codex lifecycle hook definition hash is stale');
      }
      if (latest.consumer) return latest;
      return Object.freeze({ ...latest, revision: latest.revision + 1, consumer, consumedAt: now(), updatedAt: now() });
    });
  }

  function consumeWithinTaskLock(
    childThreadId: string,
    consumer: string,
    expectedHookDefinitionHash?: string,
    expectedTaskBinding?: CodexLifecycleTaskBinding
  ): StoredCodexLifecycle {
    if (!consumer.trim()) throw new Error('Codex lifecycle consumer is required');
    const current = read(childThreadId);
    const binding = expectedTaskBinding ?? current.taskBinding;
    if (!binding || !current.state.spawn) throw new Error('Codex lifecycle task receipt binding is missing');
    const key = recordKey(current.state.spawn.sessionId, current.state.spawn.turnId, current.state.spawn.toolUseId);
    return update(binding, key, (latest) => {
      if (!latest || expectedTaskBinding && JSON.stringify(latest.taskBinding) !== JSON.stringify(expectedTaskBinding)) {
        throw new Error('Codex lifecycle task binding does not match the expected receipt');
      }
      if (latest.consumer && latest.consumer !== consumer) {
        throw new Error(`Codex lifecycle evidence was already consumed by '${latest.consumer}'`);
      }
      if (latest.state.status !== 'stop-ready') throw new Error('Codex lifecycle evidence is not stop-ready');
      if (expectedHookDefinitionHash && latest.state.startEvidence?.hookDefinitionHash !== expectedHookDefinitionHash) {
        throw new Error('Codex lifecycle hook definition hash is stale');
      }
      return latest.consumer ? latest : Object.freeze({ ...latest, revision: latest.revision + 1, consumer, consumedAt: now(), updatedAt: now() });
    }, true);
  }

  function expireBefore(cutoff: string): number {
    let changed = 0;
    for (const record of allRecords(taskDir)) {
      if (record.updatedAt >= cutoff || !record.taskBinding?.receiptId || !record.state.spawn) continue;
      const key = recordKey(record.state.spawn.sessionId, record.state.spawn.turnId, record.state.spawn.toolUseId);
      update(record.taskBinding, key, (latest) => {
        if (!latest || latest.updatedAt >= cutoff || latest.consumer
          || ['invalid', 'expired', 'stop-ready'].includes(latest.state.status)) return latest ?? record;
        const state = expireCodexLifecycleState(latest.state);
        if (state === latest.state) return latest;
        changed += 1;
        return Object.freeze({ ...latest, revision: latest.revision + 1, state, updatedAt: now() });
      });
    }
    return changed;
  }

  return Object.freeze({ taskId: options.taskId, root: path.join(taskDir, '.runtime'), apply, applyToSpawn, consume, consumeWithinTaskLock, expireBefore, findByParent, findByTaskBinding, read });
}

export { createCodexLifecycleStore, hasActiveCodexLifecycleEvidence, readCodexLifecycleActivationEvidence };
export type { ActiveCodexLifecycleEvidenceQuery, CodexLifecycleActivationEvidence, CodexLifecycleStoreOptions, CodexLifecycleStoreResult, StoredCodexLifecycle };
