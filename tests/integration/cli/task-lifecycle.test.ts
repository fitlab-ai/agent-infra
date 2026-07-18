import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

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

function run(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-lifecycle', ...args], { cwd: root, encoding: 'utf8' });
}

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
