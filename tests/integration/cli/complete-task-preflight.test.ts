import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-task-preflight-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const activeDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
    skill: 'complete-task', checks: {
      'review-ledger': null, 'post-review-commit': null,
      'required-checks': null, 'platform-sync-preflight': null
    }
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
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], { cwd: root, encoding: 'utf8' });
}

test('platform-sync-preflight is a distinct typed verification result', () => {
  const f = fixture();
  try {
    const result = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.invocations[3].payload.type, 'platform-sync-preflight');
    assert.equal(payload.invocations[3].status, 'pass');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('preflight success permits one archive and releases the short id', () => {
  const f = fixture();
  try {
    const preflight = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 4);
    const completed = run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal(run(f.root, ['task-context', 'resolve', '#01']).status, 1);
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
