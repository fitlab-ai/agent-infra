import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VERIFICATION_CATALOG,
  verifyTaskEvent
} from '../../../lib/task/verification.ts';
import {
  activateDelegation,
  completeDelegationStage,
  consumeDelegation,
  dispatchDelegation,
  prepareDelegation,
  sealDelegation
} from '../../../lib/task/delegation-receipts.ts';

const EXPECTED_EVENTS = [
  'analyze.awaiting-input', 'analyze.completed', 'review-analysis.completed',
  'plan.completed', 'review-plan.completed', 'code.completed', 'review-code.completed',
  'manual-validation.completed', 'validation-run.completed', 'block-task.completed', 'cancel-task.completed',
  'commit.completed', 'complete-task.preflight', 'complete-task.completed',
  'create-pr.completed', 'create-task.completed', 'import-codescan.completed',
  'import-dependabot.completed', 'import-issue.completed', 'watch-pr.completed',
  'review-pr.completed',
  'run-task.paused', 'run-task.completed'
] as const;

const codexLifecycleProvenance = {
  protocolVersion: 3,
  packageVersion: '0.9.9-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64),
  hookDefinitionHash: 'hook-hash',
  hookSource: 'project',
  hookSourcePathDigest: 'c'.repeat(64),
  hookSourceHash: 'd'.repeat(64),
  capabilitySessionId: 'parent-1',
  capabilityTurnId: 'parent-turn',
  capabilityToolUseId: 'capability-tool',
  controllerInstanceDigest: null,
  controlGeneration: null
} as const;

const codexHostEvidence = {
  kind: 'codex-lifecycle-v2',
  hookDefinitionHash: 'hook-hash',
  startRevision: 4,
  stopRevision: 7,
  consumer: 'receipt-1',
  consumedAt: '2026-01-01T00:00:02.000Z',
  protocolVersion: 3,
  packageVersion: '0.9.9-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64),
  hookSource: 'project',
  hookSourcePathDigest: 'c'.repeat(64),
  hookSourceHash: 'd'.repeat(64),
  capabilitySessionId: 'parent-1',
  capabilityTurnId: 'parent-turn',
  spawnToolUseId: 'spawn-tool',
  spawnObservedAt: '2026-01-01T00:00:01.000Z',
  controllerInstanceDigest: null,
  controlGeneration: null
} as const;

