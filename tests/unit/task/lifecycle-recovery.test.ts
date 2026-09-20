import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  activateOrchestrationDelegation,
  beginOrResumeOrchestration,
  dispatchOrchestrationDelegation,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  readRun
} from '../../../lib/task/orchestration.ts';
import {
  recoverStartedLifecycleUnderLock
} from '../../../lib/agent-clients/adapters/codex-lifecycle/recovery.ts';
import type { LifecycleRecoveryOptions } from '../../../lib/agent-clients/adapters/codex-lifecycle/recovery.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';
import { writeTask } from '../../../lib/task/write.ts';

const TASK_ID = 'TASK-20260101-000001';
const MODEL_POLICY = {
  executor: { model: 'executor-model', reasoningEffort: 'high' },
  reviewer: { model: 'review-model', reasoningEffort: 'high' }
} as const;
const PROVENANCE = {
  protocolVersion: 3,
  packageVersion: '0.9.16-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64),
  hookDefinitionHash: 'hook-hash',
  hookSource: 'project' as const,
  hookSourcePathDigest: 'c'.repeat(64),
  hookSourceHash: 'd'.repeat(64),
  capabilitySessionId: 'parent',
  capabilityTurnId: 'parent-turn',
  capabilityToolUseId: 'capability-tool',
  controllerInstanceDigest: 'e'.repeat(64),
  controlGeneration: 'generation-1'
} as const;

