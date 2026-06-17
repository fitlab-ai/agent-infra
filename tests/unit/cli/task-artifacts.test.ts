import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enumerateArtifacts, resolveArtifact } from '../../../lib/task/artifacts.ts';

function mkTaskDir(files: string[], subdirs: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifacts-'));
  for (const name of files) {
    fs.writeFileSync(path.join(dir, name), `content of ${name}\n`);
  }
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

test('enumerateArtifacts orders by lifecycle group (base before review-) then filename', () => {
  // Intentionally shuffled on disk; the contract is the returned order.
  const dir = mkTaskDir([
    'review-plan.md',
    'analysis-r2.md',
    'verify-pr-1.md',
    'plan.md',
    'analysis.md',
    'task.md',
    'review-analysis.md',
    'code.md'
  ]);
  const names = enumerateArtifacts(dir).map((a) => a.name);
  assert.deepEqual(names, [
    'task.md', // rank 0
    // rank 1 analysis, filename asc — 'analysis-r2.md' precedes 'analysis.md' because '-' (0x2D) < '.' (0x2E)
    'analysis-r2.md',
    'analysis.md',
    'review-analysis.md', // rank 2
    'plan.md', // rank 3
    'review-plan.md', // rank 4
    'code.md', // fallback rank 5, filename asc
    'verify-pr-1.md'
  ]);
});

test('enumerateArtifacts assigns stable 1-based indices', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md', 'plan.md']);
  const artifacts = enumerateArtifacts(dir);
  assert.deepEqual(
    artifacts.map((a) => [a.index, a.name]),
    [
      [1, 'task.md'],
      [2, 'analysis.md'],
      [3, 'plan.md']
    ]
  );
});

test('enumerateArtifacts skips subdirectories and dotfiles', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md', '.hidden'], ['sandbox-verify']);
  const names = enumerateArtifacts(dir).map((a) => a.name);
  assert.deepEqual(names, ['task.md', 'analysis.md']);
});

test('enumerateArtifacts returns absolute path, size and mtime per entry', () => {
  const dir = mkTaskDir(['task.md']);
  const [entry] = enumerateArtifacts(dir);
  assert.ok(entry);
  assert.equal(entry.path, path.join(dir, 'task.md'));
  assert.ok(path.isAbsolute(entry.path));
  assert.equal(entry.size, fs.statSync(entry.path).size);
  assert.ok(entry.size > 0);
  assert.equal(typeof entry.mtimeMs, 'number');
});

test('resolveArtifact resolves a filename with or without the .md suffix', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md']);
  const expected = path.join(dir, 'analysis.md');
  assert.equal(resolveArtifact(dir, 'analysis'), expected);
  assert.equal(resolveArtifact(dir, 'analysis.md'), expected);
});

test('resolveArtifact resolves a numeric index to the same path as enumeration', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md', 'plan.md']);
  assert.equal(resolveArtifact(dir, '1'), path.join(dir, 'task.md'));
  assert.equal(resolveArtifact(dir, '3'), path.join(dir, 'plan.md'));
});

test('resolveArtifact throws on a non-existent artifact name', () => {
  const dir = mkTaskDir(['task.md']);
  assert.throws(() => resolveArtifact(dir, 'nope'), /not found in task directory/);
});

test('resolveArtifact throws on an out-of-range index', () => {
  const dir = mkTaskDir(['task.md']);
  assert.throws(() => resolveArtifact(dir, '999'), /invalid artifact index 999/);
});

test('resolveArtifact rejects names containing path separators', () => {
  const dir = mkTaskDir(['task.md']);
  assert.throws(() => resolveArtifact(dir, '../task'), /must not contain path separators/);
});
