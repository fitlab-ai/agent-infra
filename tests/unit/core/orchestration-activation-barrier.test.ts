import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activateOrchestrationDelegation,
  awaitOrchestrationDelegationActivation,
  beginOrResumeOrchestration,
  prepareOrchestrationDelegation,
  readRun,
  recoverPreparedOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';

const taskId = 'TASK-20260101-000001';
const policy = {
  executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
  reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
} as const;

function fixture(monotonicNow: () => number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-barrier-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: ${taskId}
current_step: requirement-analysis
---

# Task
`);
  beginOrResumeOrchestration(taskId, {
    repoRoot: root,
    client: 'claude-code',
    modelPolicy: policy,
    id: () => 'run-1',
    monotonicNow
  });
  const prepared = prepareOrchestrationDelegation(taskId, {
    client: 'claude-code',
    requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: root,
    id: () => 'receipt-1',
    supportsLifecycleDelegation: () => true,
    captureWorkspace: () => 'before',
    monotonicNow
  });
  assert.equal(prepared.run?.pendingDelegation?.status, 'prepared');
  return { root, taskDir };
}

test('activation barrier allows matching activated receipt', async () => {
  let monotonic = 1_000;
  const f = fixture(() => monotonic);
  monotonic = 1_100;
  activateOrchestrationDelegation(taskId, {
    nativeAgent: 'agent-infra-lifecycle-executor',
    childId: 'child',
    parentId: 'parent',
    spawnMode: 'fresh',
    actualModel: 'executor-model',
    actualReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, monotonicNow: () => monotonic });
  const result = await awaitOrchestrationDelegationActivation(taskId, {
    stage: 'analysis',
    round: 1,
    artifact: 'analysis.md',
    role: 'executor'
  }, { repoRoot: f.root, monotonicNow: () => monotonic });
  assert.equal(result.status, 'running');
  assert.equal(result.run?.pendingDelegation?.status, 'activated');
});

test('activation timeout pauses and cannot be revived by late evidence', async () => {
  let monotonic = 1_000;
  const f = fixture(() => monotonic);
  monotonic = 16_001;
  const result = await awaitOrchestrationDelegationActivation(taskId, {
    stage: 'analysis',
    round: 1,
    artifact: 'analysis.md',
    role: 'executor'
  }, {
    repoRoot: f.root,
    monotonicNow: () => monotonic,
    sleep: async () => {}
  });
  assert.equal(result.run?.pause?.code, 'ORCHESTRATION_ACTIVATION_TIMEOUT');
  const late = activateOrchestrationDelegation(taskId, {
    nativeAgent: 'agent-infra-lifecycle-executor',
    childId: 'late-child',
    parentId: 'parent',
    spawnMode: 'fresh',
    actualModel: 'executor-model',
    actualReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, monotonicNow: () => monotonic });
  assert.equal(late.status, 'paused');
  assert.equal(readRun(f.taskDir)?.pause?.code, 'ORCHESTRATION_ACTIVATION_TIMEOUT');
});

test('expired prepared receipt recovers only when workspace is unchanged', () => {
  let monotonic = 1_000;
  const f = fixture(() => monotonic);
  monotonic = 16_001;
  const recovered = recoverPreparedOrchestrationDelegation(taskId, {
    repoRoot: f.root,
    monotonicNow: () => monotonic,
    captureWorkspace: () => 'before'
  });
  assert.equal(recovered.status, 'running');
  assert.equal(recovered.run?.pendingDelegation, null);
  assert.equal(recovered.run?.receipts.at(-1)?.status, 'aborted');
});

test('expired prepared receipt does not recover over active lifecycle evidence', () => {
  let monotonic = 1_000;
  const f = fixture(() => monotonic);
  monotonic = 16_001;
  const blocked = recoverPreparedOrchestrationDelegation(taskId, {
    repoRoot: f.root,
    monotonicNow: () => monotonic,
    captureWorkspace: () => 'before',
    hasActiveLifecycleEvidence: () => true
  });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.error?.code, 'ORCHESTRATION_PREPARED_RECOVERY_ACTIVE_EVIDENCE');
  assert.equal(readRun(f.taskDir)?.pendingDelegation?.status, 'prepared');
});
