import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

function mkFixture(): { repoRoot: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-grep-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(agentsDir, 'scripts', 'task-short-id.js'));
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  for (const state of ['active', 'blocked', 'completed']) {
    fs.mkdirSync(path.join(agentsDir, 'workspace', state), { recursive: true });
  }
  return { repoRoot };
}

// Write a task dir with the given artifacts under a flat workspace state.
function writeTask(
  repoRoot: string,
  state: 'active' | 'blocked' | 'completed',
  taskId: string,
  files: Record<string, string>
): void {
  const dir = path.join(repoRoot, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(dir, { recursive: true });
  if (!files['task.md']) {
    fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# ${taskId}\n`);
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

// Write a task dir under the archive YYYY/MM/DD layout.
function writeArchiveTask(repoRoot: string, taskId: string, files: Record<string, string>): void {
  const dir = path.join(repoRoot, '.agents', 'workspace', 'archive', '2026', '06', '18', taskId);
  fs.mkdirSync(dir, { recursive: true });
  if (!files['task.md']) {
    fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# ${taskId}\n`);
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function alloc(repoRoot: string, taskId: string): void {
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

test('matches a literal pattern and prints taskId, short id, file stem and line number', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  writeTask(repoRoot, 'active', taskId, { 'analysis.md': 'first line\nhas needle here\nlast line\n' });
  alloc(repoRoot, taskId);

  const out = runCli(['task', 'grep', 'needle'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Active task carries its short id (#01); line number is 1-based; stem drops '.md'.
  assert.equal(out.stdout, `${taskId} #01 analysis:2: has needle here\n`);
});

test('no ref scans active + blocked + completed; only active rows carry a short id', () => {
  const { repoRoot } = mkFixture();
  const a = 'TASK-20260101-000001';
  const b = 'TASK-20260101-000002';
  const c = 'TASK-20260101-000003';
  writeTask(repoRoot, 'active', a, { 'analysis.md': 'KEYWORD in active\n' });
  writeTask(repoRoot, 'blocked', b, { 'analysis.md': 'KEYWORD in blocked\n' });
  writeTask(repoRoot, 'completed', c, { 'analysis.md': 'KEYWORD in completed\n' });
  alloc(repoRoot, a);

  const out = runCli(['task', 'grep', 'KEYWORD'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l === `${a} #01 analysis:1: KEYWORD in active`));
  // blocked / completed tasks have released their short id -> token omitted.
  assert.ok(lines.some((l) => l === `${b} analysis:1: KEYWORD in blocked`));
  assert.ok(lines.some((l) => l === `${c} analysis:1: KEYWORD in completed`));
});

test('-i / --ignore-case toggles case sensitivity', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  writeTask(repoRoot, 'active', taskId, { 'analysis.md': 'lowercase needle\n' });
  alloc(repoRoot, taskId);

  // Case-sensitive by default: no match -> exit 1, empty stdout.
  const sensitive = runCli(['task', 'grep', 'NEEDLE'], repoRoot);
  assert.equal(sensitive.status, 1);
  assert.equal(sensitive.stdout, '');

  // -i matches.
  const ignore = runCli(['task', 'grep', '-i', 'NEEDLE'], repoRoot);
  assert.equal(ignore.status, 0, ignore.stderr);
  assert.match(ignore.stdout, /analysis:1: lowercase needle/);

  // --ignore-case is the long form.
  const ignoreLong = runCli(['task', 'grep', '--ignore-case', 'NEEDLE'], repoRoot);
  assert.equal(ignoreLong.status, 0, ignoreLong.stderr);
});

test('pattern is matched literally, not as a regex', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  writeTask(repoRoot, 'active', taskId, {
    'analysis.md': 'literal a.c here\nregex would match abc\nbracket [x] here\nbare x here\nstar a*c here\ngreedy aaac here\n'
  });
  alloc(repoRoot, taskId);

  const dot = runCli(['task', 'grep', 'a.c'], repoRoot);
  assert.equal(dot.status, 0, dot.stderr);
  assert.match(dot.stdout, /literal a\.c here/);
  assert.doesNotMatch(dot.stdout, /match abc/); // '.' must NOT match 'b'

  const bracket = runCli(['task', 'grep', '[x]'], repoRoot);
  assert.equal(bracket.status, 0, bracket.stderr);
  assert.match(bracket.stdout, /bracket \[x\] here/);
  assert.doesNotMatch(bracket.stdout, /bare x here/); // '[x]' must NOT match a bare 'x'

  const star = runCli(['task', 'grep', 'a*c'], repoRoot);
  assert.equal(star.status, 0, star.stderr);
  assert.match(star.stdout, /star a\*c here/);
  assert.doesNotMatch(star.stdout, /greedy aaac here/); // 'a*c' must NOT match 'aaac'
});

test('a ref narrows the scan to a single task', () => {
  const { repoRoot } = mkFixture();
  const a = 'TASK-20260101-000001';
  const b = 'TASK-20260101-000002';
  writeTask(repoRoot, 'active', a, { 'analysis.md': 'shared KEYWORD a\n' });
  writeTask(repoRoot, 'active', b, { 'analysis.md': 'shared KEYWORD b\n' });
  alloc(repoRoot, a);
  alloc(repoRoot, b);

  const out = runCli(['task', 'grep', 'KEYWORD', a], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /KEYWORD a/);
  assert.doesNotMatch(out.stdout, /KEYWORD b/);
});

test('an artifact selector (name or number) narrows the scan to a single file', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  const dir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\nbranch: feat\n---\n# ${taskId}\nKEYWORD task\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), 'KEYWORD analysis\n');
  // task.md is artifact #1, analysis.md is #2 (oldest mtime first).
  fs.utimesSync(path.join(dir, 'task.md'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'analysis.md'), 2000, 2000);
  alloc(repoRoot, taskId);

  const byName = runCli(['task', 'grep', 'KEYWORD', taskId, 'analysis'], repoRoot);
  assert.equal(byName.status, 0, byName.stderr);
  assert.match(byName.stdout, /analysis:1: KEYWORD analysis/);
  assert.doesNotMatch(byName.stdout, /KEYWORD task/);

  const byNumber = runCli(['task', 'grep', 'KEYWORD', taskId, '2'], repoRoot);
  assert.equal(byNumber.status, 0, byNumber.stderr);
  assert.equal(byNumber.stdout, byName.stdout);
});

test('no match exits 1 with empty stdout', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  writeTask(repoRoot, 'active', taskId, { 'analysis.md': 'nothing relevant\n' });
  alloc(repoRoot, taskId);

  const out = runCli(['task', 'grep', 'does-not-exist-zzz'], repoRoot);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, '');
});

test('a full-tree scan (no ref) does not reach archived tasks', () => {
  const { repoRoot } = mkFixture();
  const live = 'TASK-20260101-000001';
  const archived = 'TASK-20259999-000099';
  writeTask(repoRoot, 'active', live, { 'analysis.md': 'ARCHKEY live\n' });
  writeArchiveTask(repoRoot, archived, { 'analysis.md': 'ARCHKEY archived\n' });
  alloc(repoRoot, live);

  const out = runCli(['task', 'grep', 'ARCHKEY'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ARCHKEY live/);
  assert.doesNotMatch(out.stdout, /ARCHKEY archived/);
});

test('a TASK-id ref does reach an archived task', () => {
  const { repoRoot } = mkFixture();
  const archived = 'TASK-20259999-000099';
  writeArchiveTask(repoRoot, archived, { 'analysis.md': 'ARCHKEY archived\n' });

  const out = runCli(['task', 'grep', 'ARCHKEY', archived], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Archived task has no short id -> token omitted.
  assert.equal(out.stdout, `${archived} analysis:1: ARCHKEY archived\n`);
});

test('-- ends option parsing so a pattern can start with a dash', () => {
  const { repoRoot } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  writeTask(repoRoot, 'active', taskId, { 'analysis.md': 'flag like -i token\nplain line\n' });
  alloc(repoRoot, taskId);

  const out = runCli(['task', 'grep', '--', '-i'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /analysis:1: flag like -i token/);
  assert.doesNotMatch(out.stdout, /plain line/);
});

test('grep --help prints usage and exits zero', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'grep', '--help'], repoRoot);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task grep/);
});

test('grep with no pattern prints usage and exits non-zero', () => {
  const { repoRoot } = mkFixture();
  const out = runCli(['task', 'grep'], repoRoot);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task grep/);
});
