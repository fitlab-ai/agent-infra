import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cat-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(agentsDir, 'scripts', 'task-short-id.js'));
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  const activeDir = path.join(agentsDir, 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir };
}

function writeTaskWithArtifacts(activeDir: string, taskId: string): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# ${taskId}\nbody\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), 'analysis body line\n');
  // Oldest-first order: task.md (#1) then analysis.md (#2).
  fs.utimesSync(path.join(dir, 'task.md'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'analysis.md'), 2000, 2000);
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

test('ai task cat <ref> <name> and <ref> <N> produce identical output', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTaskWithArtifacts(activeDir, taskId);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const byName = runCli(['task', 'cat', '1', 'analysis'], repoRoot);
  // analysis.md is artifact #2 (task.md is #1).
  const byIndex = runCli(['task', 'cat', '1', '2'], repoRoot);
  assert.equal(byName.status, 0, byName.stderr);
  assert.equal(byIndex.status, 0, byIndex.stderr);
  assert.equal(byName.stdout, 'analysis body line\n');
  assert.equal(byName.stdout, byIndex.stdout);
});

test('ai task cat <ref> task is byte-identical to ai task show <ref>', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTaskWithArtifacts(activeDir, taskId);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const cat = runCli(['task', 'cat', '1', 'task'], repoRoot);
  const show = runCli(['task', 'show', '1'], repoRoot);
  assert.equal(cat.status, 0, cat.stderr);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(cat.stdout, show.stdout);
});

test('ai task cat rejects a non-existent artifact name', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTaskWithArtifacts(activeDir, taskId);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const out = runCli(['task', 'cat', '1', 'nope'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task cat: artifact 'nope' not found/);
});

test('ai task cat requires both ref and artifact arguments', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTaskWithArtifacts(activeDir, taskId);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const out = runCli(['task', 'cat', '1'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task cat/);
});
