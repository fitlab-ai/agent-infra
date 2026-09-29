import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { coordinatePlatformWrite } from '../../../lib/platform/operation-coordinator.ts';
import { readPlatformOperationJournal } from '../../../lib/task/platform-operation-journal.ts';
import { platformResult } from '../../../lib/platform/types.ts';

test('a queued write stays local when an earlier operation cannot drain', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-operation-coordinator-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  let drainCalled = false;
  let executeCalled = false;
  try {
    const result = await coordinatePlatformWrite({
      operation: {
        taskRef: taskId, cwd: repoRoot, kind: 'artifact-comment', target: 'review.md',
        expectedDigest: createHash('sha256').update('review').digest('hex'), dependency: 'deferred'
      },
      agent: 'codex',
      drain: async () => {
        drainCalled = true;
        return { status: 'blocked', error: { code: 'NETWORK_TIMEOUT', message: 'prior write remains unknown', retryable: true } };
      },
      execute: async () => {
        executeCalled = true;
        return platformResult('applied');
      },
      block: (error) => platformResult('blocked', { error }),
      persistenceFailure: (error) => platformResult('failed', { error })
    });

    assert.equal(drainCalled, true);
    assert.equal(executeCalled, false);
    assert.equal(result.status, 'blocked');
    assert.equal(readPlatformOperationJournal(taskId, repoRoot).operations[0]?.state, 'queued');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('the current platform write starts only after earlier work drains', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-operation-order-'));
  const taskId = 'TASK-20260101-000002';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const events: string[] = [];
  try {
    const result = await coordinatePlatformWrite({
      operation: {
        taskRef: taskId, cwd: repoRoot, kind: 'artifact-comment', target: 'review.md',
        expectedDigest: createHash('sha256').update('review').digest('hex'), dependency: 'deferred'
      },
      agent: 'codex',
      drain: async () => {
        events.push('drain');
        return { status: 'no-op', error: null };
      },
      execute: async () => {
        events.push('write');
        return platformResult('applied');
      },
      block: (error) => platformResult('blocked', { error }),
      persistenceFailure: (error) => platformResult('failed', { error })
    });

    assert.deepEqual(events, ['drain', 'write']);
    assert.equal(result.status, 'applied');
    const operation = readPlatformOperationJournal(taskId, repoRoot).operations[0];
    assert.equal(operation?.state, 'succeeded');
    assert.equal(operation?.attempts, 1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
