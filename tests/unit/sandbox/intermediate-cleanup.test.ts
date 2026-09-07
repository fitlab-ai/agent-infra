import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupIntermediateFiles,
  scanIntermediateCleanup
} from '../../../lib/sandbox/intermediate-cleanup.ts';
import {
  checkpointIntentDigest,
  writeCheckpointIntent,
  type CheckpointIntent
} from '../../../lib/task/commit-intent.ts';
import {
  semanticDigest,
  sha256Content
} from '../../../lib/task/local-artifact-finalization.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';
import { onPlatforms } from '../../helpers.ts';

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

function taskFixture(): { root: string; taskDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediate-cleanup-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'completed', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: completed\nbranch: feature/cleanup\n---\n`);
  fs.mkdirSync(path.join(root, '.agents', 'workspace', '.task-finalization'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`),
    `${JSON.stringify({
      version: 2,
      taskId: TASK_ID,
      intent: 'complete',
      receiptId: 'receipt-1',
      revision: 1,
      lifecycle: 'done',
      taskComment: 'done',
      verification: 'done',
      warningProjection: 'done',
      warnings: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastError: null
    })}\n`
  );
  return { root, taskDir };
}

function writeConsumedIntent(root: string, taskDir: string): string {
  const artifact = 'plan.md';
  const content = '# Plan\n';
  const artifactPath = path.join(taskDir, artifact);
  fs.writeFileSync(artifactPath, content);
  const intent = {
    version: 1,
    taskId: TASK_ID,
    family: 'plan',
    artifact,
    state: 'consumed',
    baselineSemanticDigest: null,
    artifactSha256: sha256Content(content),
    semanticDigest: semanticDigest(content)
  };
  const intentDir = path.join(root, '.agents', 'workspace', '.local-artifact-finalization-intents');
  fs.mkdirSync(intentDir, { recursive: true });
  fs.writeFileSync(path.join(intentDir, `${TASK_ID}-plan-${artifact}.json`), `${JSON.stringify(intent)}\n`);
  return path.join(intentDir, `${TASK_ID}-plan-${artifact}.json`);
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
    `branch: feature/cleanup\n`,
    `branch: feature/cleanup\ncheckpoint_commit: ${committedHead}\n`
  );
  fs.writeFileSync(taskPath, task);
  return path.join(root, '.agents', 'workspace', '.task-commit-intents', `${TASK_ID}.json`);
}

test('intermediate cleanup deletes only a receipt-backed consumed artifact intent', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const planned = scanIntermediateCleanup(fixture.root);
    assert.equal(planned.items.some((item) => item.kind === 'LFAI-CONSUMED' && item.disposition === 'planned'), true);
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(result.items.some((item) => item.kind === 'LFAI-CONSUMED' && item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(fixture.taskDir, 'plan.md')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup preserves active and malformed auxiliary records', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const activeId = 'TASK-20260101-000002';
    const activeDir = path.join(fixture.root, '.agents', 'workspace', 'active', activeId);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'task.md'), `---\nid: ${activeId}\nstatus: active\nbranch: feature/active\n---\n`);
    const malformed = path.join(fixture.root, '.agents', 'workspace', '.task-commit-intents', `${activeId}.json`);
    fs.mkdirSync(path.dirname(malformed), { recursive: true });
    fs.writeFileSync(malformed, '{"version":1}\n');
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(malformed), true);
    assert.equal(result.items.some((item) => item.disposition === 'protected' && item.reason === 'TASK_STATE_PROTECTED'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup preserves symlinked auxiliary records', onPlatforms('linux', 'darwin'), () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const symlink = path.join(fixture.root, '.agents', 'workspace', '.local-artifact-finalization-intents', 'foreign.json');
    fs.symlinkSync(target, symlink);
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
    assert.equal(result.items.some((item) => item.disposition === 'protected' && item.reason === 'PATH_SYMLINK'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup verifies synced commit identity and removes empty auxiliary parents', () => {
  const fixture = taskFixture();
  try {
    const target = writeSyncedIntent(fixture.root);
    fs.mkdirSync(path.join(fixture.root, '.agents', 'workspace', '.local-artifact-finalization-intents'), { recursive: true });
    const result = cleanupIntermediateFiles(fixture.root);
    assert.equal(result.items.some((item) => item.kind === 'COMMIT-SYNCED' && item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(result.items.some((item) => item.kind === 'EMPTY-AUX-PARENT' && item.disposition === 'deleted'), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup fails closed while another task operation holds the lock', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    withTaskExecutionLock(fixture.root, TASK_ID, 'test-holder', () => {
      const result = cleanupIntermediateFiles(fixture.root);
      assert.equal(fs.existsSync(target), true);
      assert.equal(result.items.some((item) => item.reason === 'TASK_LOCK_BUSY'), true);
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('intermediate cleanup requires an explicit verifier for bound finalization receipts', () => {
  const fixture = taskFixture();
  try {
    const target = writeConsumedIntent(fixture.root, fixture.taskDir);
    const receiptPath = path.join(fixture.root, '.agents', 'workspace', '.task-finalization', `${TASK_ID}.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.controlBinding = { generation: 'generation-1', requestId: 'a'.repeat(16) };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    const protectedReport = scanIntermediateCleanup(fixture.root);
    assert.equal(protectedReport.items.some((item) => item.reason === 'CONTROL_BINDING_MISMATCH'), true);
    const result = cleanupIntermediateFiles(fixture.root, { controlBindingVerifier: () => true });
    assert.equal(result.items.some((item) => item.disposition === 'deleted'), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
