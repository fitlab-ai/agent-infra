import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  createCodexLifecycleStore,
  hasActiveCodexLifecycleEvidence
} from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  beginOrResumeOrchestration,
  dispatchOrchestrationDelegation,
  prepareOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';

const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-store-'));
  fixtureRoots.add(root);
  return root;
}

function preparedTask(now?: () => string) {
  const root = temporaryRoot();
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\ncurrent_step: requirement-analysis\nagent_infra_version: v0.9.12-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  const policy = {
    executor: { model: 'model', reasoningEffort: 'high' },
    reviewer: { model: 'model', reasoningEffort: 'high' }
  } as const;
  beginOrResumeOrchestration(taskId, { repoRoot: root, client: 'codex', modelPolicy: policy, id: () => 'run-1' });
  prepareOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'model', requestedReasoningEffort: 'high'
  }, {
    repoRoot: root, supportsLifecycleDelegation: () => true, captureWorkspace: () => 'before', id: () => 'receipt-1'
  });
  dispatchOrchestrationDelegation(taskId, { repoRoot: root });
  return {
    root,
    taskId,
    taskDir,
    store: createCodexLifecycleStore({ repoRoot: root, taskId, cliVersion: '0.147.0', now })
  };
}

test('Codex lifecycle store persists only normalized evidence and consumes once', () => {
  let now = '2026-08-14T00:00:00.500Z';
  const f = preparedTask(() => now);
  const { taskDir, store } = f;
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-reviewer', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  });
  now = '2026-08-14T00:00:01.000Z';
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  store.apply({
    type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent',
    forkedFromId: null, sourceParentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  const record = store.apply({
    type: 'app-settings', childThreadId: 'child', model: 'model', reasoningEffort: 'high'
  });
  assert.equal(record.state.status, 'start-ready');
  assert.equal(
    (store.read('child') as ReturnType<typeof store.read> & { spawnObservedAt?: string }).spawnObservedAt,
    '2026-08-14T00:00:00.500Z'
  );
  assert.equal(hasActiveCodexLifecycleEvidence(taskDir, {
    hookDefinitionHash: 'hash'
  }), true);

  const raw = fs.readFileSync(record.path, 'utf8');
  assert.equal(raw.includes('prompt'), false);
  assert.equal(raw.includes('transcript'), false);
  assert.equal(record.path, path.join(taskDir, '.runtime', 'orchestration.json'));

  store.apply({
    type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed'
  });
  store.apply({
    type: 'hook-stop', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  assert.throws(() => store.consume('child', 'receipt-1', 'stale-hash'), /hash is stale/);
  const consumed = store.consume('child', 'receipt-1', 'hash');
  assert.equal(consumed.consumer, 'receipt-1');
  assert.equal(hasActiveCodexLifecycleEvidence(taskDir, {
    hookDefinitionHash: 'hash'
  }), false);
  assert.equal(store.findByParent('parent')[0]?.consumer, 'receipt-1');
  assert.deepEqual(store.consume('child', 'receipt-1', 'hash'), consumed);
  assert.throws(() => store.consume('child', 'receipt-2'), /already consumed/);
});

test('Codex lifecycle store rejects ambiguous parent session and agent correlation', () => {
  const { store } = preparedTask();
  for (const toolUseId of ['tool-a', 'tool-b']) {
    store.apply({
      type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId,
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
    });
  }
  assert.throws(() => store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }), /ambiguous/);
});

test('Codex lifecycle adapter keeps the first spawn observation across replay in the task run', () => {
  let now = '2026-08-14T00:00:00.500Z';
  const { taskDir, store } = preparedTask(() => now);
  const event = {
    type: 'hook-spawn' as const, sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash'
  };
  const first = store.apply(event);

  now = '2026-08-14T00:00:01.000Z';
  store.apply(event);
  const run = JSON.parse(fs.readFileSync(first.path, 'utf8'));
  const record = Object.values(run.pendingDelegation.adapterEvidence.codex.records)[0] as Record<string, unknown>;
  assert.equal(record.spawnObservedAt, '2026-08-14T00:00:00.500Z');
  assert.equal(path.dirname(first.path), path.join(taskDir, '.runtime'));
});

test('Codex lifecycle store correlates a real child session through its host-resolved parent', () => {
  const { store } = preparedTask();
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  });

  const result = store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
  });

  assert.equal(result.state.status, 'observed-child');
  assert.equal(result.state.child?.sessionId, 'parent');
});

