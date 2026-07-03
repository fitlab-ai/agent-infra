import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';
import { gitSafeEnv, initIsolatedGitRepo } from '../../helpers/git.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-status-'));
  // Isolated repo so the command's git subcommands operate on the fixture, not
  // agent-infra's own repo (see tests/helpers/git.ts).
  initIsolatedGitRepo(repoRoot);
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(agentsDir, 'scripts', 'task-short-id.js'));
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  fs.mkdirSync(path.join(agentsDir, 'workspace', 'active'), { recursive: true });
  return { repoRoot };
}

function writeTask(repoRoot: string, state: string, taskId: string): string {
  const dir = path.join(repoRoot, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    `---\nid: ${taskId}\nbranch: feat-${state}\nstatus: ${state}\n---\n# 任务：${taskId}\n`
  );
  fs.writeFileSync(path.join(dir, 'analysis.md'), 'analysis body\n');
  fs.writeFileSync(path.join(dir, 'plan.md'), 'plan body\n');
  return dir;
}

function runCli(args: string[], cwd: string) {
  // gitSafeEnv() strips leaked GIT_* so the command's git calls stay scoped to cwd.
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8', env: gitSafeEnv() });
}

function assertCoreSections(stdout: string, taskId: string): void {
  assert.match(stdout, new RegExp(`^Task ${taskId}\\b`, 'm'));
  assert.match(stdout, /^Metadata$/m);
  assert.match(stdout, /^Artifacts \(\d+\)$/m);
  assert.match(stdout, /^Workflow$/m);
  assert.match(stdout, /^Runtime$/m);
  assert.match(stdout, /^Git$/m);
}

// Acceptance: `ai task status <ref>` must work across active / blocked / completed.
for (const state of ['active', 'blocked', 'completed'] as const) {
  test(`ai task status <TASK-id> renders the core sections for a ${state} task`, () => {
    const { repoRoot } = mkFixture();
    const taskId = 'TASK-20260101-000042';
    writeTask(repoRoot, state, taskId);

    const out = runCli(['task', 'status', taskId], repoRoot);
    assert.equal(out.status, 0, out.stderr);
    assertCoreSections(out.stdout, taskId);
    // Metadata reflects the task's own frontmatter.
    assert.match(out.stdout, new RegExp(`^  status +${state}$`, 'm'));
    // Artifacts are grouped by stage (analysis + plan written above).
    assert.match(out.stdout, /^  analysis +analysis\.md$/m);
    assert.match(out.stdout, /^  plan +plan\.md$/m);
  });
}

test('ai task status resolves an active task by its short id', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTask(repoRoot, 'active', taskId);
  const alloc = spawnSync('node', [SCRIPT, 'alloc', taskId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitSafeEnv()
  });
  assert.equal(alloc.status, 0, alloc.stderr);

  const out = runCli(['task', 'status', '1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assertCoreSections(out.stdout, taskId);
  // Active task shows its short id in the header (blocked/completed would be '-').
  assert.match(out.stdout, new RegExp(`^Task ${taskId}  \\(#01\\)$`, 'm'));
});

test('ai task status requires an argument', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'status'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task status/);
});

test('ai task status rejects an unknown ref', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'status', 'not-a-task'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task status:/);
});
