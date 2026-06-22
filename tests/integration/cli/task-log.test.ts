import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-log-'));
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

// `heading` is the activity-log H2 line; `entries` are raw '- ...' lines.
function writeTask(activeDir: string, taskId: string, heading: string, entries: string[]): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const log = entries.length ? `${entries.join('\n')}\n` : '';
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    `---\nid: ${taskId}\nbranch: feat\n---\n# 任务：${taskId}\n\n${heading}\n\n${log}\n## 完成检查清单\n\n- [ ] done\n`
  );
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

test('ai task log <ref> renders legacy done-only entries as one row each, sorted ascending', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  // Intentionally out of order in the file to prove the command sorts by time.
  // No start markers -> every step is a done-only row (backward compatibility).
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 14:00:00+08:00 — **Plan Task (Round 1)** by claude — Plan completed → plan.md',
    '- 2026-06-16 15:06:43+08:00 — **Create Task** by claude — Task created from description'
  ]);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const out = runCli(['task', 'log', '1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // New status columns.
  assert.match(out.stdout, /#\s+STEP\s+AGENT\s+STARTED\s+DONE\s+NOTE/);
  // Row 1 is the earliest step (Create Task): STARTED empty, DONE has the time.
  assert.match(out.stdout, /^1\s+Create Task\s+claude\s+2026-06-16 15:06:43\+08:00\s+Task created/m);
  assert.match(out.stdout, /^2\s+Plan Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+Plan completed → plan\.md/m);
  // Trailing total counts rows (steps), not raw entries.
  assert.match(out.stdout, /^Total: 2 steps$/m);
});

test('ai task log folds a started+done pair onto one row', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000011';
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-18 14:00:00+08:00 — **Plan Task (Round 1) [started]** by claude — started',
    '- 2026-06-18 14:30:00+08:00 — **Plan Task (Round 1)** by claude — Plan completed → plan.md'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // One row: STARTED and DONE both populated, step base has the suffix stripped.
  assert.match(out.stdout, /^1\s+Plan Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+2026-06-18 14:30:00\+08:00\s+Plan completed → plan\.md/m);
  assert.match(out.stdout, /^Total: 1 steps$/m);
});

test('ai task log shows a started-only step as in progress', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000012';
  writeTask(activeDir, taskId, '## 活动日志', [
    '- 2026-06-16 15:06:43+08:00 — **Create Task** by claude — created',
    '- 2026-06-18 14:00:00+08:00 — **Code Task (Round 1) [started]** by claude — started'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // In-flight row: STARTED time set, DONE rendered as '(in progress)'.
  assert.match(out.stdout, /^2\s+Code Task \(Round 1\)\s+claude\s+2026-06-18 14:00:00\+08:00\s+\(in progress\)\s+started/m);
  assert.match(out.stdout, /^Total: 2 steps$/m);
});

test('ai task log locates an English "## Activity Log" section', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000008';
  writeTask(activeDir, taskId, '## Activity Log', [
    '- 2026-06-16 15:06:43+08:00 — **Create Task** by codex — created'
  ]);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^1\s+Create Task\s+codex\s+2026-06-16 15:06:43\+08:00\s+created/m);
  assert.match(out.stdout, /^Total: 1 steps$/m);
});

test('ai task log fails when the task has no activity log section', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000009';
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# 任务\n\n## 描述\n\nno log\n`);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task log:/);
  assert.match(out.stderr, /no activity log section/);
});

test('ai task log fails when the activity log section has no entries', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000010';
  writeTask(activeDir, taskId, '## 活动日志', []);

  const out = runCli(['task', 'log', taskId], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /no activity log entries/);
});

test('ai task log rejects an unknown ref', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'log', 'not-a-task'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task log:/);
});

test('ai task log requires an argument', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'log'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task log/);
});
