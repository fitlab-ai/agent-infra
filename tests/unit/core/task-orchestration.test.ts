import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  beginOrResumeOrchestration as beginOrResumeOrchestrationRaw,
  completeCommitOrchestrationStage,
  completeOrchestrationStage,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  readRun,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';

const snapshot = () => 'before-tree';
const modelPolicy = { executor: 'executor-model', reviewer: 'reviewer-model', sameModelReason: null } as const;

function beginOrResumeOrchestration(
  taskRef: string,
  options: Parameters<typeof beginOrResumeOrchestrationRaw>[1] = {}
) {
  return beginOrResumeOrchestrationRaw(taskRef, { modelPolicy, ...options });
}

function fixture(step: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: TASK-20260101-000001\ncurrent_step: ${step}\n---\n\n# Task\n`);
  return { root, taskDir };
}

function approvedCodeFixture(manualValidation = 0) {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(f.taskDir, 'review-analysis.md'), '# Analysis Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(f.taskDir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(f.taskDir, 'review-plan.md'), '# Plan Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(f.taskDir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.taskDir, 'review-code.md'), `# Code Review\n\n- **审查输入**：\`code.md\`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：${manualValidation}\n`);
  return f;
}

test('begin is persistent and idempotent for a running task', () => {
  const f = fixture('requirement-analysis');
  const first = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-1', now: () => '2026-01-01T00:00:00.000Z'
  });
  assert.equal(first.status, 'running');
  assert.equal(first.changed, true);
  const second = beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  assert.equal(second.changed, false);
  assert.equal(second.run?.runId, 'run-1');
  assert.deepEqual(second.run?.modelPolicy, modelPolicy);
});

test('begin accepts an omitted model policy and validates supplied policy', () => {
  const missing = fixture('requirement-analysis');
  const missingResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', { repoRoot: missing.root });
  assert.equal(missingResult.status, 'running');
  assert.equal(missingResult.run?.modelPolicy, undefined);
  assert.equal(fs.existsSync(path.join(missing.taskDir, 'orchestration.json')), true);

  const unjustified = fixture('requirement-analysis');
  const unjustifiedResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: unjustified.root,
    modelPolicy: { executor: 'shared-model', reviewer: 'shared-model', sameModelReason: null }
  });
  assert.equal(unjustifiedResult.error?.code, 'ORCHESTRATION_MODEL_SEPARATION_REQUIRED');

  const irrelevantReason = fixture('requirement-analysis');
  const irrelevantReasonResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: irrelevantReason.root,
    modelPolicy: { executor: 'executor-model', reviewer: 'reviewer-model', sameModelReason: 'not applicable' }
  });
  assert.equal(irrelevantReasonResult.error?.code, 'ORCHESTRATION_MODEL_POLICY_INVALID');

  const justified = fixture('requirement-analysis');
  const justifiedResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: justified.root,
    modelPolicy: { executor: 'shared-model', reviewer: 'shared-model', sameModelReason: 'host exposes one eligible model' }
  });
  assert.equal(justifiedResult.status, 'running');
});