function fixture(stopReady = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-recovery-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\ncurrent_step: requirement-analysis\nassigned_to: codex\nupdated_at: old\nagent_infra_version: v0.9.16-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n`);
  const store = createCodexLifecycleStore({
    root: path.join(root, 'runtime-lifecycle'),
    cliVersion: '0.147.0',
    now: () => '2026-01-01T00:00:00.200Z'
  });
  store.apply({ type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool', nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hook-hash', requestedModel: 'executor-model', requestedReasoningEffort: 'high' });
  store.apply({ type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child', parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' });
  store.apply({ type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null, sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' });
  store.apply({ type: 'app-settings', childThreadId: 'child', model: 'executor-model', reasoningEffort: 'high' });
  if (stopReady) {
    store.apply({ type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed' });
    store.apply({ type: 'hook-stop', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child', nativeAgent: 'agent-infra-lifecycle-executor' });
  }

  assert.equal(beginOrResumeOrchestration(TASK_ID, {
    repoRoot: root, client: 'codex', modelPolicy: MODEL_POLICY,
    id: () => 'run-1', now: () => '2026-01-01T00:00:00.000Z'
  }).status, 'running');
  assert.equal(prepareOrchestrationDelegation(TASK_ID, {
    client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'high', lifecycleProvenance: PROVENANCE
  }, {
    repoRoot: root, supportsLifecycleDelegation: () => true, captureWorkspace: () => 'before-tree',
    id: () => 'receipt-1', now: () => '2026-01-01T00:00:00.100Z', monotonicNow: () => 10
  }).status, 'running');
  assert.equal(dispatchOrchestrationDelegation(TASK_ID, {
    repoRoot: root, now: () => '2026-01-01T00:00:00.150Z', monotonicNow: () => 20
  }).status, 'running');
  assert.equal(activateOrchestrationDelegation(TASK_ID, {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child', parentId: 'parent', spawnMode: 'fresh',
    actualModel: 'executor-model', actualReasoningEffort: 'high',
    hostEvidence: { kind: 'codex-lifecycle-v2', startRevision: 4, ...PROVENANCE, spawnToolUseId: 'spawn-tool', spawnObservedAt: '2026-01-01T00:00:00.200Z' }
  }, {
    repoRoot: root, now: () => '2026-01-01T00:00:00.300Z', monotonicNow: () => 30
  }).status, 'running');
  fs.appendFileSync(path.join(taskDir, 'task.md'), '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started\n');
  return { root, taskDir, store };
}

const request = { taskRef: TASK_ID, intent: 'recover-started' as const, agent: 'codex', auto: true as const };

function recover(f: ReturnType<typeof fixture>, options: LifecycleRecoveryOptions = {}) {
  return withTaskExecutionLock(f.root, TASK_ID, 'test.recover-started', () => recoverStartedLifecycleUnderLock(
    request,
    { repoRoot: f.root, lifecycleStore: f.store, ...options }
  ));
}

function cleanup(f: ReturnType<typeof fixture>) {
  fs.rmSync(f.root, { recursive: true, force: true });
}

test('automatic recovery consumes trusted stop evidence and closes the activated delegation', () => {
  const f = fixture();
  try {
    const recovered = recover(f);
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(recovered.receiptId, 'receipt-1');
    const run = readRun(f.taskDir)!;
    assert.equal(run.pendingDelegation, null);
    assert.equal(run.receipts.length, 1);
    assert.equal(run.receipts[0]!.status, 'aborted');
    assert.equal(run.receipts[0]!.hostEvidence?.consumer, 'receipt-1');
    assert.equal(f.store.read('child').consumer, 'receipt-1');
    const content = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.match(content, /Analyze Task \(Round 1\) \[aborted\].*receipt=receipt-1; child=child/u);
  } finally { cleanup(f); }
});

test('automatic recovery is idempotent after receipt and log completion', () => {
  const f = fixture();
  try {
    assert.equal(recover(f).status, 'applied');
    assert.equal(recover(f).status, 'no-op');
    const content = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.equal((content.match(/\[aborted\]/gu) ?? []).length, 1);
    assert.equal(readRun(f.taskDir)?.receipts.length, 1);
  } finally { cleanup(f); }
});

test('automatic recovery retries only the missing log after the run was saved', () => {
  const f = fixture();
  const failedWrite = {
    status: 'failed', requestRef: TASK_ID, expectedState: 'active', taskId: TASK_ID,
    taskMdPath: null, actualState: 'active', changed: false, operations: [], timestamp: null,
    agentInfraVersion: null, error: { code: 'TASK_READ_FAILED', message: 'injected log failure' }
  } as ReturnType<typeof writeTask>;
  try {
    const first = recover(f, { writeTask: () => failedWrite });
    assert.equal(first.error?.code, 'RECOVERY_LOG_WRITE_FAILED');
    assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
    assert.equal(readRun(f.taskDir)?.receipts.length, 1);
    const second = recover(f);
    assert.equal(second.status, 'applied', JSON.stringify(second));
    assert.equal(recover(f).status, 'no-op');
  } finally { cleanup(f); }
});

test('automatic recovery fails closed while stop evidence is incomplete', () => {
  const f = fixture(false);
  try {
    const recovered = recover(f);
    assert.equal(recovered.status, 'owner-unknown');
    assert.equal(recovered.error?.code, 'RECOVERY_STOP_EVIDENCE_INVALID');
    assert.equal(readRun(f.taskDir)?.pendingDelegation?.status, 'activated');
    assert.equal(f.store.read('child').consumer, null);
  } finally { cleanup(f); }
});

test('automatic recovery rejects stop evidence consumed by another receipt', () => {
  const f = fixture();
  try {
    f.store.consume('child', 'other-receipt', 'hook-hash');
    const recovered = recover(f);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.error?.code, 'RECOVERY_CONSUMER_CONFLICT');
    assert.equal(readRun(f.taskDir)?.pendingDelegation?.status, 'activated');
  } finally { cleanup(f); }
});

test('automatic recovery preserves an unrelated orchestration pause', () => {
  const f = fixture();
  try {
    assert.equal(pauseOrchestration(TASK_ID, 'UNRELATED', 'stop', true, { repoRoot: f.root }).status, 'paused');
    const recovered = recover(f);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.error?.code, 'RECOVERY_ORCHESTRATION_INVALID');
    assert.equal(readRun(f.taskDir)?.pause?.code, 'UNRELATED');
  } finally { cleanup(f); }
});

test('automatic recovery is a no-op when no orchestration run exists', () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.taskDir, 'orchestration.json'));
    assert.deepEqual(recover(f), {
      status: 'no-op', changed: false, targetState: 'active', requestRef: TASK_ID,
      intent: 'recover-started', taskId: TASK_ID, receiptId: null, childId: null, error: null
    });
  } finally { cleanup(f); }
});
