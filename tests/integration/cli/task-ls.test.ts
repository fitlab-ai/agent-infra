import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

function mkFixtureRepo(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ls-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  const activeDir = path.join(agentsDir, 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(path.join(agentsDir, 'workspace', 'blocked'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, 'workspace', 'completed'), { recursive: true });
  return { repoRoot, activeDir };
}

function writeTask(
  baseDir: string,
  taskId: string,
  fields: { short_id?: string; type?: string; status?: string; current_step?: string; branch?: string; title?: string }
): void {
  fs.mkdirSync(path.join(baseDir, taskId), { recursive: true });
  const fm: string[] = [`id: ${taskId}`];
  if (fields.short_id) fm.push(`short_id: ${fields.short_id}`);
  if (fields.type) fm.push(`type: ${fields.type}`);
  if (fields.status) fm.push(`status: ${fields.status}`);
  if (fields.current_step) fm.push(`current_step: ${fields.current_step}`);
  if (fields.branch) fm.push(`branch: ${fields.branch}`);
  const title = fields.title ?? `# ${taskId}`;
  fs.writeFileSync(
    path.join(baseDir, taskId, 'task.md'),
    `---\n${fm.join('\n')}\n---\n\n${title}\n`
  );
}

function writeRegistry(activeDir: string, ids: Record<string, string>): void {
  fs.writeFileSync(
    path.join(activeDir, '.short-ids.json'),
    JSON.stringify({ version: 1, ids })
  );
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('ai task ls defaults to active state', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  writeTask(activeDir, 'TASK-20260101-000001', { short_id: '#01', type: 'feature', status: 'active', current_step: 'plan', branch: 'feature-one' });
  writeTask(
    path.join(repoRoot, '.agents', 'workspace', 'blocked'),
    'TASK-20260101-000002',
    { short_id: '#02', type: 'bugfix', status: 'blocked', current_step: 'blocked', branch: 'bug-two' }
  );
  const out = runCli(['task', 'ls'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /TASK-20260101-000001|feature-one/);
  assert.doesNotMatch(out.stdout, /feature-?two|bug-two/);
});

test('ai task ls --all spans active + blocked + completed (not archive)', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  writeTask(activeDir, 'TASK-20260101-000001', { short_id: '#01', branch: 'feature-active' });
  writeTask(path.join(repoRoot, '.agents', 'workspace', 'blocked'), 'TASK-20260101-000002', { short_id: '#02', branch: 'feature-blocked' });
  writeTask(path.join(repoRoot, '.agents', 'workspace', 'completed'), 'TASK-20260101-000003', { short_id: '#03', branch: 'feature-completed' });
  const archiveDir = path.join(repoRoot, '.agents', 'workspace', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  writeTask(archiveDir, 'TASK-20250101-000099', { short_id: '#99', branch: 'feature-archive' });

  const out = runCli(['task', 'ls', '--all'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /feature-active/);
  assert.match(out.stdout, /feature-blocked/);
  assert.match(out.stdout, /feature-completed/);
  assert.doesNotMatch(out.stdout, /feature-archive/);
});

test('ai task ls --blocked filters to blocked state only', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  writeTask(activeDir, 'TASK-20260101-000001', { short_id: '#01', branch: 'feature-active' });
  writeTask(path.join(repoRoot, '.agents', 'workspace', 'blocked'), 'TASK-20260101-000002', { short_id: '#02', branch: 'feature-blocked' });

  const out = runCli(['task', 'ls', '--blocked'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /feature-blocked/);
  assert.doesNotMatch(out.stdout, /feature-active/);
});

test('ai task ls rejects mutually exclusive flag combos', () => {
  const { repoRoot } = mkFixtureRepo();
  const out = runCli(['task', 'ls', '--all', '--blocked'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /at most one of/i);
});

test('ai task ls rejects unexpected positional arguments', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  writeTask(activeDir, 'TASK-20260101-000001', { short_id: '#01', branch: 'feature-one' });
  const out = runCli(['task', 'ls', 'ignored-positional'], repoRoot);
  assert.notEqual(out.status, 0, 'positional arg should fail, not silently succeed');
  assert.match(out.stderr, /unexpected positional argument/);
});

test('ai task ls rejects unknown flags', () => {
  const { repoRoot } = mkFixtureRepo();
  const out = runCli(['task', 'ls', '--bogus'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /unknown flag/i);
});

test('ai task ls sources the active short id from the registry, ignoring task.md frontmatter', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  // task.md carries a stale frontmatter short_id that must be ignored…
  writeTask(activeDir, 'TASK-20260101-000001', { short_id: '#77', branch: 'feature-reg' });
  // …the registry is the real source of truth.
  writeRegistry(activeDir, { '01': 'TASK-20260101-000001' });
  const out = runCli(['task', 'ls'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // SHORT column reflects the registry (#01), not the frontmatter residue (#77).
  assert.match(out.stdout, /#01/);
  assert.doesNotMatch(out.stdout, /#77/);
});

test('ai task ls renders "-" for an active task absent from the registry', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  // Frontmatter short_id present but no registry entry → no short id.
  writeTask(activeDir, 'TASK-20260101-000001', { short_id: '#42', branch: 'feature-noreg' });
  const out = runCli(['task', 'ls'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /feature-noreg/);
  assert.doesNotMatch(out.stdout, /#42/);
});

test('ai task ls renders "-" short id for archived (completed) tasks', () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  writeTask(
    path.join(repoRoot, '.agents', 'workspace', 'completed'),
    'TASK-20260101-000003',
    { short_id: '#03', branch: 'feature-done' }
  );
  // A registry under active/ must not leak short ids into archived listings.
  writeRegistry(activeDir, { '03': 'TASK-20260101-000003' });
  const out = runCli(['task', 'ls', '--completed'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /feature-done/);
  assert.doesNotMatch(out.stdout, /#03/);
});

test('ai task ls prints empty-state message when no tasks present', () => {
  const { repoRoot } = mkFixtureRepo();
  const out = runCli(['task', 'ls'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /No tasks under/);
});
