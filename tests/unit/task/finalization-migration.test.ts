import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateFinalizationReceipts } from '../../../lib/task/finalization-migration.ts';

const taskIds = [
  'TASK-20260101-000001',
  'TASK-20260101-000002',
  'TASK-20260101-000003',
  'TASK-20260101-000004'
] as const;

function fixture(): { repoRoot: string; sourceDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-finalization-migration-'));
  const sourceDir = path.join(repoRoot, '.agents', 'workspace', '.task-finalization');
  fs.mkdirSync(sourceDir, { recursive: true });
  return { repoRoot, sourceDir };
}

function writeTask(repoRoot: string, state: string, taskId: string): string {
  const taskDir = state === 'archive'
    ? path.join(repoRoot, '.agents', 'workspace', 'archive', '2026', '10', '03', taskId, 'local')
    : path.join(repoRoot, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: ${state}\n---\n`);
  return taskDir;
}

function receipt(taskId: string, revision = 1): Record<string, unknown> {
  return {
    version: 4,
    taskId,
    intent: 'complete',
    receiptId: `receipt-${taskId}`,
    revision,
    lifecycle: 'done',
    taskComment: 'done',
    verification: 'done',
    summary: 'done',
    warningProjection: 'done',
    warnings: [],
    updatedAt: '2026-10-03T00:00:00.000Z',
    lastError: null
  };
}

function writeSource(sourceDir: string, taskId: string, value: unknown = receipt(taskId)): string {
  const file = path.join(sourceDir, `${taskId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

test('finalization receipt migration dry-run reports task states without writing', () => {
  const f = fixture();
  try {
    const states = ['active', 'blocked', 'completed', 'archive'];
    states.forEach((state, index) => {
      const taskId = taskIds[index]!;
      writeTask(f.repoRoot, state, taskId);
      writeSource(f.sourceDir, taskId);
    });

    const result = migrateFinalizationReceipts(f.repoRoot, { dryRun: true });

    assert.equal(result.failed, false);
    assert.deepEqual(result.items.map((item) => item.status), Array(4).fill('would-migrate'));
    for (const taskId of taskIds) {
      assert.equal(fs.existsSync(path.join(f.sourceDir, `${taskId}.json`)), true);
    }
    assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', taskIds[0]!, '.task-finalization.json')), false);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('finalization receipt migration moves valid terminal receipts from every task state', () => {
  const f = fixture();
  try {
    const states = ['active', 'blocked', 'completed', 'archive'];
    const taskDirs = states.map((state, index) => writeTask(f.repoRoot, state, taskIds[index]!));
    taskIds.forEach((taskId) => writeSource(f.sourceDir, taskId));

    const result = migrateFinalizationReceipts(f.repoRoot);

    assert.equal(result.failed, false);
    assert.deepEqual(result.items.map((item) => item.status), Array(4).fill('migrated'));
    taskDirs.forEach((taskDir, index) => {
      const target = path.join(taskDir, '.task-finalization.json');
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), receipt(taskIds[index]!));
      assert.equal(fs.existsSync(path.join(f.sourceDir, `${taskIds[index]}.json`)), false);
    });
    assert.equal(fs.existsSync(f.sourceDir), false);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('finalization receipt migration preserves invalid receipts and mismatched destinations', () => {
  const f = fixture();
  try {
    const invalidId = taskIds[0]!;
    const conflictId = taskIds[1]!;
    const invalidSource = writeSource(f.sourceDir, invalidId, { ...receipt(invalidId), version: 3 });
    const conflictSource = writeSource(f.sourceDir, conflictId);
    const invalidDir = writeTask(f.repoRoot, 'completed', invalidId);
    const conflictDir = writeTask(f.repoRoot, 'archive', conflictId);
    fs.writeFileSync(path.join(conflictDir, '.task-finalization.json'), `${JSON.stringify(receipt(conflictId, 2))}\n`);

    const result = migrateFinalizationReceipts(f.repoRoot);

    assert.equal(result.failed, true);
    assert.match(result.items[0]!.reason ?? '', /RECEIPT_INVALID/u);
    assert.match(result.items[1]!.reason ?? '', /TARGET_CONFLICT/u);
    assert.equal(fs.existsSync(invalidSource), true);
    assert.equal(fs.existsSync(path.join(invalidDir, '.task-finalization.json')), false);
    assert.equal(fs.existsSync(conflictSource), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(conflictDir, '.task-finalization.json'), 'utf8')), receipt(conflictId, 2));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('finalization receipt migration removes a source only when an identical destination exists', () => {
  const f = fixture();
  try {
    const taskId = taskIds[0]!;
    const taskDir = writeTask(f.repoRoot, 'completed', taskId);
    const source = writeSource(f.sourceDir, taskId);
    fs.writeFileSync(path.join(taskDir, '.task-finalization.json'), `${JSON.stringify(receipt(taskId))}\n`);

    const result = migrateFinalizationReceipts(f.repoRoot);

    assert.deepEqual(result.items, [{ source, taskId, status: 'already-migrated', reason: null }]);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(path.join(taskDir, '.task-finalization.json')), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('finalization receipt migration preserves receipts without an owning task', () => {
  const f = fixture();
  try {
    const taskId = taskIds[0]!;
    const source = writeSource(f.sourceDir, taskId);
    const result = migrateFinalizationReceipts(f.repoRoot);

    assert.equal(result.failed, true);
    assert.equal(result.items[0]!.reason, 'TASK_NOT_FOUND');
    assert.equal(fs.existsSync(source), true);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
