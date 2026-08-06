import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VERIFICATION_CATALOG,
  verifyTaskEvent
} from '../../../lib/task/verification.ts';

const EXPECTED_EVENTS = [
  'analyze.awaiting-input', 'analyze.completed', 'review-analysis.completed',
  'plan.completed', 'review-plan.completed', 'code.completed', 'review-code.completed',
  'manual-validation.completed', 'block-task.completed', 'cancel-task.completed',
  'commit.completed', 'complete-task.preflight', 'complete-task.completed',
  'create-pr.completed', 'create-task.completed', 'import-codescan.completed',
  'import-dependabot.completed', 'import-issue.completed', 'watch-pr.completed',
  'run-task.paused', 'run-task.completed'
] as const;

function fixture(state: 'active' | 'blocked' | 'completed' = 'active') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verification-unit-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\n---\n`);
  return { root, taskId, taskDir };
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

test('run-task verification accepts complete model evidence and treats model evidence as optional', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'run-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    skill: 'run-task',
    checks: { 'orchestration-state': {}, 'orchestration-evidence': {} }
  }));
  const receipt = {
    id: 'receipt-1', taskId: f.taskId, runId: 'run-1', role: 'executor',
    stage: 'commit', round: 1, artifact: 'commit', client: 'claude-code',
    requestedModel: 'executor-model', actualModel: 'executor-model', modelFallbackReason: null,
    parentId: 'parent-1', childId: 'child-1', spawnMode: 'fresh', agent: 'claude-code',
    status: 'consumed', beforeFingerprint: 'before', afterFingerprint: 'after', changedPaths: [],
    createdAt: '2026-01-01T00:00:00.000Z', activatedAt: '2026-01-01T00:00:01.000Z',
    sealedAt: '2026-01-01T00:00:02.000Z', consumedAt: '2026-01-01T00:00:03.000Z'
  };
  const run = {
    schemaVersion: 1, taskId: f.taskId, runId: 'run-1', status: 'completed', nextStage: null,
    stepCount: 1, maxSteps: 24, baseline: '',
    modelPolicy: { executor: 'executor-model', reviewer: 'reviewer-model', sameModelReason: null },
    pendingDelegation: null, receipts: [receipt], pause: null,
    commitAuthorization: { issuedAt: '2026-01-01T00:00:00.000Z', consumedAt: '2026-01-01T00:00:03.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:03.000Z'
  };
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);

  const valid = verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root });
  assert.equal(valid.status, 'pass');
  assert.equal(valid.invocations.length, 2);

  // 模型证据可选：宿主未回传 actual model 属合法状态，不再失败关闭。
  fs.writeFileSync(runPath, `${JSON.stringify({ ...run, receipts: [{ ...receipt, actualModel: null }] }, null, 2)}\n`);
  const optional = verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root });
  assert.equal(optional.status, 'pass');

  // 无模型策略的 run 同样合法。
  fs.writeFileSync(runPath, `${JSON.stringify({
    ...run,
    modelPolicy: undefined,
    receipts: [{ ...receipt, requestedModel: null, actualModel: null }]
  }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'pass'
  );

  // 已有模型策略时，仍校验策略与 receipt 的一致性。
  fs.writeFileSync(runPath, `${JSON.stringify({
    ...run,
    modelPolicy: { executor: 'shared-model', reviewer: 'shared-model', sameModelReason: null },
    receipts: [{ ...receipt, requestedModel: 'shared-model', actualModel: 'shared-model' }]
  }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'fail'
  );

  fs.writeFileSync(runPath, `${JSON.stringify({
    ...run,
    modelPolicy: {
      executor: 'executor-model', reviewer: 'reviewer-model', sameModelReason: 'not applicable'
    }
  }, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.completed' }, { repoRoot: f.root }).status,
    'fail'
  );
});

test('run-task verification accepts a clean unsupported pause and rejects unsafe pending evidence', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'run-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    skill: 'run-task', checks: { 'orchestration-state': {}, 'orchestration-evidence': {} }
  }));
  const paused = {
    schemaVersion: 1, taskId: f.taskId, runId: 'run-1', status: 'paused', nextStage: null,
    stepCount: 0, maxSteps: 24, baseline: '',
    modelPolicy: { executor: 'executor-model', reviewer: 'reviewer-model', sameModelReason: null },
    pendingDelegation: null, receipts: [],
    pause: { code: 'ORCHESTRATION_CLIENT_UNSUPPORTED', message: 'client unsupported', recoverable: false },
    commitAuthorization: { issuedAt: null, consumedAt: null },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
  const runPath = path.join(f.taskDir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(paused, null, 2)}\n`);
  assert.equal(
    verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.paused' }, { repoRoot: f.root }).status,
    'pass'
  );

  fs.writeFileSync(runPath, `${JSON.stringify({
    ...paused,
    pendingDelegation: {
      id: 'receipt-1', taskId: f.taskId, runId: 'run-1', role: 'executor', stage: 'analysis',
      round: 1, artifact: 'analysis.md', client: 'claude-code', requestedModel: 'executor-model',
      actualModel: null, modelFallbackReason: null, parentId: 'parent', childId: 'child',
      spawnMode: 'fresh', agent: null, status: 'activated', beforeFingerprint: 'before',
      afterFingerprint: null, changedPaths: [], createdAt: '2026-01-01T00:00:00.000Z',
      activatedAt: '2026-01-01T00:00:01.000Z', sealedAt: null, consumedAt: null
    }
  }, null, 2)}\n`);
  // 模型证据可选：即使有模型策略，宿主未回传 actual model 的 activated receipt 也属合法状态。
  const missingModel = verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.paused' }, { repoRoot: f.root });
  assert.equal(missingModel.status, 'pass');
  assert.equal(missingModel.invocations.length, 2);

  const sealed = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  sealed.pendingDelegation.status = 'sealed';
  sealed.pendingDelegation.actualModel = 'executor-model';
  fs.writeFileSync(runPath, `${JSON.stringify(sealed, null, 2)}\n`);
  const sealedResult = verifyTaskEvent({ taskRef: f.taskId, event: 'run-task.paused' }, { repoRoot: f.root });
  assert.equal(sealedResult.status, 'fail');
  assert.equal(sealedResult.invocations.length, 1);
});
