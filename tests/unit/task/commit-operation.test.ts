import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { executeCommitOperation } from '../../../lib/task/commit-operation.ts';
import { activateDelegation, dispatchDelegation, prepareDelegation } from '../../../lib/task/delegation-receipts.ts';
import { beginOrResumeOrchestration, readRun } from '../../../lib/task/orchestration.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(branch = 'feature') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-operation-'));
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['config', 'user.name', 'Codex']);
  git(root, ['config', 'user.email', 'codex@example.com']);
  fs.writeFileSync(path.join(root, 'change.txt'), 'one\n');
  git(root, ['add', 'change.txt']);
  git(root, ['commit', '-qm', 'initial']);
  return root;
}

function input(root: string, extra: Record<string, unknown> = {}) {
  const expectedHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['add', '--', 'change.txt']);
  const expectedTree = git(root, ['write-tree']);
  git(root, ['reset', '-q', '--', 'change.txt']);
  return {
    cwd: root,
    paths: ['change.txt'],
    message: 'fix: update change',
    expectedHead,
    expectedTree,
    ...extra
  } as Parameters<typeof executeCommitOperation>[0];
}

test('commit core fails closed when the expected Git snapshot is omitted', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');
    const result = executeCommitOperation({
      cwd: root,
      paths: ['change.txt'],
      message: 'fix: update change'
    } as unknown as Parameters<typeof executeCommitOperation>[0]);
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'GIT_HEAD_EXPECTATION_REQUIRED');
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('taskless direct commit uses the shared core and does not write task state', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');
    const committed = executeCommitOperation(input(root));

    assert.equal(committed.result, 'committed');
    assert.equal(committed.taskId, null);
    assert.equal(committed.mode, 'direct');
    assert.equal(committed.warnings.length, 0);
    assert.equal(git(root, ['log', '-1', '--format=%s']), 'fix: update change');
    assert.equal(fs.existsSync(path.join(root, '.agents')), false);

    const repeated = executeCommitOperation(input(root));
    assert.equal(repeated.result, 'no_op');
    assert.equal(repeated.changed, false);
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('taskless protected branch keeps the local commit and reports a push warning', () => {
  const root = fixture('main');
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-operation-remote-'));
  try {
    git(remote, ['init', '-q', '--bare']);
    git(root, ['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');
    const result = executeCommitOperation(input(root, {
      push: { remote: 'origin', refs: ['refs/heads/main'], automatic: true }
    }));

    assert.equal(result.result, 'committed_with_warnings');
    assert.equal(result.warnings[0]?.code, 'COMMIT_AUTOPUSH_PROTECTED_BRANCH');
    assert.equal(git(root, ['log', '-1', '--format=%s']), 'fix: update change');
    assert.throws(() => git(remote, ['show-ref', '--verify', 'refs/heads/main']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('taskless ordinary push failure preserves the local commit for a later push-only retry', () => {
  const root = fixture();
  try {
    git(root, ['remote', 'add', 'origin', path.join(root, 'missing.git')]);
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');
    const result = executeCommitOperation(input(root, {
      push: { remote: 'origin', refs: ['refs/heads/feature'], automatic: true }
    }));

    assert.equal(result.result, 'committed_with_warnings');
    assert.equal(result.warnings[0]?.code, 'COMMIT_PUSH_FAILED');
    assert.equal(result.changed, true);
    assert.equal(git(root, ['log', '-1', '--format=%s']), 'fix: update change');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-bound push-only retry ignores review artifacts and only follows Git facts', () => {
  const root = fixture();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-operation-remote-'));
  const missingRemote = path.join(remote, 'missing.git');
  const taskId = 'TASK-20260101-000005';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  try {
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '.agents/\n');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: feature\n---\n\n## Activity Log\n`);
    fs.writeFileSync(path.join(taskDir, 'review-code.md'), 'this review is intentionally not a commit gate\n');
    git(root, ['remote', 'add', 'origin', missingRemote]);
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');
    const first = executeCommitOperation(input(root, {
      taskRef: taskId,
      agent: 'codex',
      push: { remote: 'origin', refs: ['refs/heads/feature'], automatic: true }
    }));
    assert.equal(first.result, 'committed_with_warnings');
    assert.equal(first.warnings[0]?.code, 'COMMIT_PUSH_FAILED');

    git(remote, ['init', '-q', '--bare', 'missing.git']);
    const retry = executeCommitOperation(input(root, {
      paths: [],
      taskRef: taskId,
      agent: 'codex',
      push: { remote: 'origin', refs: ['refs/heads/feature'], automatic: true }
    }));
    assert.equal(retry.result, 'no_op');
    assert.equal(retry.warnings.length, 0);
    assert.equal(git(root, ['ls-remote', 'origin', 'refs/heads/feature']).split(/\s+/)[0], git(root, ['rev-parse', 'HEAD']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('push-only retry refuses an unexpected same-tree HEAD before pushing', () => {
  const root = fixture();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-operation-remote-'));
  try {
    git(remote, ['init', '-q', '--bare']);
    git(root, ['remote', 'add', 'origin', remote]);
    const expectedHead = git(root, ['rev-parse', 'HEAD']);
    const expectedTree = git(root, ['rev-parse', 'HEAD^{tree}']);
    git(root, ['commit', '--allow-empty', '-qm', 'unrelated local commit']);

    const result = executeCommitOperation({
      cwd: root,
      paths: [],
      message: 'retry push',
      expectedHead,
      expectedTree,
      push: { remote: 'origin', refs: ['refs/heads/feature'], automatic: true }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'GIT_HEAD_MISMATCH');
    assert.throws(() => git(remote, ['show-ref', '--verify', 'refs/heads/feature']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('orchestrated mode fails closed without a task context', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');
    const result = executeCommitOperation(input(root, { mode: 'orchestrated', agent: 'codex' }));

    assert.equal(result.status, 'blocked');
    assert.equal(result.result, 'blocked');
    assert.equal(result.error?.code, 'ORCHESTRATION_TASK_REQUIRED');
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-bound direct commit validates the task branch through the same core', () => {
  const root = fixture();
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: feature\n---\n\n## Activity Log\n`);
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');

    const result = executeCommitOperation(input(root, { taskRef: taskId, agent: 'codex' }));

    assert.equal(result.result, 'committed');
    assert.equal(result.taskId, taskId);
    assert.equal(result.mode, 'direct');
    assert.equal(git(root, ['log', '-1', '--format=%s']), 'fix: update change');
    const task = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    assert.match(task, /assigned_to: codex/);
    assert.match(task, /\*\*Commit\*\* by codex — [a-f0-9]+ fix: update change/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-bound commit from a repository subdirectory resolves the canonical repository root', () => {
  const root = fixture();
  const taskId = 'TASK-20260101-000003';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  const subdirectory = path.join(root, 'sub');
  try {
    fs.mkdirSync(subdirectory, { recursive: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: feature\n---\n\n## Activity Log\n`);
    fs.writeFileSync(path.join(subdirectory, 'change.txt'), 'nested change\n');
    const expectedHead = git(root, ['rev-parse', 'HEAD']);
    git(root, ['add', '--', 'sub/change.txt']);
    const expectedTree = git(root, ['write-tree']);
    git(root, ['reset', '-q', '--', 'sub/change.txt']);

    const result = executeCommitOperation({
      cwd: subdirectory,
      paths: ['sub/change.txt'],
      message: 'fix: update nested change',
      expectedHead,
      expectedTree,
      taskRef: taskId,
      agent: 'codex'
    });

    assert.equal(result.result, 'committed');
    assert.equal(result.taskId, taskId);
    assert.match(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'), /\*\*Commit\*\* by codex — [a-f0-9]+ fix: update nested change/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no-op task retry repairs a task sync warning and records the commit activity', () => {
  const root = fixture();
  const taskId = 'TASK-20260101-000004';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: feature\n---\n`);
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');

    const first = executeCommitOperation(input(root, { taskRef: taskId, agent: 'codex' }));
    assert.equal(first.result, 'committed_with_warnings');
    assert.equal(first.warnings[0]?.code, 'TASK_STATUS_SYNC_FAILED');
    assert.equal(first.warnings[0]?.retryable, true);

    fs.appendFileSync(path.join(taskDir, 'task.md'), '\n## Activity Log\n');
    const retry = executeCommitOperation(input(root, { taskRef: taskId, agent: 'codex' }));
    assert.equal(retry.result, 'no_op');
    assert.equal(retry.changed, false);
    assert.equal(retry.warnings.length, 0);
    assert.match(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'), /\*\*Commit\*\* by codex — [a-f0-9]+ fix: update change/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no-op task retry does not duplicate a Commit activity after an intervening event', () => {
  const root = fixture();
  const taskId = 'TASK-20260101-000006';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: feature\n---\n\n## Activity Log\n`);
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');

    const first = executeCommitOperation(input(root, { taskRef: taskId, agent: 'codex' }));
    assert.equal(first.result, 'committed');
    fs.appendFileSync(path.join(taskDir, 'task.md'), '- 2026-01-01 00:01:00+00:00 — **Platform Sync** by codex — done\n');

    const retry = executeCommitOperation(input(root, {
      taskRef: taskId,
      agent: 'codex'
    }));
    assert.equal(retry.result, 'no_op');
    assert.equal(retry.warnings.length, 0);
    const activity = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    assert.equal((activity.match(/\*\*Commit\*\*/g) ?? []).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orchestrated commit accepts only an activated commit delegation for the bound task', () => {
  const root = fixture();
  const taskId = 'TASK-20260101-000002';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: feature\n---\n\n## Activity Log\n`);
    const begun = beginOrResumeOrchestration(taskId, {
      repoRoot: root,
      client: 'claude-code',
      modelPolicy: {
        executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
        reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
      },
      id: () => 'run-1'
    });
    assert.ok(begun.run);
    const prepared = prepareDelegation({
      taskId,
      runId: begun.run.runId,
      role: 'executor',
      stage: 'commit',
      round: 1,
      artifact: 'commit',
      client: 'claude-code',
      requestedModel: 'executor-model',
      requestedReasoningEffort: 'xhigh',
      workspaceSnapshotScope: 'task',
      lifecycleProvenance: null,
      beforeFingerprint: 'before'
    }, { id: () => 'receipt-1' });
    const dispatched = dispatchDelegation(prepared);
    assert.equal(dispatched.ok, true);
    const activated = activateDelegation(dispatched.ok ? dispatched.receipt : prepared, {
      nativeAgent: 'agent-infra-lifecycle-executor',
      childId: 'child-1',
      parentId: 'parent-1',
      spawnMode: 'fresh',
      actualModel: 'executor-model',
      actualReasoningEffort: 'xhigh'
    });
    assert.equal(activated.ok, true);
    fs.writeFileSync(path.join(taskDir, 'orchestration.json'), JSON.stringify({
      ...begun.run,
      nextStage: 'commit',
      pendingDelegation: activated.ok ? activated.receipt : null,
      commitAuthorization: { issuedAt: '2026-01-01T00:00:00.000Z', consumedAt: null }
    }));
    fs.writeFileSync(path.join(root, 'change.txt'), 'two\n');

    const result = executeCommitOperation(input(root, {
      taskRef: taskId,
      agent: 'claude',
      mode: 'orchestrated'
    }));

    assert.equal(result.result, 'committed');
    assert.equal(result.taskId, taskId);
    assert.equal(result.mode, 'orchestrated');
    assert.equal(git(root, ['log', '-1', '--format=%s']), 'fix: update change');
    assert.match(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'), /\*\*Commit\*\* by claude — [a-f0-9]+ fix: update change/);
    assert.equal(readRun(taskDir)?.pendingDelegation?.status, 'stage-completed');
    assert.equal(readRun(taskDir)?.pendingDelegation?.agent, 'claude');
    assert.equal(readRun(taskDir)?.commitAuthorization.consumedAt, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
