import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import { activateOrchestrationDelegation, beginOrResumeOrchestration, dispatchOrchestrationDelegation, prepareOrchestrationDelegation, readRun } from '../../../lib/task/orchestration.ts';
import {
  readLifecycleRecoveryDomainEvidence,
  recoverStartedLifecycleUnderLock
} from '../../../lib/task/lifecycle-recovery.ts';
import type { LifecycleRecoveryRequest } from '../../../lib/task/lifecycle-recovery.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';

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

function recover(
  f: ReturnType<typeof fixture>,
  releaseRecovery?: (child: string, consumer: string) => boolean,
  overrides: Partial<LifecycleRecoveryRequest> = {}
) {
  return withTaskExecutionLock(path.resolve(f.taskDir, '../../../..'), TASK_ID, 'test.recover-started', () => recoverStartedLifecycleUnderLock({ ...recoveryRequest, ...overrides }, { repoRoot: path.resolve(f.taskDir, '../../../..'), lifecycleStore: f.store, releaseRecovery }));
}

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
    ), { consistent: true, recovery: true, targetState: 'active' });
    assert.equal(recover(f).status, 'no-op');
    assert.deepEqual(readLifecycleRecoveryDomainEvidence(
      f.root,
      recoveryRequest,
      { status: 'no-op', changed: false, targetState: 'active' },
      { lifecycleStore: f.store }
    ), { consistent: true, recovery: true, targetState: 'active' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recover-started fails closed for selector, ownership, orchestration, and ambiguity conflicts', () => {
  const cases: readonly [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    ['selector mismatch', () => undefined, 'RECOVERY_SELECTOR_MISMATCH'],
    ['other consumer', (f) => { f.store.consume('child', 'other-consumer'); }, 'RECOVERY_CONSUMER_CONFLICT'],
    ['orchestration missing', (f) => { fs.rmSync(path.join(f.taskDir, 'orchestration.json')); }, 'RECOVERY_ORCHESTRATION_MISSING'],
    ['ambiguous selector', (f) => { fs.appendFileSync(path.join(f.taskDir, 'task.md'), '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started\n'); }, 'RECOVERY_SELECTOR_AMBIGUOUS']
  ];
  for (const [name, run, expected] of cases) {
    const f = fixture();
    try {
      run(f);
      const result = name === 'selector mismatch' ? recover(f, undefined, { agent: 'claude' }) : recover(f);
      assert.equal(result.error?.code, expected, name);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('recover-started rejects expired, invalid, and tampered durable evidence', () => {
  const cases: readonly [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    ['expired stop evidence', (f) => { assert.equal(f.store.expireBefore('2099-01-01T00:00:00.000Z'), 1); }, 'RECOVERY_STOP_EVIDENCE_MISSING'],
    ['invalid store record', (f) => {
      const file = fs.readdirSync(f.store.root).find((entry) => /^[a-f0-9]{64}\.json$/u.test(entry));
      assert.ok(file);
      fs.writeFileSync(path.join(f.store.root, file!), '{invalid\n');
    }, 'RECOVERY_STORE_UNKNOWN'],
    ['duplicate terminal', (f) => {
      const first = recover(f);
      assert.equal(first.status, 'applied');
      const updated = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
      const line = updated.split('\n').find((entry) => entry.includes(' [aborted]') && entry.includes('lifecycle-recovery:v1 '));
      assert.ok(line);
      fs.appendFileSync(path.join(f.taskDir, 'task.md'), `${line}\n`);
    }, 'RECOVERY_SELECTOR_AMBIGUOUS']
  ];
  for (const [name, setup, expected] of cases) {
    const f = fixture();
    try {
      setup(f);
      const result = recover(f);
      assert.equal(result.error?.code, expected, name);
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
    const second = recover(f, (child, consumer) => f.store.releaseRecovery(child, consumer));
    assert.equal(second.status, 'applied');
    assert.throws(() => f.store.read('child'), /not found uniquely/u);
    assert.equal(recover(f).status, 'no-op');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