function fixture(state: 'active' | 'blocked' | 'completed' = 'active') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verification-unit-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\n---\n`);
  return { root, taskId, taskDir };
}

function currentReceipt(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'receipt-1', taskId, runId: 'run-1', role: 'executor', stage: 'commit',
    round: 1, artifact: 'commit', client: 'claude-code',
    requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
    actualModel: 'executor-model', actualReasoningEffort: 'xhigh',
    modelFallbackReason: null, reasoningEffortFallbackReason: null,
    parentId: 'parent-1', childId: 'child-1', spawnMode: 'fresh', agent: 'claude-code',
    status: 'consumed', workspaceSnapshotScope: 'task', lifecycleProvenance: null,
    hostEvidence: null, beforeFingerprint: 'before', afterFingerprint: 'after', changedPaths: [],
    createdAt: '2026-01-01T00:00:00.000Z', preparedMonotonicMs: 1,
    spawnDispatchMonotonicMs: 2, activationDeadlineMonotonicMs: 3,
    spawnDispatchedAt: '2026-01-01T00:00:00.500Z',
    activationDeadlineAt: '2026-01-01T00:00:15.500Z', startEvidenceMonotonicMs: 2,
    activatedMonotonicMs: 2, activatedAt: '2026-01-01T00:00:01.000Z',
    sealedAt: '2026-01-01T00:00:02.000Z', consumedAt: '2026-01-01T00:00:03.000Z',
    ...overrides
  };
}

function producedCodexReceipt(taskId: string) {
  const prepared = prepareDelegation({
    taskId, runId: 'run-1', role: 'executor', stage: 'commit', round: 1,
    artifact: 'commit', client: 'codex', requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh', workspaceSnapshotScope: 'task',
    lifecycleProvenance: codexLifecycleProvenance, beforeFingerprint: 'before'
  }, {
    id: () => 'receipt-1', now: () => '2026-01-01T00:00:00.000Z',
    monotonicNow: () => 1
  });
  const dispatched = dispatchDelegation(prepared, {
    now: () => '2026-01-01T00:00:00.500Z', monotonicNow: () => 2
  });
  assert.equal(dispatched.ok, true);
  if (!dispatched.ok) throw new Error('failed to dispatch Codex receipt fixture');
  const activated = activateDelegation(dispatched.receipt, {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-1',
    parentId: 'parent-1', spawnMode: 'fresh', actualModel: 'executor-model',
    actualReasoningEffort: 'xhigh', hostEvidence: {
      kind: 'codex-lifecycle-v2', startRevision: 4, ...codexLifecycleProvenance,
      spawnToolUseId: 'spawn-tool', spawnObservedAt: '2026-01-01T00:00:01.000Z'
    }
  }, { now: () => '2026-01-01T00:00:01.000Z', monotonicNow: () => 3 });
  assert.equal(activated.ok, true);
  if (!activated.ok) throw new Error('failed to activate Codex receipt fixture');
  const completed = completeDelegationStage(activated.receipt, {
    stage: 'commit', round: 1, artifact: 'commit', agent: 'codex'
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) throw new Error('failed to complete Codex receipt fixture');
  const sealed = sealDelegation(completed.receipt, {
    childId: 'child-1', exitCode: 0, afterFingerprint: 'after', changedPaths: [],
    hostEvidence: {
      stopRevision: 7, consumer: 'receipt-1', consumedAt: '2026-01-01T00:00:02.000Z'
    }
  }, { now: () => '2026-01-01T00:00:02.000Z' });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) throw new Error('failed to seal Codex receipt fixture');
  const consumed = consumeDelegation(sealed.receipt, {
    now: () => '2026-01-01T00:00:03.000Z'
  });
  assert.equal(consumed.ok, true);
  if (!consumed.ok) throw new Error('failed to consume Codex receipt fixture');
  return consumed.receipt;
}

function currentRun(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId, runId: 'run-1', status: 'completed', nextStage: null, stepCount: 1, maxSteps: 24,
    modelPolicy: {
      executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
      reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
    },
    modelPolicySource: {
      kind: 'explicit', client: 'claude-code', resolvedAt: '2026-01-01T00:00:00.000Z'
    },
    recoveryHistory: [], baseline: '', pendingDelegation: null,
    receipts: [currentReceipt(taskId)], pause: null,
    commitAuthorization: {
      issuedAt: '2026-01-01T00:00:00.000Z', consumedAt: '2026-01-01T00:00:03.000Z'
    },
    completionEvidence: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:03.000Z',
    ...overrides
  };
}

function engine(status: 'pass' | 'fail' | 'blocked') {
  return (input: { mode: string; skillName: string; checks: string[] }) => ({
    ...(input.mode === 'gate' ? { gate: status, checks: [] } : { status, type: input.checks[0], message: 'fixture' }),
    skill: input.skillName, summary: 'fixture summary', action: 'fixture action'
  });
}

test('verification catalog is a closed mapping of all business events', () => {
  assert.deepEqual(Object.keys(VERIFICATION_CATALOG).sort(), [...EXPECTED_EVENTS].sort());
  const expected = {
    'analyze.awaiting-input': ['analyze-task', 'active', 'checks', undefined, ['task-meta']],
    'analyze.completed': ['analyze-task', 'active', 'gate', 'analysis', undefined],
    'review-analysis.completed': ['review-analysis', 'active', 'gate', 'review-analysis', undefined],
    'plan.completed': ['plan-task', 'active', 'gate', 'plan', undefined],
    'review-plan.completed': ['review-plan', 'active', 'gate', 'review-plan', undefined],
    'code.completed': ['code-task', 'active', 'gate', 'code', undefined],
    'review-code.completed': ['review-code', 'active', 'gate', 'review-code', undefined],
    'manual-validation.completed': ['complete-manual-validation', 'active', 'gate', 'manual-validation', undefined],
    'validation-run.completed': ['run-manual-validation', 'active', 'gate', 'validation-run', undefined],
    'block-task.completed': ['block-task', 'blocked', 'gate', undefined, undefined],
    'cancel-task.completed': ['cancel-task', 'completed', 'gate', undefined, undefined],
    'commit.completed': ['commit', 'active', 'gate', undefined, undefined],
    'complete-task.preflight': ['complete-task', 'active', 'checks', undefined, ['review-ledger', 'manual-validation', 'post-review-commit', 'platform-sync-preflight']],
    'complete-task.completed': ['complete-task', 'completed', 'gate', undefined, undefined],
    'create-pr.completed': ['create-pr', 'active', 'gate', undefined, undefined],
    'create-task.completed': ['create-task', 'active', 'gate', undefined, undefined],
    'import-codescan.completed': ['import-codescan', 'active', 'gate', undefined, undefined],
    'import-dependabot.completed': ['import-dependabot', 'active', 'gate', undefined, undefined],
    'import-issue.completed': ['import-issue', 'active', 'gate', undefined, undefined],
    'watch-pr.completed': ['watch-pr', 'active', 'gate', undefined, undefined],
    'review-pr.completed': ['review-pr', 'active', 'gate', 'pr-review', undefined],
    'run-task.paused': ['run-task', 'active', 'checks', undefined, ['orchestration-state', 'orchestration-evidence']],
    'run-task.completed': ['run-task', 'active', 'checks', undefined, ['orchestration-state', 'orchestration-evidence']]
  } as const;
  for (const event of EXPECTED_EVENTS) {
    const spec = VERIFICATION_CATALOG[event];
    assert.deepEqual([spec.skill, spec.expectedState, spec.mode, spec.artifactFamily, spec.checks], expected[event]);
  }
});

test('verification rejects workspace and artifact identity mismatches before invoking checks', () => {
  const f = fixture();
  let calls = 0;
  const checkEngine = (input: Parameters<ReturnType<typeof engine>>[0]) => { calls += 1; return engine('pass')(input); };
  const wrongState = verifyTaskEvent({ taskRef: f.taskId, event: 'block-task.completed' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(wrongState.error?.code, 'VERIFY_TASK_STATE_MISMATCH');
  const missingArtifact = verifyTaskEvent({ taskRef: f.taskId, event: 'code.completed' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(missingArtifact.error?.code, 'VERIFY_ARTIFACT_REQUIRED');
  const extraArtifact = verifyTaskEvent({ taskRef: f.taskId, event: 'commit.completed', artifact: 'code.md' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(extraArtifact.error?.code, 'VERIFY_ARTIFACT_UNEXPECTED');
  assert.equal(calls, 0);
});

test('preflight stops on the first non-pass and preserves blocked exit semantics', () => {
  const f = fixture();
  let calls = 0;
  const result = verifyTaskEvent({ taskRef: f.taskId, event: 'complete-task.preflight' }, {
    repoRoot: f.root,
    engine(input: Parameters<ReturnType<typeof engine>>[0]) { calls += 1; return engine('blocked')(input); }
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.invocations.length, 1);
  assert.equal(calls, 1);
});

test('unknown events fail with a stable orchestration error', () => {
  const f = fixture();
  const unknown = verifyTaskEvent({ taskRef: f.taskId, event: 'unknown.completed' }, { repoRoot: f.root });
  assert.equal(unknown.error?.code, 'VERIFY_EVENT_UNKNOWN');
});

test('run-task verification accepts complete current evidence and rejects invalid host identity', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'run-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    skill: 'run-task', checks: { 'orchestration-state': {}, 'orchestration-evidence': {} }
  }));
  const runPath = path.join(f.taskDir, 'orchestration.json');
  const run = currentRun(f.taskId);
  fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

  const valid = verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root });
  assert.equal(valid.status, 'pass');
  assert.equal(valid.invocations.length, 2);

  const codexReceipt = producedCodexReceipt(f.taskId);
  const codexRun = currentRun(f.taskId, {
    modelPolicySource: { ...run.modelPolicySource, client: 'codex' },
    receipts: [codexReceipt]
  });
  fs.writeFileSync(runPath, `${JSON.stringify(codexRun, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'pass'
  );

  fs.writeFileSync(runPath, `${JSON.stringify({
    ...codexRun,
    receipts: [{
      ...codexReceipt,
      activatedAt: null,
      sealedAt: null,
      consumedAt: null
    }]
  }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'fail'
  );

  fs.writeFileSync(runPath, `${JSON.stringify({
    ...codexRun,
    receipts: [{
      ...codexReceipt,
      hostEvidence: {
        ...codexHostEvidence,
        consumer: 'other'
      }
    }]
  }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'fail'
  );

  fs.writeFileSync(runPath, `${JSON.stringify({
    ...run,
    receipts: [currentReceipt(f.taskId, { client: 'antigravity-cli', actualModel: null })]
  }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'fail'
  );
});

test('run-task verification accepts only internally consistent clean completion evidence', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'run-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    skill: 'run-task', checks: { 'orchestration-state': {}, 'orchestration-evidence': {} }
  }));
  const head = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const evidence = {
    kind: 'reviewed-head-clean', observedAt: '2026-01-01T00:00:05.000Z',
    head, headTree: tree, worktreeTree: tree, lastReviewedCommit: head,
    prNumber: 42, prHead: head
  };
  const run = currentRun(f.taskId, {
    runId: 'run-clean', stepCount: 0, receipts: [],
    commitAuthorization: { issuedAt: null, consumedAt: null },
    completionEvidence: evidence,
    updatedAt: '2026-01-01T00:00:05.000Z'
  });
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'pass'
  );

  for (const invalid of [
    { ...run, completionEvidence: { ...evidence, prHead: 'c'.repeat(40) } },
    { ...run, commitAuthorization: { issuedAt: '2026-01-01T00:00:04.000Z', consumedAt: null } },
    { ...run, status: 'paused' },
    { ...run, completionEvidence: { ...evidence, observedAt: 'invalid' } }
  ]) {
    fs.writeFileSync(runPath, `${JSON.stringify(invalid, null, 2)}\n`);
    assert.equal(
      verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
      'fail'
    );
  }
});

test('run-task verification applies current receipt and pause invariants', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'run-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    skill: 'run-task', checks: { 'orchestration-state': {}, 'orchestration-evidence': {} }
  }));
  const paused = currentRun(f.taskId, {
    status: 'paused', stepCount: 0, receipts: [],
    pause: { code: 'ORCHESTRATION_CLIENT_UNSUPPORTED', message: 'client unsupported', recoverable: false },
    commitAuthorization: { issuedAt: null, consumedAt: null }
  });
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(paused, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.paused' }, { repoRoot: f.root }).status,
    'pass'
  );

  const pending = currentReceipt(f.taskId, {
    stage: 'analysis', artifact: 'analysis.md', status: 'activated',
    actualModel: null, actualReasoningEffort: null, spawnMode: null, agent: null,
    afterFingerprint: null, sealedAt: null, consumedAt: null
  });
  fs.writeFileSync(runPath, `${JSON.stringify({ ...paused, pendingDelegation: pending }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.paused' }, { repoRoot: f.root }).status,
    'pass'
  );

  for (const invalidReceipt of [
    { ...pending, parentId: null },
    { ...pending, modelFallbackReason: 'fabricated reason' },
    { ...pending, status: 'sealed' }
  ]) {
    fs.writeFileSync(runPath, `${JSON.stringify({ ...paused, pendingDelegation: invalidReceipt }, null, 2)}\n`);
    assert.equal(
      verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.paused' }, { repoRoot: f.root }).status,
      'fail'
    );
  }
});

test('run-task verification accepts only current recovery provenance and rejects legacy structures', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'run-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    skill: 'run-task', checks: { 'orchestration-state': {}, 'orchestration-evidence': {} }
  }));
  const head = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const recovery = {
    code: 'CLIENT_CAPABILITY_ENABLED', recoveredAt: '2026-01-01T00:00:00.000Z',
    previousStatus: 'paused',
    previousPause: { code: 'ORCHESTRATION_CLIENT_UNSUPPORTED', message: 'unsupported', recoverable: false },
    client: 'claude-code',
    guards: {
      stepCount: 0, nextStage: null, baselineEmpty: true, receiptCount: 0,
      pendingDelegation: false, commitAuthorizationUnused: true,
      completionEvidenceAbsent: true, commitIntentAbsent: true
    },
    resultingStatus: 'running'
  };
  const run = currentRun(f.taskId, {
    runId: 'run-recovered', stepCount: 0, receipts: [], recoveryHistory: [recovery],
    commitAuthorization: { issuedAt: null, consumedAt: null },
    completionEvidence: {
      kind: 'reviewed-head-clean', observedAt: '2026-01-01T00:00:05.000Z',
      head, headTree: tree, worktreeTree: tree, lastReviewedCommit: head,
      prNumber: 42, prHead: head
    }
  });
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'pass'
  );

  for (const invalid of [
    { ...run, recoveryHistory: [{ ...recovery, previousSchemaVersion: 3 }] },
    { ...run, recoveryHistory: [{ ...recovery, code: 'CLIENT_CAPABILITY_ENABLED_NO_MIGRATION' }] },
    { ...run, schemaVersion: 3 },
    { ...run, modelPolicy: { executor: 'executor-model', reviewer: 'reviewer-model' } }
  ]) {
    fs.writeFileSync(runPath, `${JSON.stringify(invalid, null, 2)}\n`);
    const result = verifyTaskEvent(
      { taskRef: f.taskId, event: 'run-task.completed' },
      { repoRoot: f.root }
    );
    assert.equal(result.status, 'fail');
  }
});
