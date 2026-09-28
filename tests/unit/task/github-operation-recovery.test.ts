import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectGithubCommentOperation } from '../../../lib/platform/issue-comments.ts';
import { fieldsMatchExpected, labelsMatchOwnedPrefix, recoverGithubOperations } from '../../../lib/task/github-operation-recovery.ts';
import { readGithubOperationJournal, recordGithubOperation } from '../../../lib/task/github-operation-journal.ts';

const TASK_ID = 'TASK-20260101-000001';

test('Issue metadata recovery compares each label operation by its owned prefix', () => {
  const finalLabels = ['in: core', 'status: cancelled', 'type: bug'];
  const statusPlan = ['in: old', 'status: cancelled', 'type: bug'];
  const inPlan = ['in: core', 'status: open', 'type: bug'];

  assert.equal(labelsMatchOwnedPrefix(finalLabels, statusPlan, 'status:'), true);
  assert.equal(labelsMatchOwnedPrefix(finalLabels, inPlan, 'in:'), true);
  assert.equal(labelsMatchOwnedPrefix(finalLabels, statusPlan, 'in:'), false);
  assert.equal(labelsMatchOwnedPrefix(finalLabels, inPlan, 'status:'), false);
});

test('Issue metadata recovery confirms requested fields while ignoring unrelated remote fields', () => {
  const actual = { Priority: 'High', Team: 'Platform' };

  assert.equal(fieldsMatchExpected(actual, { Priority: 'High' }), true);
  assert.equal(fieldsMatchExpected(actual, { Priority: 'High', Effort: 'M' }), false);
  assert.equal(fieldsMatchExpected(actual, { Priority: 'Low' }), false);
});

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'github-operation-recovery-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskFile, `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":42}'\nstatus: active\n---\n\n# Original title\n`);
  return { repoRoot, taskDir, taskFile };
}

test('recovery supersedes an old comment digest when its task projection changed', async () => {
  const f = fixture();
  try {
    const first = inspectGithubCommentOperation(TASK_ID, { kind: 'task', agent: 'codex', cwd: f.repoRoot });
    assert.ok(first);
    recordGithubOperation({ taskRef: TASK_ID, cwd: f.repoRoot, ...first, dependency: 'deferred', state: 'pending' });
    fs.appendFileSync(f.taskFile, '\n## Description\nUpdated projection.\n');

    const recovered = await recoverGithubOperations(TASK_ID, 'deferred', { agent: 'codex', cwd: f.repoRoot });
    const journal = readGithubOperationJournal(TASK_ID, f.repoRoot);
    const stale = journal.operations.find((operation) => operation.id === first.id);
    const current = journal.operations.find((operation) => operation.id !== first.id);
    assert.equal(stale?.state, 'failed');
    assert.equal(stale?.lastCode, 'GITHUB_OPERATION_SUPERSEDED');
    assert.ok(current);
    assert.notEqual(current.expectedDigest, first.expectedDigest);
    assert.notEqual(current.state, 'succeeded');
    assert.deepEqual(recovered.pending, [current.id]);
    assert.equal(recovered.pending.includes(first.id), false);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('PR recovery preserves its typed intent when a replay does not succeed', async () => {
  const f = fixture();
  const intent = { action: 'create' as const, baseRef: 'main', headRef: 'feature' };
  try {
    const operation = recordGithubOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: `head:feature:base:main`,
      expectedDigest: 'a'.repeat(64), dependency: 'required', state: 'pending', pullRequest: intent
    });
    await recoverGithubOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot });
    const journal = readGithubOperationJournal(TASK_ID, f.repoRoot);
    const persisted = journal.operations.find((item) => item.id === operation.id);
    assert.deepEqual(persisted?.pullRequest, intent);
    assert.ok(['unknown', 'failed', 'succeeded'].includes(persisted?.state ?? ''));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
