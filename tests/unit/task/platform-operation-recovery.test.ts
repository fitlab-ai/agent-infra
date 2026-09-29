import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectPlatformCommentOperation } from '../../../lib/platform/issue-comments.ts';
import { fieldsMatchExpected, labelsMatchOwnedPrefix, recoverPlatformOperations } from '../../../lib/task/platform-operation-recovery.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../../../lib/task/platform-operation-journal.ts';

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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-operation-recovery-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskFile, `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":42}'\nstatus: active\n---\n\n# Original title\n`);
  return { repoRoot, taskDir, taskFile };
}

test('recovery supersedes an old comment digest when its task projection changed', async () => {
  const f = fixture();
  try {
    const first = inspectPlatformCommentOperation(TASK_ID, { kind: 'task', agent: 'codex', cwd: f.repoRoot });
    assert.ok(first);
    recordPlatformOperation({ taskRef: TASK_ID, cwd: f.repoRoot, ...first, dependency: 'deferred', state: 'pending' });
    fs.appendFileSync(f.taskFile, '\n## Description\nUpdated projection.\n');

    const recovered = await recoverPlatformOperations(TASK_ID, 'deferred', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);
    const stale = journal.operations.find((operation) => operation.id === first.id);
    const current = journal.operations.find((operation) => operation.id !== first.id);
    assert.equal(stale?.state, 'failed');
    assert.equal(stale?.lastCode, 'PLATFORM_OPERATION_SUPERSEDED');
    assert.ok(current);
    assert.notEqual(current.expectedDigest, first.expectedDigest);
    assert.notEqual(current.state, 'succeeded');
    assert.deepEqual(recovered.pending, [current.id]);
    assert.equal(recovered.pending.includes(first.id), false);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('serial recovery consumes the remaining attempt budget before retrying an unknown operation', async () => {
  const f = fixture();
  const callsPath = path.join(f.repoRoot, 'provider-calls.txt');
  try {
    fs.mkdirSync(path.join(f.repoRoot, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
      platform: {
        type: 'trae',
        providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath, recoveryVerifyHead: true } } }
      }
    }));
    const operation = recordPlatformOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: 'head:feature:base:main',
      expectedDigest: 'a'.repeat(64), pullRequest: { action: 'create', baseRef: 'main', headRef: 'feature' },
      dependency: 'required', state: 'pending'
    });

    for (const attempts of [2, 3]) {
      const recovery = await recoverPlatformOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot });
      const persisted = readPlatformOperationJournal(TASK_ID, f.repoRoot).operations.find((item) => item.id === operation.id);
      assert.equal(persisted?.attempts, attempts);
      assert.equal(persisted?.state, 'unknown', JSON.stringify({ recovery, providerCalls: fs.readFileSync(callsPath, 'utf8') }));
    }

    await recoverPlatformOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot });
    const exhausted = readPlatformOperationJournal(TASK_ID, f.repoRoot).operations.find((item) => item.id === operation.id);
    assert.equal(exhausted?.attempts, 3);
    assert.equal(exhausted?.state, 'unknown');
    assert.equal(fs.readFileSync(callsPath, 'utf8').split('\n').filter((call) => call === 'changeRequests.verifyHead').length, 2);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('recovery stops at an exhausted earlier operation and leaves later writes queued', async () => {
  const f = fixture();
  const callsPath = path.join(f.repoRoot, 'provider-calls.txt');
  try {
    fs.mkdirSync(path.join(f.repoRoot, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
      platform: {
        type: 'trae',
        providers: { trae: { source: path.resolve('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath, recoveryVerifyHead: true } } }
      }
    }));
    const earlier = {
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'issue-metadata' as const,
      target: '{"kind":"number","value":42}', expectedDigest: 'a'.repeat(64),
      issueMetadata: { requirements: true, issueType: false, fields: false },
      dependency: 'deferred' as const, state: 'pending' as const
    };
    for (let attempt = 0; attempt < 3; attempt += 1) recordPlatformOperation(earlier);
    const later = recordPlatformOperation({
      ...earlier, target: '{"kind":"number","value":43}', expectedDigest: 'b'.repeat(64), state: 'queued'
    });

    const recovered = await recoverPlatformOperations(TASK_ID, 'all', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);

    assert.equal(recovered.status, 'blocked');
    assert.deepEqual(recovered.pending, [journal.operations[0]!.id, later.id]);
    assert.equal(journal.operations.find((operation) => operation.id === later.id)?.state, 'queued');
    assert.equal(fs.existsSync(callsPath), false);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('PR recovery preserves its typed intent when a replay does not succeed', async () => {
  const f = fixture();
  const intent = { action: 'create' as const, baseRef: 'main', headRef: 'feature' };
  try {
    const operation = recordPlatformOperation({
      taskRef: TASK_ID, cwd: f.repoRoot, kind: 'pull-request', target: `head:feature:base:main`,
      expectedDigest: 'a'.repeat(64), dependency: 'required', state: 'pending', pullRequest: intent
    });
    await recoverPlatformOperations(TASK_ID, 'required', { agent: 'codex', cwd: f.repoRoot });
    const journal = readPlatformOperationJournal(TASK_ID, f.repoRoot);
    const persisted = journal.operations.find((item) => item.id === operation.id);
    assert.deepEqual(persisted?.pullRequest, intent);
    assert.ok(['unknown', 'failed', 'succeeded'].includes(persisted?.state ?? ''));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
