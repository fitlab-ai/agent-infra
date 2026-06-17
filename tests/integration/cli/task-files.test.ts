import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-files-'));
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
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# ${taskId}\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), 'analysis body\n');
  fs.writeFileSync(path.join(dir, 'review-analysis.md'), 'review body\n');
  // Deterministic mtimes (oldest first): analysis -> review-analysis -> task.
  fs.utimesSync(path.join(dir, 'analysis.md'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'review-analysis.md'), 2000, 2000);
  fs.utimesSync(path.join(dir, 'task.md'), 3000, 3000);
  // A subdirectory must not appear in the numbered listing.
  fs.mkdirSync(path.join(dir, 'sandbox-verify'), { recursive: true });
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

test('ai task files <ref> prints a numbered artifact table', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeTaskWithArtifacts(activeDir, taskId);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const out = runCli(['task', 'files', '1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Header columns.
  assert.match(out.stdout, /#\s+NAME\s+SIZE\s+MTIME/);
  // Ordered oldest-first by mtime; NAME shown without the `.md` suffix.
  assert.match(out.stdout, /^1\s+analysis\s+\d+\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m);
  assert.match(out.stdout, /^2\s+review-analysis\s/m);
  assert.match(out.stdout, /^3\s+task\s/m);
  // Names are stripped of `.md`.
  assert.doesNotMatch(out.stdout, /\.md/);
  // The subdirectory must not be listed.
  assert.doesNotMatch(out.stdout, /sandbox-verify/);
});

test('ai task files rejects an unknown ref', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'files', 'not-a-task'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ai task files:/);
});

test('ai task files requires an argument', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'files'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task files/);
});
