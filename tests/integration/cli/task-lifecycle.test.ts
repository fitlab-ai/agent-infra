import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, sandboxControlSafeEnv } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lifecycle-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\ncurrent_step: code-review\nupdated_at: old\nagent_infra_version: old\ntarget_date:\n---\n\n# Task\n\n## Activity Log\n\n`);
  return { root, dir };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = sandboxControlSafeEnv()) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-lifecycle', ...args], {
    cwd: root,
    encoding: 'utf8',
    env
  });
}

test('task-lifecycle CLI stays inside its fixture with sandbox control authority removed', () => {
  const f = fixture();
  const env = sandboxControlSafeEnv({
    ...process.env,
    AGENT_INFRA_CONTROL_TOKEN: 'live-sandbox-token',
    AGENT_INFRA_CONTROL_DIR: path.join(f.root, 'live-control-channel')
  });
  const result = run(f.root, [TASK_ID, 'complete', '--agent', 'codex'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).taskId, TASK_ID);
  assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
});

test('task-lifecycle CLI prints one JSON result and uses domain exit codes', () => {
  const f = fixture();
  const dry = run(f.root, [TASK_ID, 'complete', '--agent', 'codex', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(dry.stdout).status, 'planned');
  const applied = run(f.root, [TASK_ID, 'complete', '--agent', 'codex']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, 'applied');
  const conflict = run(f.root, [TASK_ID, 'cancel', '--agent', 'codex', '--reason', 'different']);
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stdout).error.code, 'LIFECYCLE_INTENT_CONFLICT');
});

test('task-lifecycle CLI rejects unknown and duplicate options as one JSON failure', () => {
  const f = fixture();
  for (const args of [
    [TASK_ID, 'complete', '--agent', 'codex', '--unknown', 'x'],
    [TASK_ID, 'complete', '--agent', 'codex', '--agent', 'again']
  ]) {
    const result = run(f.root, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'LIFECYCLE_PAYLOAD_INVALID');
  }
});

const RESTORE_TASK_ID = 'TASK-20260202-000002';

function stagingFixture({ initGit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lifecycle-restore-cli-'));
  if (initGit) spawnSync('git', ['init', '-q'], { cwd: root });
  const staging = path.join(root, '.agents', 'workspace', '.restore-staging-1');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(staging, 'task.md'), `---\nid: ${RESTORE_TASK_ID}\nissue_number: 42\nstatus: active\ncurrent_step: requirement-analysis\nupdated_at: old\nagent_infra_version: old\n---\n\n# Task\n\n## Activity Log\n\n`);
  return { root, staging };
}

test('task-lifecycle CLI restore applies staging for a task that does not exist locally', () => {
  const f = stagingFixture();
  const result = run(f.root, [RESTORE_TASK_ID, 'restore', '--agent', 'codex', '--staging-dir', f.staging, '--issue-number', '42']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'applied');
  assert.equal(parsed.shortId.shortId, '01');
  assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'active', RESTORE_TASK_ID, 'task.md')), true);
  assert.equal(fs.existsSync(f.staging), false);
});

test('task-lifecycle CLI restore rejects short ids and malformed TASK-ids with LIFECYCLE_IDENTITY_INVALID', () => {
  const f = stagingFixture();
  for (const ref of ['1', 'not-a-task-id']) {
    const result = run(f.root, [ref, 'restore', '--agent', 'codex', '--staging-dir', f.staging, '--issue-number', '42']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'LIFECYCLE_IDENTITY_INVALID');
  }
});

test('task-lifecycle CLI restore fails closed with REPO_ROOT_NOT_FOUND outside a git repository', () => {
  const f = stagingFixture({ initGit: false });
  const result = run(f.root, [RESTORE_TASK_ID, 'restore', '--agent', 'codex', '--staging-dir', f.staging, '--issue-number', '42']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'REPO_ROOT_NOT_FOUND');
});