test('Codex lifecycle store refuses identity and replay conflicts before persisting child or resolve evidence', () => {
  const f = preparedTask();
  const taskId = 'TASK-20260101-000001';
  const binding = { taskId, runId: 'run-1', receiptId: 'receipt-1' };
  const store = f.store;
  const spawn = store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash', taskBinding: binding
  });
  const identity = { sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool', taskBinding: binding };
  const original = {
    type: 'hook-child' as const, sessionId: 'parent', turnId: 'original-child-turn', childThreadId: 'child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook' as const
  };
  const accepted = store.applyToSpawn(identity, original, spawn.revision);
  const bytesBeforeReplay = fs.readFileSync(accepted.path);
  assert.throws(() => store.applyToSpawn(identity, { ...original, turnId: 'wrong-child-turn' }, accepted.revision), /CODEX_EVIDENCE_REPLAY_CONFLICT/u);
  assert.deepEqual(fs.readFileSync(accepted.path), bytesBeforeReplay);
  assert.throws(() => store.applyToSpawn(identity, { ...original, nativeAgent: 'agent-infra-lifecycle-reviewer' }, accepted.revision), /spawn identity does not match/u);
  assert.deepEqual(fs.readFileSync(accepted.path), bytesBeforeReplay);
  assert.equal(store.read('child').state.status, 'observed-child');
  assert.equal(store.read('child').revision, accepted.revision);

  assert.throws(() => store.applyToSpawn(identity, { ...original, turnId: 'stale-writer-turn' }, spawn.revision), /revision changed/u);
  assert.deepEqual(fs.readFileSync(accepted.path), bytesBeforeReplay);

  assert.throws(() => store.apply({
    type: 'app-thread', childThreadId: 'child', parentThreadId: 'wrong-parent', forkedFromId: null,
    sourceParentThreadId: 'wrong-parent', nativeAgent: 'agent-infra-lifecycle-executor'
  }), /CODEX_EVIDENCE_PARENT_MISMATCH/u);
  assert.deepEqual(fs.readFileSync(accepted.path), bytesBeforeReplay);
});

test('Codex lifecycle store keeps legal parent-rollout to hook conversion and exact child replay valid', () => {
  const f = preparedTask();
  const taskId = 'TASK-20260101-000001';
  const binding = { taskId, runId: 'run-1', receiptId: 'receipt-1' };
  const store = f.store;
  const spawn = store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash', taskBinding: binding
  });
  const identity = { sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool', taskBinding: binding };
  const rollout = store.applyToSpawn(identity, {
    type: 'hook-child', sessionId: 'parent', turnId: 'rollout-child-turn', childThreadId: 'child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'parent-rollout'
  }, spawn.revision);
  const hook = store.applyToSpawn(identity, {
    type: 'hook-child', sessionId: 'parent', turnId: 'hook-child-turn', childThreadId: 'child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook'
  }, rollout.revision);
  assert.equal(hook.state.status, 'observed-child');
  assert.equal(hook.state.child?.turnId, 'hook-child-turn');
  assert.equal(hook.state.child?.source, 'hook');

  const hookBytes = fs.readFileSync(hook.path);
  const replay = store.applyToSpawn(identity, hook.state.child!, hook.revision);
  assert.equal(replay.state.status, 'observed-child');
  assert.equal(replay.state.child?.turnId, 'hook-child-turn');
  assert.equal(replay.state.child?.source, 'hook');
  assert.equal(replay.revision, hook.revision);
  assert.deepEqual(fs.readFileSync(replay.path), hookBytes);
});

test('Codex lifecycle store marks stale active evidence expired before cleanup', () => {
  let now = '2026-08-13T00:00:00.000Z';
  const { store } = preparedTask(() => now);
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash'
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-executor'
  });

  now = '2026-08-13T01:00:00.000Z';
  assert.equal(store.expireBefore('2026-08-13T00:30:00.000Z'), 1);
  assert.equal(store.read('child').state.status, 'expired');
  assert.throws(() => store.consume('child', 'receipt'), /not stop-ready/);

  now = '2026-08-13T02:00:00.000Z';
  assert.equal(store.expireBefore('2026-08-13T01:30:00.000Z'), 0);
  assert.equal(store.read('child').state.status, 'expired');
});
