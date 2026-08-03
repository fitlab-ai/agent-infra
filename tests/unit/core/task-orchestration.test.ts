import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  beginOrResumeOrchestration,
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
});

test('prepare fails closed for clients without orchestration capability', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const result = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'gemini-cli'
  }, { repoRoot: f.root, captureWorkspace: snapshot });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.equal(result.changed, false);
});

test('route selects one fresh role from existing lifecycle facts', () => {
  const analysis = fixture('requirement-analysis');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: analysis.root }).next, {
    action: 'analyze-task', role: 'executor', stage: 'analysis', round: 1, artifact: 'analysis.md'
  });

  const review = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(review.taskDir, 'analysis.md'), '# Analysis\n');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: review.root }).next, {
    action: 'review-analysis', role: 'reviewer', stage: 'review-analysis', round: 1, artifact: 'review-analysis.md'
  });

  const code = fixture('technical-design-review');
  fs.writeFileSync(path.join(code.taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(code.taskDir, 'review-analysis.md'), '# Analysis Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(code.taskDir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(code.taskDir, 'review-plan.md'), '# Plan Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: code.root }).next, {
    action: 'code-task', role: 'executor', stage: 'code', round: 1, artifact: 'code.md'
  });
});

test('route requires the latest review to bind the latest artifact structurally', () => {
  const f = approvedCodeFixture();
  fs.writeFileSync(path.join(f.taskDir, 'code-r2.md'), '# Code round 2\n');
  fs.utimesSync(path.join(f.taskDir, 'review-code.md'), new Date(), new Date());

  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: f.root }).next, {
    action: 'review-code', role: 'reviewer', stage: 'review-code', round: 2, artifact: 'review-code-r2.md'
  });
});

test('route fails closed before commit when manual validation or ledger work remains', () => {
  const manual = approvedCodeFixture(1);
  assert.equal(
    routeOrchestration('TASK-20260101-000001', { repoRoot: manual.root }).error?.code,
    'ORCHESTRATION_MANUAL_VALIDATION_PENDING'
  );

  const ledger = approvedCodeFixture();
  fs.appendFileSync(path.join(ledger.taskDir, 'task.md'), '\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | blocker | open | review-code.md#CD-1 |\n');
  assert.equal(
    routeOrchestration('TASK-20260101-000001', { repoRoot: ledger.root }).error?.code,
    'ORCHESTRATION_LEDGER_BLOCKED'
  );
});

test('commit authorization is issued at eligible prepare and the receipt reaches completed', () => {
  const f = approvedCodeFixture();
  const now = () => '2026-01-01T00:00:00.000Z';
  const begun = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-1', now
  });
  assert.equal(begun.run?.commitAuthorization.issuedAt, null);

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'codex'
  }, { repoRoot: f.root, id: () => 'receipt-1', now, captureWorkspace: snapshot });
  assert.equal(prepared.next?.stage, 'commit');
  assert.equal(prepared.run?.commitAuthorization.issuedAt, '2026-01-01T00:00:00.000Z');

  assert.equal(activateOrchestrationDelegation('TASK-20260101-000001', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-1', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'gpt-5'
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(completeCommitOrchestrationStage('TASK-20260101-000001', 'codex', { repoRoot: f.root }).status, 'running');
  assert.equal(sealOrchestrationDelegation('TASK-20260101-000001', {
    childId: 'child-1', exitCode: 0, afterFingerprint: 'after', changedPaths: []
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(advanceOrchestration('TASK-20260101-000001', { repoRoot: f.root, now }).status, 'completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, '2026-01-01T00:00:00.000Z');
});

test('native start binds the unique prepared delegation without task identity', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  const started = activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-native',
    parentId: 'parent-session', spawnMode: 'fresh'
  }, { repoRoot: f.root });

  assert.equal(started.status, 'running');
  assert.equal(started.run?.pendingDelegation?.taskId, 'TASK-20260101-000001');
  assert.equal(started.run?.pendingDelegation?.parentId, 'parent-session');
  assert.equal(started.run?.pendingDelegation?.childId, 'child-native');
});

test('managed native hook mismatches persist a recoverable pause', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'claude-code' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  const started = activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'wrong-role',
    parentId: 'parent-session', spawnMode: 'fresh'
  }, { repoRoot: f.root });

  assert.equal(started.status, 'paused');
  assert.equal(started.run?.pause?.code, 'DELEGATION_ROLE_MISMATCH');
});

test('repository pending guard includes paused runs that retain a delegation', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'codex' }, {
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

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000002', { client: 'codex' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  assert.equal(prepared.error?.code, 'ORCHESTRATION_DELEGATION_BUSY');
  assert.equal(prepared.changed, false);
});

test('native stop derives the workspace delta before sealing the unique delegation', () => {
  const f = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', { client: 'codex' }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });
  activateMatchingOrchestrationDelegation('codex', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-stop',
    parentId: 'parent-session', spawnMode: 'fresh'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'codex'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('codex', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-stop'
  }, {
    repoRoot: f.root,
    captureWorkspace: () => 'after-tree',
    diffWorkspace: () => [
      '.agents/workspace/active/TASK-20260101-000001/review-analysis.md',
      '.agents/workspace/active/TASK-20260101-000001/task.md',
      '.agents/workspace/active/TASK-20260101-000001/orchestration.json'
    ]
  });

  assert.equal(stopped.status, 'running');
  assert.equal(stopped.run?.pendingDelegation?.status, 'sealed');
  assert.equal(stopped.run?.pendingDelegation?.afterFingerprint, 'after-tree');
});
