import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';

function fixture(step = 'requirement-analysis-review') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-event-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\ncurrent_step: ${step}\nassigned_to: claude\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.0.0\n---\n\n# Task\n\n## Activity Log\n\n`);
  return { root, id, file: path.join(dir, 'task.md') };
}

function run(root: string, args: string[]) {
  return spawnSync('node', [CLI_PATH, 'task', 'event', ...args], { cwd: root, encoding: 'utf8' });
}

test('task event applies a started/completed pair and replays as no-op', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /current_step: technical-design/);
});

test('dry-run returns planned without changing task bytes', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1', '--dry-run']);
  assert.equal(JSON.parse(out.stdout).status, 'planned');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('completion without an open start fails without changing the file', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md']);
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).error.code, 'EVENT_START_MISSING');
  assert.deepEqual(fs.readFileSync(f.file), before);
});
