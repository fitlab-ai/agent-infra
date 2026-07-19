import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-warning-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nupdated_at: old\nagent_infra_version: old\n---\n# Task\n\n## Activity Log\n`);
  return { root, id, file: path.join(dir, 'task.md') };
}

function run(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-warning', ...args], { cwd: root, encoding: 'utf8' });
}

test('task-warning add/list/set-status preserves structured warning data', () => {
  const f = fixture();
  try {
    const added = run(f.root, [f.id, 'add', '--step', 'issue-sync', '--severity', 'IMPORTANT', '--code', 'SYNC', '--target', 'task', '--message', 'failed | once', '--action', 'retry']);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).entityId, 'WW-1');
    const listed = run(f.root, [f.id, 'list', '--status', 'open']);
    assert.equal(JSON.parse(listed.stdout).warnings[0].message, 'failed | once');
    const resolved = run(f.root, [f.id, 'set-status', '--id', 'WW-1', '--status', 'resolved', '--resolution', 'done']);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).after.status, 'resolved');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('task-warning rejects invalid enum values without changing task.md', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.file);
    const result = run(f.root, [f.id, 'add', '--step', 'x', '--severity', 'LOW', '--code', 'X', '--target', 'x', '--message', 'x', '--action', 'x']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'WARNING_PAYLOAD_INVALID');
    assert.deepEqual(fs.readFileSync(f.file), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