test('resume rejects policy changes and continues legacy runs without model evidence', () => {
  const mismatch = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: mismatch.root });
  const mismatchResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: mismatch.root,
    modelPolicy: { executor: 'other-model', reviewer: 'reviewer-model', sameModelReason: null }
  });
  assert.equal(mismatchResult.error?.code, 'ORCHESTRATION_MODEL_POLICY_MISMATCH');

  const legacy = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: legacy.root });
  const runPath = path.join(legacy.taskDir, 'orchestration.json');
  const persisted = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  delete persisted.modelPolicy;
  fs.writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`);
  const resumed = beginOrResumeOrchestrationRaw('TASK-20260101-000001', { repoRoot: legacy.root });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.changed, false);
  assert.equal(resumed.run?.pause, null);
});

test('prepare validates requested model before capturing workspace state', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  let captures = 0;
  const captureWorkspace = () => { captures += 1; return 'snapshot'; };
  const missing = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code'
  }, { repoRoot: f.root, captureWorkspace });
  assert.equal(missing.error?.code, 'ORCHESTRATION_REQUESTED_MODEL_REQUIRED');
  const mismatch = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'wrong-model'
  }, { repoRoot: f.root, captureWorkspace });
  assert.equal(mismatch.error?.code, 'ORCHESTRATION_REQUESTED_MODEL_MISMATCH');
  assert.equal(captures, 0);
});

test('prepare fails closed for clients without orchestration capability', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const result = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'antigravity-cli'
  }, { repoRoot: f.root, captureWorkspace: snapshot });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.equal(result.changed, false);
});

test('prepare fails closed for Codex when native lifecycle events are not observable', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const result = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'codex'
  }, { repoRoot: f.root, captureWorkspace: snapshot });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.equal(result.changed, false);
});

test('route selects one fresh role from existing lifecycle facts', () => {
  const analysis = fixture('requirement-analysis');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: analysis.root }).next, {
    action: 'analyze-task', role: 'executor', stage: 'analysis', round: 1, artifact: 'analysis.md', requestedModel: null
  });

  const review = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(review.taskDir, 'analysis.md'), '# Analysis\n');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: review.root }).next, {
    action: 'review-analysis', role: 'reviewer', stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', requestedModel: null
  });

  const code = fixture('technical-design-review');
  fs.writeFileSync(path.join(code.taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(code.taskDir, 'review-analysis.md'), '# Analysis Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(code.taskDir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(code.taskDir, 'review-plan.md'), '# Plan Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: code.root }).next, {
    action: 'code-task', role: 'executor', stage: 'code', round: 1, artifact: 'code.md', requestedModel: null
  });
});

test('route requires the latest review to bind the latest artifact structurally', () => {
  const f = approvedCodeFixture();
  fs.writeFileSync(path.join(f.taskDir, 'code-r2.md'), '# Code round 2\n');
  fs.utimesSync(path.join(f.taskDir, 'review-code.md'), new Date(), new Date());

  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: f.root }).next, {
    action: 'review-code', role: 'reviewer', stage: 'review-code', round: 2, artifact: 'review-code-r2.md', requestedModel: null
  });
});

test('route allows commit when manual validation remains (complete-task gate owns the pending items)', () => {
  const manual = approvedCodeFixture(1);
  const routed = routeOrchestration('TASK-20260101-000001', { repoRoot: manual.root });
  assert.equal(routed.error, null);
  assert.deepEqual(routed.next, {
    action: 'commit', role: 'executor', stage: 'commit', round: 1, artifact: 'commit', requestedModel: null
  });
});

test('route fails closed before commit when code review ledger work remains', () => {
  const ledger = approvedCodeFixture();
  fs.appendFileSync(path.join(ledger.taskDir, 'task.md'), '\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | blocker | open | review-code.md#CD-1 |\n');
  assert.equal(
    routeOrchestration('TASK-20260101-000001', { repoRoot: ledger.root }).error?.code,
    'ORCHESTRATION_LEDGER_BLOCKED'
  );
});

test('commit authorization is issued and the run completes even with pending manual validation', () => {
  const f = approvedCodeFixture(1);
  const now = () => '2026-01-01T00:00:00.000Z';
  const begun = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-mv', now
  });
  assert.equal(begun.run?.commitAuthorization.issuedAt, null);

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'executor-model'
  }, { repoRoot: f.root, id: () => 'receipt-mv', now, captureWorkspace: snapshot });
  assert.equal(prepared.next?.stage, 'commit');
  assert.equal(prepared.run?.pendingDelegation?.workspaceSnapshotScope, 'task');
  assert.equal(prepared.run?.commitAuthorization.issuedAt, '2026-01-01T00:00:00.000Z');

  assert.equal(activateOrchestrationDelegation('TASK-20260101-000001', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-mv', parentId: 'parent-mv',
    spawnMode: 'fresh', actualModel: 'executor-model'
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(completeCommitOrchestrationStage('TASK-20260101-000001', 'claude-code', { repoRoot: f.root }).status, 'running');
  assert.equal(sealOrchestrationDelegation('TASK-20260101-000001', {
    childId: 'child-mv', exitCode: 0, afterFingerprint: 'after', changedPaths: []
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(advanceOrchestration('TASK-20260101-000001', { repoRoot: f.root, now }).status, 'completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
});

test('commit authorization is issued at eligible prepare and the receipt reaches completed', () => {
  const f = approvedCodeFixture();
  const now = () => '2026-01-01T00:00:00.000Z';
  const begun = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-1', now
  });
  assert.equal(begun.run?.commitAuthorization.issuedAt, null);

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'executor-model'
  }, { repoRoot: f.root, id: () => 'receipt-1', now, captureWorkspace: snapshot });
  assert.equal(prepared.next?.stage, 'commit');
  assert.equal(prepared.run?.pendingDelegation?.workspaceSnapshotScope, 'task');
  assert.equal(prepared.run?.commitAuthorization.issuedAt, '2026-01-01T00:00:00.000Z');

  assert.equal(activateOrchestrationDelegation('TASK-20260101-000001', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-1', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'executor-model'
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(completeCommitOrchestrationStage('TASK-20260101-000001', 'claude-code', { repoRoot: f.root }).status, 'running');
  assert.equal(sealOrchestrationDelegation('TASK-20260101-000001', {
    childId: 'child-1', exitCode: 0, afterFingerprint: 'after', changedPaths: []
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(advanceOrchestration('TASK-20260101-000001', { repoRoot: f.root, now }).status, 'completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, '2026-01-01T00:00:00.000Z');
});

test('native start binds the unique prepared delegation without task identity', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code', requestedModel: 'executor-model' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  const started = activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-native',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'executor-model'
  }, { repoRoot: f.root });

  assert.equal(started.status, 'running');
  assert.equal(started.run?.pendingDelegation?.taskId, 'TASK-20260101-000001');
  assert.equal(started.run?.pendingDelegation?.parentId, 'parent-session');
  assert.equal(started.run?.pendingDelegation?.childId, 'child-native');
});

test('managed native hook mismatches persist a recoverable pause', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code', requestedModel: 'executor-model' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  const started = activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'wrong-role',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'executor-model'
  }, { repoRoot: f.root });

  assert.equal(started.status, 'paused');
  assert.equal(started.run?.pause?.code, 'DELEGATION_ROLE_MISMATCH');
});

test('repository pending guard includes paused runs that retain a delegation', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code', requestedModel: 'executor-model' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });
  pauseOrchestration('TASK-20260101-000001', 'HOOK_FAILED', 'hook failed', true, { repoRoot: f.root });

  const secondTaskDir = path.join(f.root, '.agents', 'workspace', 'active', 'TASK-20260101-000002');
  fs.mkdirSync(secondTaskDir, { recursive: true });
  fs.writeFileSync(
    path.join(secondTaskDir, 'task.md'),
    '---\nid: TASK-20260101-000002\ncurrent_step: requirement-analysis\n---\n\n# Task\n'
  );
  beginOrResumeOrchestration('TASK-20260101-000002', { repoRoot: f.root });

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000002', { client: 'claude-code', requestedModel: 'executor-model' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  assert.equal(prepared.error?.code, 'ORCHESTRATION_DELEGATION_BUSY');
  assert.equal(prepared.changed, false);
});

test('native stop derives the workspace delta before sealing the unique delegation', () => {
  const f = fixture('requirement-analysis-review');
  const capturedScopes: Array<string | null> = [];
  const captureWorkspace = (_repoRoot: string, taskId: string | null) => {
    capturedScopes.push(taskId);
    return capturedScopes.length === 1 ? 'before-tree' : 'after-tree';
  };
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code', requestedModel: 'reviewer-model' }, {
    repoRoot: f.root, captureWorkspace
  });
  activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-stop',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'reviewer-model'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'claude-code'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-stop'
  }, {
    repoRoot: f.root,
    captureWorkspace,
    diffWorkspace: () => [
      '.agents/workspace/active/TASK-20260101-000001/review-analysis.md',
      '.agents/workspace/active/TASK-20260101-000001/task.md',
      '.agents/workspace/active/TASK-20260101-000001/orchestration.json'
    ]
  });

  assert.equal(stopped.status, 'running');
  assert.equal(stopped.run?.pendingDelegation?.status, 'sealed');
  assert.equal(stopped.run?.pendingDelegation?.afterFingerprint, 'after-tree');
  assert.deepEqual(capturedScopes, ['TASK-20260101-000001', 'TASK-20260101-000001']);
});

test('native stop preserves legacy snapshot scope for an old pending receipt', () => {
  const f = fixture('requirement-analysis-review');
  const capturedScopes: Array<string | null> = [];
  const captureWorkspace = (_repoRoot: string, taskId: string | null) => {
    capturedScopes.push(taskId);
    return capturedScopes.length === 1 ? 'before-tree' : 'after-tree';
  };
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code', requestedModel: 'reviewer-model' }, {
    repoRoot: f.root, captureWorkspace
  });
  const runPath = path.join(f.taskDir, 'orchestration.json');
  const persisted = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  delete persisted.pendingDelegation.workspaceSnapshotScope;
  fs.writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`);
  activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-legacy',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'reviewer-model'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'claude-code'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-legacy'
  }, {
    repoRoot: f.root,
    captureWorkspace,
    diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000001/review-analysis.md']
  });

  assert.equal(stopped.status, 'running');
  assert.equal(stopped.run?.pendingDelegation?.status, 'sealed');
  assert.deepEqual(capturedScopes, ['TASK-20260101-000001', null]);
});

test('reviewer snapshot shape mismatch fails closed to a recoverable pause', () => {
  const f = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code', requestedModel: 'reviewer-model' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });
  activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-rollback',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'reviewer-model'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'claude-code'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-rollback'
  }, {
    repoRoot: f.root,
    captureWorkspace: () => 'legacy-after-tree',
    diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000002/analysis.md']
  });

  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.run?.pause?.code, 'DELEGATION_REVIEWER_WRITE_FORBIDDEN');
  assert.equal(stopped.run?.pause?.recoverable, true);
});
