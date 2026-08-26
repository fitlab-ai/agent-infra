import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, gitSafeEnv, sandboxControlSafeEnv } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-task-preflight-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const activeDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ prFlow: 'disabled', task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
    skill: 'complete-task', checks: { 'required-pr-delivery': null }
  }));
  fs.writeFileSync(path.join(activeDir, 'task.md'), [
    '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
    'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
    'target_date:', '---', '', '# Task', '', '## Workflow Warnings', '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '', '## Activity Log', ''
  ].join('\n'));
  return { root, activeDir };
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: sandboxControlSafeEnv()
  });
}

test('compiled preflight does not require a checks snapshot for a bound historical PR', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'README.md'), 'fixture\n');
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: f.root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: f.root });
    spawnSync('git', ['add', 'README.md'], { cwd: f.root });
    const committed = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: f.root });

    fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), JSON.stringify({
      platform: { type: 'github' },
      prFlow: 'disabled',
      task: { shortIdLength: 2 }
    }));
    fs.writeFileSync(path.join(f.root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
      skill: 'complete-task',
      checks: { 'required-pr-delivery': null }
    }));
    fs.writeFileSync(path.join(f.activeDir, 'task.md'), [
      '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
      'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
      'pr_number: 42', 'pr_status: merged', `last_reviewed_commit: ${head}`,
      'target_date:', '---', '', '# Task', ''
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      INTERNAL_CLI_PATH, 'task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json'
    ], {
      cwd: f.root,
      encoding: 'utf8',
      env: sandboxControlSafeEnv(gitSafeEnv(process.env))
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      payload.invocations.map((invocation: { payload: { type: string } }) => invocation.payload.type),
      ['required-pr-delivery']
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('preflight success permits one archive and releases the short id', () => {
  const f = fixture();
  try {
    const preflight = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 1);
    const completed = run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal(run(f.root, ['task-context', 'resolve', '#01']).status, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('host finalization CLI completes the terminal sequence and makes replay idempotent', () => {
  const f = fixture();
  try {
    const first = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.status, 'completed');
    assert.equal(firstPayload.accepted, true);
    assert.equal(firstPayload.result.status, 'completed');
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);

    const second = run(f.root, ['task-finalization', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.status, 'completed');
    assert.equal(secondPayload.changed, false);
    assert.equal((fs.readFileSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8').match(/Complete Task/g) ?? []).length, 2);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('completed verification resolves the archived task without moving it back to active', () => {
  const f = fixture();
  try {
    assert.equal(run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']).status, 0);
    const verified = run(f.root, ['task-verify', TASK_ID, 'complete-task.completed', '--format', 'text']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Verification: pass \| Skill: complete-task/);
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'active', TASK_ID)), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
