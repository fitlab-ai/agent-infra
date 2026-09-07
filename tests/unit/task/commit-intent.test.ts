import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  checkpointIntentDigest,
  intentPath,
  readCheckpointIntent,
  removeCheckpointIntent,
  writeCheckpointIntent,
  type CheckpointIntent
} from '../../../lib/task/commit-intent.ts';
import { checkpointCommitMatches } from '../../../lib/task/commit-identity.ts';

function intent(root: string): CheckpointIntent {
  return {
    version: 1,
    taskId: 'TASK-20260101-000001',
    branch: 'feature/demo',
    mode: 'local',
    expectedHead: 'a'.repeat(40),
    expectedTree: 'b'.repeat(40),
    paths: ['lib/demo.ts'],
    message: 'fix: persist checkpoint',
    round: 1,
    digest: checkpointIntentDigest({
      taskId: 'TASK-20260101-000001', branch: 'feature/demo', mode: 'local',
      expectedHead: 'a'.repeat(40), expectedTree: 'b'.repeat(40),
      paths: ['lib/demo.ts'], message: 'fix: persist checkpoint', round: 1
    }),
    state: 'prepared',
    committedHead: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

test('checkpoint intent is atomically persisted and removed after synchronization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-intent-'));
  try {
    const value = intent(root);
    writeCheckpointIntent(root, value);
    assert.equal(fs.existsSync(intentPath(root, value.taskId)), true);
    assert.deepEqual(readCheckpointIntent(root, value.taskId), value);
    removeCheckpointIntent(root, value.taskId);
    assert.equal(readCheckpointIntent(root, value.taskId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint commit identity requires parent, tree, subject, and changed paths to match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-identity-'));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  }).trim();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n');
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'initial');
    const expectedHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'after\n');
    git('add', 'tracked.txt');
    const expectedTree = git('write-tree');
    git('commit', '-q', '-m', 'checkpoint');
    const head = git('rev-parse', 'HEAD');
    const base: CheckpointIntent = {
      ...intent(root),
      expectedHead,
      expectedTree,
      paths: ['tracked.txt'],
      message: 'checkpoint',
      committedHead: head,
      state: 'synced',
      digest: checkpointIntentDigest({
        ...intent(root), expectedHead, expectedTree, paths: ['tracked.txt'], message: 'checkpoint'
      })
    };
    assert.equal(checkpointCommitMatches(root, base, head), true);
    for (const field of ['expectedHead', 'expectedTree', 'message', 'paths'] as const) {
      const mismatch = field === 'paths'
        ? { ...base, paths: ['other.txt'] }
        : field === 'expectedHead'
          ? { ...base, expectedHead: 'a'.repeat(40) }
          : field === 'expectedTree'
            ? { ...base, expectedTree: 'b'.repeat(40) }
            : { ...base, message: 'different' };
      assert.equal(checkpointCommitMatches(root, mismatch, head), false, field);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
