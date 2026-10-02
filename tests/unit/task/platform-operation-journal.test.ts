import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  PLATFORM_OPERATION_JOURNAL_FILE,
  readPlatformOperationJournal,
  recordPlatformOperation
} from '../../../lib/task/platform-operation-journal.ts';

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-operation-journal-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  return { repoRoot, taskId, taskDir };
}

test('task-local platform operation journal deduplicates stable operations and stores only digests', () => {
  const f = fixture();
  try {
    const expectedDigest = createHash('sha256').update('projected artifact bytes').digest('hex');
    const input = {
      taskRef: f.taskId,
      cwd: f.repoRoot,
      kind: 'artifact-comment' as const,
      target: 'code.md',
      expectedDigest,
      dependency: 'required' as const,
      state: 'pending' as const
    };
    const first = recordPlatformOperation(input);
    const second = recordPlatformOperation({ ...input, state: 'unknown', lastCode: 'NETWORK_TIMEOUT' });
    const journal = readPlatformOperationJournal(f.taskId, f.repoRoot);
    const serialized = fs.readFileSync(path.join(f.taskDir, PLATFORM_OPERATION_JOURNAL_FILE), 'utf8');

    assert.equal(first.id, second.id);
    assert.equal(second.attempts, 1);
    assert.equal(journal.operations.length, 1);
    assert.equal(journal.operations[0]?.state, 'unknown');
    assert.equal(journal.operations[0]?.lastCode, 'NETWORK_TIMEOUT');
    assert.equal(serialized.includes('projected artifact bytes'), false);
    assert.equal(serialized.includes(expectedDigest), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('task-local platform operation journal records reconstructable Issue and PR intent fields', () => {
  const f = fixture();
  try {
    const digest = createHash('sha256').update('intent fingerprint').digest('hex');
    recordPlatformOperation({
      taskRef: f.taskId, cwd: f.repoRoot, kind: 'issue-metadata', target: '{"kind":"number","value":42}',
      expectedDigest: digest, issueMetadata: { requirements: true, issueType: true, fields: false },
      dependency: 'required', state: 'pending'
    });
    recordPlatformOperation({
      taskRef: f.taskId, cwd: f.repoRoot, kind: 'pull-request', target: 'head:feature:base:main',
      expectedDigest: digest, pullRequest: { action: 'create', baseRef: 'main', headRef: 'feature' },
      dependency: 'required', state: 'pending'
    });
    const journal = readPlatformOperationJournal(f.taskId, f.repoRoot);
    assert.deepEqual(journal.operations.map((operation) => [operation.kind, operation.dependency]), [
      ['issue-metadata', 'required'], ['pull-request', 'required']
    ]);
    assert.deepEqual(journal.operations[0]?.issueMetadata, { requirements: true, issueType: true, fields: false });
    assert.deepEqual(journal.operations[1]?.pullRequest, { action: 'create', baseRef: 'main', headRef: 'feature' });
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('replacement keeps the old queue position and removes an already queued duplicate', () => {
  const f = fixture();
  try {
    const oldDigest = createHash('sha256').update('old projection').digest('hex');
    const newDigest = createHash('sha256').update('new projection').digest('hex');
    const old = recordPlatformOperation({
      taskRef: f.taskId, cwd: f.repoRoot, kind: 'task-comment', target: 'task.md',
      expectedDigest: oldDigest, dependency: 'deferred', state: 'pending'
    });
    const later = recordPlatformOperation({
      taskRef: f.taskId, cwd: f.repoRoot, kind: 'artifact-comment', target: 'later.md',
      expectedDigest: 'b'.repeat(64), dependency: 'deferred', state: 'queued'
    });
    const duplicate = recordPlatformOperation({
      taskRef: f.taskId, cwd: f.repoRoot, kind: 'task-comment', target: 'task.md',
      expectedDigest: newDigest, dependency: 'deferred', state: 'queued'
    });
    recordPlatformOperation({
      taskRef: f.taskId, cwd: f.repoRoot, kind: 'task-comment', target: 'task.md',
      expectedDigest: newDigest, dependency: 'deferred', state: 'queued', replaceOperationId: old.id
    });

    const journal = readPlatformOperationJournal(f.taskId, f.repoRoot);
    assert.deepEqual(journal.operations.map((operation) => operation.id), [duplicate.id, later.id]);
    assert.equal(journal.operations[0]?.attempts, old.attempts);
    assert.equal(journal.operations[0]?.state, 'queued');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
