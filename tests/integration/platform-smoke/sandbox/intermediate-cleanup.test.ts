import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanupIntermediateUnderRemovalCoordinator } from '../../../../lib/task/intermediate-cleanup.ts';
import {
  checkpointIntentDigest,
  writeCheckpointIntent,
  type CheckpointIntent
} from '../../../../lib/task/commit-intent.ts';

const TASK_ID = 'TASK-20260101-000001';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  }).trim();
}

function taskFixture(): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediate-cleanup-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'completed', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: completed\nbranch: feature/cleanup\n---\n`);
  fs.mkdirSync(path.join(root, '.agents', 'workspace', '.task-finalization'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`),
    `${JSON.stringify({
      version: 4, taskId: TASK_ID, intent: 'complete', receiptId: 'receipt-1', revision: 1,
      lifecycle: 'done', taskComment: 'done', verification: 'done', summary: 'done',
      warningProjection: 'done', warnings: [], updatedAt: '2026-01-01T00:00:00.000Z', lastError: null
    })}\n`
  );
  return { root };
}

function writeSyncedIntent(root: string): string {
  const repoFile = path.join(root, 'tracked.txt');
  fs.writeFileSync(repoFile, 'before\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-q', '-m', 'initial');
  const expectedHead = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(repoFile, 'after\n');
  git(root, 'add', 'tracked.txt');
  const expectedTree = git(root, 'write-tree');
  git(root, 'commit', '-q', '-m', 'checkpoint');
  const committedHead = git(root, 'rev-parse', 'HEAD');
  const identity = {
    taskId: TASK_ID,
    branch: 'feature/cleanup',
    mode: 'local' as const,
    expectedHead,
    expectedTree,
    paths: ['tracked.txt'],
    message: 'checkpoint',
    round: 1
  };
  const intent: CheckpointIntent = {
    version: 1,
    ...identity,
    digest: checkpointIntentDigest(identity),
    state: 'synced',
    committedHead,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  writeCheckpointIntent(root, intent);
  const taskPath = path.join(root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8').replace(
    'branch: feature/cleanup\n',
    `branch: feature/cleanup\ncheckpoint_commit: ${committedHead}\n`
  );
  fs.writeFileSync(taskPath, task);
  return path.join(root, '.agents', 'workspace', '.task-commit-intents', `${TASK_ID}.json`);
}

test('intermediate cleanup verifies synced commit identity and removes empty auxiliary parents', () => {
  const fixture = taskFixture();
  try {
    const target = writeSyncedIntent(fixture.root);
    const result = cleanupIntermediateUnderRemovalCoordinator(fixture.root);
    assert.equal(result.items.some((item) => item.kind === 'COMMIT-SYNCED' && item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(result.items.some((item) => item.kind === 'EMPTY-AUX-PARENT' && item.disposition === 'deleted'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
