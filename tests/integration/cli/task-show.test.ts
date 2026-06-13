import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-show-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  // Stub script: copy from runtime to fixture so resolve subcommand works under cwd.
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

function writeTask(activeDir: string, taskId: string, branch: string): void {
  fs.mkdirSync(path.join(activeDir, taskId), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, taskId, 'task.md'),
    `---\nid: ${taskId}\nbranch: ${branch}\n---\n# 任务：${taskId}\n\nbody for ${taskId}\n`
  );
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

test('ai task show <bare-numeric> prints task.md', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTask(activeDir, taskId, 'feature-seven');
  // Allocate short id via script (first slot is #01 with empty registry).
  const alloc = spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(alloc.status, 0, alloc.stderr);
  assert.equal(alloc.stdout.trim(), '#01');

  const out = runCli(['task', 'show', '1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /TASK-20260101-000007/);
  assert.match(out.stdout, /body for TASK-20260101-000007/);
});

test('ai task show #1 (hash form) is equivalent to bare numeric', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTask(activeDir, taskId, 'feature-seven');
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const out = runCli(['task', 'show', '#1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /TASK-20260101-000007/);
});

test('ai task show <TASK-id> resolves a completed task (flat layout)', () => {
  const { repoRoot } = mkFixture();
  const completedDir = path.join(repoRoot, '.agents', 'workspace', 'completed');
  fs.mkdirSync(completedDir, { recursive: true });
  const taskId = 'TASK-20250101-000099';
  writeTask(completedDir, taskId, 'feature-completed');

  const out = runCli(['task', 'show', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /feature-completed/);
});

test('ai task show <TASK-id> resolves an archived task under archive/YYYY/MM/DD/', () => {
  const { repoRoot } = mkFixture();
  // archive-tasks SKILL moves completed tasks into
  //   .agents/workspace/archive/YYYY/MM/DD/TASK-YYYYMMDD-HHMMSS/task.md
  // where YYYY/MM/DD comes from completed_at (NOT from the task id timestamp).
  const taskId = 'TASK-20260613-120000';
  const datedDir = path.join(
    repoRoot,
    '.agents',
    'workspace',
    'archive',
    '2026',
    '06',
    '13',
    taskId
  );
  fs.mkdirSync(datedDir, { recursive: true });
  fs.writeFileSync(
    path.join(datedDir, 'task.md'),
    `---\nid: ${taskId}\nbranch: archived-demo\n---\n# Archived\nbody for archived\n`
  );

  const out = runCli(['task', 'show', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /archived-demo/);
  assert.match(out.stdout, /body for archived/);
});

test('ai task show <TASK-id> resolves an archived task whose archive date differs from task id (cross-day)', () => {
  const { repoRoot } = mkFixture();
  // archive-tasks uses completed_at/updated_at, which can fall on a different
  // calendar day than the task id timestamp (e.g. task created Jun 12, completed
  // Jun 13). The lookup must NOT derive the path from the task id date.
  const taskId = 'TASK-20260612-120000';
  const datedDir = path.join(
    repoRoot,
    '.agents',
    'workspace',
    'archive',
    '2026',
    '06',
    '13', // archive date != task id date (Jun 13 vs Jun 12)
    taskId
  );
  fs.mkdirSync(datedDir, { recursive: true });
  fs.writeFileSync(
    path.join(datedDir, 'task.md'),
    `---\nid: ${taskId}\ncompleted_at: 2026-06-13 09:00:00+08:00\nbranch: archived-cross-day\n---\n# Archived Cross Day\n`
  );

  const out = runCli(['task', 'show', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /archived-cross-day/);
});

test('ai task show <reserved> rejects 0', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'show', '0'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /reserved/);
});

test('ai task show <over-capacity> rejects 100 under shortIdLength=2', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'show', '100'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /exceeds/);
});

test('ai task show <non-numeric> rejects garbage input', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'show', 'not-a-task'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /not a valid short id or TASK-id/);
});

test('ai task show requires an argument', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'show'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /Usage: ai task show/);
});
