import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-orchestration-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  return { root, id, dir };
}

function run(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-orchestration', ...args], { cwd: root, encoding: 'utf8' });
}

test('task-orchestration begins idempotently and exposes a structured route', () => {
  const f = fixture();
  const begin = run(f.root, [f.id, 'begin-or-resume', '--max-steps', '8',
    '--executor-model', 'executor-model', '--reviewer-model', 'reviewer-model']);
  assert.equal(begin.status, 0, begin.stderr);
  const begun = JSON.parse(begin.stdout);
  assert.equal(begun.status, 'running');
  assert.equal(begun.changed, true);
  assert.equal(begun.run.maxSteps, 8);
  assert.deepEqual(begun.run.modelPolicy, {
    executor: 'executor-model', reviewer: 'reviewer-model', sameModelReason: null
  });
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), true);

  const second = run(f.root, [f.id, 'begin-or-resume']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).changed, false);

  const route = run(f.root, [f.id, 'route']);
  assert.equal(route.status, 0, route.stderr);
  assert.deepEqual(JSON.parse(route.stdout).next, {
    action: 'analyze-task', role: 'executor', stage: 'analysis', round: 1,
    artifact: 'analysis.md', requestedModel: 'executor-model'
  });
});

test('task-orchestration rejects duplicate and unknown options without writing state', () => {
  const f = fixture();
  const result = run(f.root, [f.id, 'begin-or-resume', '--max-steps', '8', '--max-steps', '9']);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'ORCHESTRATION_PAYLOAD_INVALID');
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), false);
});

test('task-orchestration rejects partial model policy options before core state changes', () => {
  const f = fixture();
  const first = run(f.root, [f.id, 'begin-or-resume', '--executor-model', 'executor-model']);
  assert.equal(first.status, 2);
  assert.equal(JSON.parse(first.stdout).error.code, 'ORCHESTRATION_PAYLOAD_INVALID');
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), false);

  assert.equal(run(f.root, [f.id, 'begin-or-resume', '--executor-model', 'executor-model',
    '--reviewer-model', 'reviewer-model']).status, 0);
  const runPath = path.join(f.dir, 'orchestration.json');
  const before = fs.readFileSync(runPath);
  const reentry = run(f.root, [f.id, 'begin-or-resume', '--reviewer-model', 'reviewer-model']);
  assert.equal(reentry.status, 2);
  assert.equal(JSON.parse(reentry.stdout).error.code, 'ORCHESTRATION_PAYLOAD_INVALID');
  assert.deepEqual(fs.readFileSync(runPath), before);
});

test('task-orchestration prepare derives the workspace baseline with the persisted role model', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'begin-or-resume', '--executor-model', 'executor-model',
    '--reviewer-model', 'reviewer-model']).status, 0);

  const prepared = run(f.root, [f.id, 'prepare', '--client', 'claude-code',
    '--requested-model', 'executor-model']);
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout);
  assert.equal(result.run.pendingDelegation.parentId, null);
  assert.equal(result.run.pendingDelegation.workspaceSnapshotScope, 'task');
  assert.match(result.run.pendingDelegation.beforeFingerprint, /^[0-9a-f]{40,64}$/);
});

test('task-orchestration begin accepts an omitted model policy and runs without one', () => {
  const f = fixture();
  const result = run(f.root, [f.id, 'begin-or-resume']);
  assert.equal(result.status, 0, result.stderr);
  const begun = JSON.parse(result.stdout);
  assert.equal(begun.status, 'running');
  assert.equal(begun.run.modelPolicy, undefined);
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), true);

  const route = run(f.root, [f.id, 'route']);
  assert.equal(route.status, 0, route.stderr);
  assert.equal(JSON.parse(route.stdout).next.requestedModel, null);

  const prepared = run(f.root, [f.id, 'prepare', '--client', 'claude-code']);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).run.pendingDelegation.requestedModel, null);
});
