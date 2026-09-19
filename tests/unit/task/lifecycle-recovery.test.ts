import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  activateOrchestrationDelegation,
  beginOrResumeOrchestration,
  completeOrchestrationStage,
  dispatchOrchestrationDelegation,
  ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  readRun,
  sealOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';
import {
  readLifecycleRecoveryDomainEvidence,
  recoverStartedLifecycleUnderLock
} from '../../../lib/task/lifecycle-recovery.ts';
import type { LifecycleRecoveryOptions, LifecycleRecoveryRequest } from '../../../lib/task/lifecycle-recovery.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';
import { writeTask } from '../../../lib/task/write.ts';

const TASK_ID = 'TASK-20260101-000001';
const MODEL_POLICY = {
  executor: { model: 'executor-model', reasoningEffort: 'high' },
  reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
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

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-recovery-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  const storeRoot = path.join(root, 'runtime-lifecycle');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\ncurrent_step: requirement-analysis\nassigned_to: codex\nupdated_at: old\nagent_infra_version: v0.9.16-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n`);
  const store = createCodexLifecycleStore({ root: storeRoot, cliVersion: '0.147.0', now: () => '2026-01-01T00:00:00.200Z' });
  store.apply({ type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool', nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hook-hash', requestedModel: 'executor-model', requestedReasoningEffort: 'high' });
  store.apply({ type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child', parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' });
  store.apply({ type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null, sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor' });
  store.apply({ type: 'app-settings', childThreadId: 'child', model: 'executor-model', reasoningEffort: 'high' });
  store.apply({ type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed' });
  store.apply({ type: 'hook-stop', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child', nativeAgent: 'agent-infra-lifecycle-executor' });
  const begin = beginOrResumeOrchestration(TASK_ID, { repoRoot: root, client: 'codex', modelPolicy: MODEL_POLICY, id: () => 'run-1', now: () => '2026-01-01T00:00:00.000Z' });
  assert.equal(begin.status, 'running');
  const prepared = prepareOrchestrationDelegation(TASK_ID, { client: 'codex', requestedModel: 'executor-model', requestedReasoningEffort: 'high', lifecycleProvenance: PROVENANCE }, { repoRoot: root, supportsLifecycleDelegation: () => true, captureWorkspace: () => 'before-tree', id: () => 'receipt-1', now: () => '2026-01-01T00:00:00.100Z', monotonicNow: () => 10 });
  assert.equal(prepared.status, 'running', JSON.stringify(prepared));
  const dispatched = dispatchOrchestrationDelegation(TASK_ID, { repoRoot: root, now: () => '2026-01-01T00:00:00.150Z', monotonicNow: () => 20 });
  assert.equal(dispatched.status, 'running', JSON.stringify(dispatched));
  const activated = activateOrchestrationDelegation(TASK_ID, { nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child', parentId: 'parent', spawnMode: 'fresh', actualModel: 'executor-model', actualReasoningEffort: 'high', hostEvidence: { kind: 'codex-lifecycle-v2', startRevision: 4, ...PROVENANCE, spawnToolUseId: 'spawn-tool', spawnObservedAt: '2026-01-01T00:00:00.200Z' } }, { repoRoot: root, now: () => '2026-01-01T00:00:00.300Z', monotonicNow: () => 30 });
  assert.equal(activated.status, 'running', JSON.stringify(activated));
  fs.appendFileSync(path.join(taskDir, 'task.md'), '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started\n');
  return { root, taskDir, store };
}

const recoveryRequest: LifecycleRecoveryRequest = {
  taskRef: TASK_ID,
  intent: 'recover-started',
  agent: 'codex',
  stage: 'analysis',
  round: 1,
  artifact: 'analysis.md',
  reason: 'native child terminated before result was known'
};

const autoRecoveryRequest: LifecycleRecoveryRequest = {
  taskRef: TASK_ID,
  intent: 'recover-started',
  agent: 'codex',
  auto: true
};

function recover(
  f: ReturnType<typeof fixture>,
  releaseRecovery?: (child: string, consumer: string) => boolean,
  overrides: Partial<LifecycleRecoveryRequest> = {},
  options: Pick<LifecycleRecoveryOptions, 'lifecycleStore' | 'writeTask' | 'verifyRecoveryCommit'> = {}
) {
  return withTaskExecutionLock(path.resolve(f.taskDir, '../../../..'), TASK_ID, 'test.recover-started', () => recoverStartedLifecycleUnderLock(
    { ...recoveryRequest, ...overrides },
    { repoRoot: path.resolve(f.taskDir, '../../../..'), lifecycleStore: f.store, releaseRecovery, ...options }
  ));
}

function recoverAuto(
  f: ReturnType<typeof fixture>,
  releaseRecovery?: (child: string, consumer: string) => boolean
) {
  return withTaskExecutionLock(path.resolve(f.taskDir, '../../../..'), TASK_ID, 'test.recover-started-auto', () => recoverStartedLifecycleUnderLock(
    autoRecoveryRequest,
    { repoRoot: path.resolve(f.taskDir, '../../../..'), lifecycleStore: f.store, releaseRecovery }
  ));
}

test('recover-started auto is not needed before the first orchestration run', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.taskDir, 'orchestration.json'));
    const before = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    const recovered = recoverAuto(f);
    assert.equal(recovered.status, 'no-op');
    assert.equal(recovered.changed, false);
    assert.equal(recovered.stage, null);
    assert.equal(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8'), before);
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      autoRecoveryRequest,
      { ...recovered, targetState: 'active' },
      { lifecycleStore: f.store }
    ), { consistent: true, recovery: true, targetState: 'active', recoveryState: 'not-needed' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started auto leaves completed and non-activated pending runs to orchestration', () => {
  const cases: ReadonlyArray<readonly [string, (f: ReturnType<typeof fixture>) => void]> = [
    ['completed', (f) => {
      const runPath = path.join(f.taskDir, 'orchestration.json');
      const run = JSON.parse(fs.readFileSync(runPath, 'utf8')) as Record<string, unknown>;
      run.status = 'completed';
      run.pendingDelegation = null;
      run.receipts = [];
      fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    }],
    ['prepared', (f) => {
      const runPath = path.join(f.taskDir, 'orchestration.json');
      const run = JSON.parse(fs.readFileSync(runPath, 'utf8')) as { pendingDelegation: Record<string, unknown> };
      Object.assign(run.pendingDelegation, {
        status: 'prepared', parentId: null, childId: null, spawnMode: null, actualModel: null,
        actualReasoningEffort: null, modelFallbackReason: null, reasoningEffortFallbackReason: null,
        agent: null, hostEvidence: null, startEvidenceMonotonicMs: null, activatedMonotonicMs: null,
        activatedAt: null, afterFingerprint: null, changedPaths: [], sealedAt: null, consumedAt: null
      });
      fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    }],
    ['stage-completed', (f) => {
      const completed = completeOrchestrationStage(TASK_ID, {
        stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
      }, { repoRoot: f.root });
      assert.equal(completed.run?.pendingDelegation?.status, 'stage-completed');
    }],
    ['sealed', (f) => {
      completeOrchestrationStage(TASK_ID, {
        stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
      }, { repoRoot: f.root });
      const sealed = sealOrchestrationDelegation(TASK_ID, {
        childId: 'child', exitCode: 0, afterFingerprint: 'after-tree', changedPaths: [],
        hostEvidence: { stopRevision: 6, consumer: 'receipt-1', consumedAt: '2026-01-01T00:00:00.400Z' }
      }, { repoRoot: f.root });
      assert.equal(sealed.run?.pendingDelegation?.status, 'sealed');
    }]
  ];
  for (const [name, setup] of cases) {
    const f = fixture();
    try {
      setup(f);
      const before = fs.readFileSync(path.join(f.taskDir, 'orchestration.json'), 'utf8');
      const recovered = recoverAuto(f);
      assert.equal(recovered.status, 'no-op', name);
      assert.equal(recovered.changed, false, name);
      assert.equal(fs.readFileSync(path.join(f.taskDir, 'orchestration.json'), 'utf8'), before, name);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('recover-started auto rejects a dedicated recovery pause without a transaction', () => {
  const f = fixture();
  try {
    const runPath = path.join(f.taskDir, 'orchestration.json');
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8')) as Record<string, unknown>;
    run.pendingDelegation = null;
    run.receipts = [];
    fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    pauseOrchestration(
      TASK_ID,
      ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
      'recovery transaction did not finish',
      true,
      { repoRoot: f.root }
    );

    const recovered = recoverAuto(f);
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.error?.code, 'RECOVERY_REFERENCE_CONFLICT');
    assert.equal(readRun(f.taskDir)?.pause?.code, ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started auto selects and completes one activated Codex delegation', () => {
  const f = fixture();
  try {
    const recovered = recoverAuto(f);
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(recovered.stage, 'analysis');
    assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      autoRecoveryRequest,
      { ...recovered, targetState: 'active' },
      { lifecycleStore: f.store }
    ), { consistent: true, recovery: true, targetState: 'active', recoveryState: 'released' });
    assert.equal(recoverAuto(f).status, 'no-op');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started auto releases a retained claim before resuming its dedicated pause', () => {
  const f = fixture();
  try {
    const first = recoverAuto(f, () => false);
    assert.equal(first.warning?.code, 'RECOVERY_RELEASE_RETRY_REQUIRED');
    const paused = pauseOrchestration(
      TASK_ID,
      ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
      'RECOVERY_RELEASE_RETRY_REQUIRED: claim retained',
      true,
      { repoRoot: f.root }
    );
    assert.equal(paused.status, 'paused');

    const recovered = recoverAuto(f, (child, consumer) => f.store.releaseRecovery(child, consumer));
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(readRun(f.taskDir)?.status, 'running');
    assert.equal(readRun(f.taskDir)?.pause, null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started auto never clears an unrelated recoverable pause', () => {
  const f = fixture();
  try {
    const first = recoverAuto(f, () => false);
    assert.equal(first.warning?.code, 'RECOVERY_RELEASE_RETRY_REQUIRED');
    pauseOrchestration(TASK_ID, 'OTHER_RECOVERABLE_PAUSE', 'unrelated pause', true, { repoRoot: f.root });

    const recovered = recoverAuto(f, (child, consumer) => f.store.releaseRecovery(child, consumer));
    assert.equal(recovered.status, 'conflict');
    assert.equal(recovered.error?.code, 'RECOVERY_ORCHESTRATION_INVALID');
    assert.equal(readRun(f.taskDir)?.pause?.code, 'OTHER_RECOVERABLE_PAUSE');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started claims, aborts, logs, releases, and replays as no-op', () => {
  const f = fixture();
  try {
    const first = recover(f);
    assert.equal(first.status, 'applied', JSON.stringify(first));
    assert.equal(first.changed, true);
    assert.throws(() => f.store.read('child'), /not found uniquely/u);
    assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
    assert.equal(readRun(f.taskDir)?.receipts[0]?.status, 'aborted');
    const content = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.match(content, /Analyze Task \(Round 1\) \[aborted\]/u);
    assert.match(content, /lifecycle-recovery:v1 /u);
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      recoveryRequest,
      { status: 'applied', changed: true, targetState: 'active' },
      { lifecycleStore: f.store }
    ), { consistent: true, recovery: true, targetState: 'active', recoveryState: 'released' });
    assert.equal(recover(f).status, 'no-op');
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      recoveryRequest,
      { status: 'no-op', changed: false, targetState: 'active' },
      { lifecycleStore: f.store }
    ), { consistent: true, recovery: true, targetState: 'active', recoveryState: 'released' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started fails closed for selector, ownership, orchestration, and ambiguity conflicts', () => {
  const cases: readonly [string, (f: ReturnType<typeof fixture>) => void, string, 'owner-unknown' | 'conflict'][] = [
    ['selector mismatch', () => undefined, 'RECOVERY_SELECTOR_MISMATCH', 'conflict'],
    ['other consumer', (f) => { f.store.consume('child', 'other-consumer'); }, 'RECOVERY_CONSUMER_CONFLICT', 'conflict'],
    ['orchestration missing', (f) => { fs.rmSync(path.join(f.taskDir, 'orchestration.json')); }, 'RECOVERY_ORCHESTRATION_MISSING', 'owner-unknown'],
    ['ambiguous selector', (f) => { fs.appendFileSync(path.join(f.taskDir, 'task.md'), '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started\n'); }, 'RECOVERY_SELECTOR_AMBIGUOUS', 'conflict']
  ];
  for (const [name, run, expected, expectedStatus] of cases) {
    const f = fixture();
    try {
      run(f);
      const result = name === 'selector mismatch' ? recover(f, undefined, { agent: 'claude' }) : recover(f);
      assert.equal(result.error?.code, expected, name);
      assert.equal(result.status, expectedStatus, name);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('recover-started rejects expired, invalid, and tampered durable evidence', () => {
  const cases: readonly [string, (f: ReturnType<typeof fixture>) => void, string, 'owner-unknown' | 'conflict'][] = [
    ['expired stop evidence', (f) => { assert.equal(f.store.expireBefore('2099-01-01T00:00:00.000Z'), 1); }, 'RECOVERY_STOP_EVIDENCE_MISSING', 'owner-unknown'],
    ['invalid store record', (f) => {
      const file = fs.readdirSync(f.store.root).find((entry) => /^[a-f0-9]{64}\.json$/u.test(entry));
      assert.ok(file);
      fs.writeFileSync(path.join(f.store.root, file!), '{invalid\n');
    }, 'RECOVERY_STORE_UNKNOWN', 'owner-unknown'],
    ['duplicate terminal', (f) => {
      const first = recover(f);
      assert.equal(first.status, 'applied');
      const updated = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
      const line = updated.split('\n').find((entry) => entry.includes(' [aborted]') && entry.includes('lifecycle-recovery:v1 '));
      assert.ok(line);
      fs.appendFileSync(path.join(f.taskDir, 'task.md'), `${line}\n`);
    }, 'RECOVERY_SELECTOR_AMBIGUOUS', 'conflict']
  ];
  for (const [name, setup, expected, expectedStatus] of cases) {
    const f = fixture();
    try {
      setup(f);
      const result = recover(f);
      assert.equal(result.error?.code, expected, name);
      assert.equal(result.status, expectedStatus, name);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('recover-started respects task execution lock competition', () => {
  const f = fixture();
  try {
    withTaskExecutionLock(f.root, TASK_ID, 'test-holder', () => {
      assert.throws(() => recover(f), (error: unknown) => (
        error instanceof Error && (error as { code?: string }).code === 'ORCHESTRATION_LOCK_BUSY'
      ));
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started retries release after a terminal mutation whose release failed', () => {
  const f = fixture();
  try {
    const first = recover(f, () => false);
    assert.equal(first.status, 'applied', JSON.stringify(first));
    assert.equal(first.warning?.code, 'RECOVERY_RELEASE_RETRY_REQUIRED');
    assert.notEqual(f.store.read('child').consumer, null);
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      recoveryRequest,
      { status: 'applied', changed: true, targetState: 'active', warning: first.warning },
      { lifecycleStore: f.store }
    ), {
      consistent: true,
      recovery: true,
      targetState: 'active',
      recoveryState: 'retry-required',
      warning: first.warning
    });
    const second = recover(f, (child, consumer) => f.store.releaseRecovery(child, consumer));
    assert.equal(second.status, 'applied');
    assert.throws(() => f.store.read('child'), /not found uniquely/u);
    assert.equal(recover(f).status, 'no-op');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started replays a claim-only cleanup boundary', () => {
  const f = fixture();
  try {
    const consumer = `lifecycle-recovery:${TASK_ID}:receipt-1`;
    const claimed = f.store.claimRecovery('child', TASK_ID, 'receipt-1', 'hook-hash');
    assert.equal(claimed.consumer, consumer);
    assert.equal(f.store.expireBefore('2099-01-01T00:00:00.000Z'), 0);
    assert.equal(f.store.read('child').consumer, consumer);

    const recovered = recover(f);
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(recovered.changed, true);
    assert.throws(() => f.store.read('child'), /not found uniquely/u);
    assert.equal(readRun(f.taskDir)?.receipts.filter((receipt) => receipt.status === 'aborted').length, 1);
    assert.equal((fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8').match(/lifecycle-recovery:v1 /gu) ?? []).length, 1);
    assert.equal(recover(f).status, 'no-op');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started preserves retry evidence after consecutive release failures', () => {
  const f = fixture();
  try {
    const first = recover(f, () => false);
    assert.equal(first.status, 'applied', JSON.stringify(first));
    assert.equal(first.changed, true);
    const second = recover(f, () => false);
    assert.equal(second.status, 'applied', JSON.stringify(second));
    assert.equal(second.changed, false);
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      recoveryRequest,
      { status: 'applied', changed: false, targetState: 'active', warning: second.warning },
      { lifecycleStore: f.store }
    ), {
      consistent: true,
      recovery: true,
      targetState: 'active',
      recoveryState: 'retry-required',
      warning: second.warning
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started replays each persisted boundary without duplicating recovery facts', () => {
  const failedWrite = {
    status: 'failed',
    requestRef: TASK_ID,
    expectedState: 'active',
    taskId: TASK_ID,
    taskMdPath: null,
    actualState: 'active',
    changed: false,
    operations: [],
    timestamp: null,
    agentInfraVersion: null,
    error: { code: 'TASK_READ_FAILED', message: 'injected log write failure' }
  } as ReturnType<typeof writeTask>;

  const beforeLog = fixture();
  try {
    const first = recover(beforeLog, undefined, {}, { writeTask: () => failedWrite });
    assert.equal(first.error?.code, 'RECOVERY_LOG_WRITE_FAILED');
    assert.equal(readRun(beforeLog.taskDir)?.receipts.length, 1);
    const retried = recover(beforeLog);
    assert.equal(retried.status, 'applied', JSON.stringify(retried));
    assert.equal(readRun(beforeLog.taskDir)?.receipts.length, 1);
    assert.equal((fs.readFileSync(path.join(beforeLog.taskDir, 'task.md'), 'utf8').match(/lifecycle-recovery:v1 /gu) ?? []).length, 1);
  } finally {
    fs.rmSync(beforeLog.root, { recursive: true, force: true });
  }

  const beforeRelease = fixture();
  try {
    const first = recover(beforeRelease, undefined, {}, { verifyRecoveryCommit: () => ({ ok: false, message: 'injected commit verification failure' }) });
    assert.equal(first.error?.code, 'RECOVERY_COMMIT_VERIFY_FAILED');
    assert.equal(readRun(beforeRelease.taskDir)?.receipts.length, 1);
    const retried = recover(beforeRelease, () => false);
    assert.equal(retried.status, 'applied', JSON.stringify(retried));
    assert.equal(retried.warning?.code, 'RECOVERY_RELEASE_RETRY_REQUIRED');
    assert.equal(readRun(beforeRelease.taskDir)?.receipts.length, 1);
    assert.equal((fs.readFileSync(path.join(beforeRelease.taskDir, 'task.md'), 'utf8').match(/lifecycle-recovery:v1 /gu) ?? []).length, 1);
    const released = recover(beforeRelease, (child, consumer) => beforeRelease.store.releaseRecovery(child, consumer));
    assert.equal(released.status, 'applied', JSON.stringify(released));
    assert.equal(recover(beforeRelease).status, 'no-op');
  } finally {
    fs.rmSync(beforeRelease.root, { recursive: true, force: true });
  }
});

test('recover-started reports every durable recovery failure code', () => {
  const failedWrite = {
    status: 'failed',
    requestRef: TASK_ID,
    expectedState: 'active',
    taskId: TASK_ID,
    taskMdPath: null,
    actualState: 'active',
    changed: false,
    operations: [],
    timestamp: null,
    agentInfraVersion: null,
    error: { code: 'TASK_READ_FAILED', message: 'log write failed' }
  } as ReturnType<typeof writeTask>;
  type RecoveryTestOptions = Pick<LifecycleRecoveryOptions, 'lifecycleStore' | 'writeTask' | 'verifyRecoveryCommit'>;
  const cases: readonly [string, (f: ReturnType<typeof fixture>) => void, string, 'owner-unknown' | 'conflict', ((f: ReturnType<typeof fixture>) => RecoveryTestOptions)?][] = [
    ['invalid stop evidence', (f) => {
      const file = fs.readdirSync(f.store.root).find((entry) => /^[a-f0-9]{64}\.json$/u.test(entry));
      assert.ok(file);
      const record = JSON.parse(fs.readFileSync(path.join(f.store.root, file!), 'utf8')) as {
        state: { stopEvidence: { hookStopObserved: boolean } };
      };
      record.state.stopEvidence.hookStopObserved = false;
      fs.writeFileSync(path.join(f.store.root, file!), `${JSON.stringify(record)}\n`);
    }, 'RECOVERY_STOP_EVIDENCE_INVALID', 'owner-unknown'],
    ['unknown orchestration', (f) => { fs.writeFileSync(path.join(f.taskDir, 'orchestration.json'), '{invalid\n'); }, 'RECOVERY_ORCHESTRATION_UNKNOWN', 'owner-unknown'],
    ['delegation unavailable', (f) => {
      const file = path.join(f.taskDir, 'orchestration.json');
      const run = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        pendingDelegation: unknown;
        receipts: readonly unknown[];
      };
      run.pendingDelegation = null;
      run.receipts = [];
      fs.writeFileSync(file, `${JSON.stringify(run)}\n`);
    }, 'RECOVERY_DELEGATION_UNAVAILABLE', 'owner-unknown'],
    ['claim failed', () => undefined, 'RECOVERY_CLAIM_FAILED', 'owner-unknown', (f) => ({
      lifecycleStore: {
        ...f.store,
        claimRecovery: () => { throw new Error('claim failed'); }
      } as ReturnType<typeof createCodexLifecycleStore>
    })],
    ['log write failed', () => undefined, 'RECOVERY_LOG_WRITE_FAILED', 'owner-unknown', () => ({ writeTask: () => failedWrite })],
    ['commit verification failed', () => undefined, 'RECOVERY_COMMIT_VERIFY_FAILED', 'owner-unknown', () => ({
      verifyRecoveryCommit: () => ({ ok: false, message: 'commit verification failed' })
    })],
    ['reference conflict', (f) => {
      const first = recover(f, () => false);
      assert.equal(first.status, 'applied');
      const file = path.join(f.taskDir, 'orchestration.json');
      const run = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        receipts: Array<{ hostEvidence: { stopRevision: number } }>;
      };
      run.receipts[0]!.hostEvidence.stopRevision = 999;
      fs.writeFileSync(file, `${JSON.stringify(run)}\n`);
    }, 'RECOVERY_REFERENCE_CONFLICT', 'conflict']
  ];
  for (const [name, setup, expected, expectedStatus, optionsForFixture] of cases) {
    const f = fixture();
    try {
      setup(f);
      const result = recover(f, undefined, {}, optionsForFixture?.(f));
      assert.equal(result.error?.code, expected, name);
      assert.equal(result.status, expectedStatus, name);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});
