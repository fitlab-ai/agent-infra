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

// Set a deterministic mtime (epoch seconds) so ordering tests don't depend on
// the millisecond at which the fixture files happened to be written.
function setMtime(dir: string, name: string, epochSeconds: number): void {
  fs.utimesSync(path.join(dir, name), epochSeconds, epochSeconds);
}

test('enumerateArtifacts orders by mtime ascending (oldest first)', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md', 'plan.md', 'code.md']);
  // Deliberately non-alphabetical timestamps; task.md is newest (as in real
  // tasks, since it is rewritten every workflow step) so it lands last.
  setMtime(dir, 'analysis.md', 1000);
  setMtime(dir, 'plan.md', 2000);
  setMtime(dir, 'code.md', 3000);
  setMtime(dir, 'task.md', 4000);
  const names = enumerateArtifacts(dir).map((a) => a.name);
  assert.deepEqual(names, ['analysis.md', 'plan.md', 'code.md', 'task.md']);
});

test('enumerateArtifacts falls back to filename ascending when mtimes are equal', () => {
  const dir = mkTaskDir(['plan.md', 'analysis.md', 'review-plan.md']);
  setMtime(dir, 'plan.md', 5000);
  setMtime(dir, 'analysis.md', 5000);
  setMtime(dir, 'review-plan.md', 5000);
  const names = enumerateArtifacts(dir).map((a) => a.name);
  assert.deepEqual(names, ['analysis.md', 'plan.md', 'review-plan.md']);
});

test('enumerateArtifacts assigns 1-based indices in mtime order', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md', 'plan.md']);
  setMtime(dir, 'analysis.md', 100);
  setMtime(dir, 'plan.md', 200);
  setMtime(dir, 'task.md', 300);
  const artifacts = enumerateArtifacts(dir);
  assert.deepEqual(
    artifacts.map((a) => [a.index, a.name]),
    [
      [1, 'analysis.md'],
      [2, 'plan.md'],
      [3, 'task.md']
    ]
  );
});

test('enumerateArtifacts skips subdirectories and dotfiles', () => {
  const dir = mkTaskDir(['task.md', 'analysis.md', '.hidden'], ['sandbox-verify']);
  const names = enumerateArtifacts(dir)
    .map((a) => a.name)
    .sort();
  assert.deepEqual(names, ['analysis.md', 'task.md']);
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
  setMtime(dir, 'task.md', 100);
  setMtime(dir, 'analysis.md', 200);
  setMtime(dir, 'plan.md', 300);
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
