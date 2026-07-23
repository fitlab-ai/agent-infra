import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

test('internal task-snapshot resolves full and short task refs without writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-snapshot-integration-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const active = path.join(root, '.agents', 'workspace', 'active');
  const dir = path.join(active, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(active, '.short-ids.json'), JSON.stringify({ version: 1, ids: { '01': id } }));
  fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n');
  const before = fs.readFileSync(path.join(dir, 'task.md'));

  for (const ref of ['1', id]) {
    const out = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-snapshot', ref, '--format', 'json'], { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).taskId, id);
  }
  assert.deepEqual(fs.readFileSync(path.join(dir, 'task.md')), before);

  const invalid = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-snapshot', 'not-a-task'], { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_TASK_REF');

  const duplicate = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-snapshot', id, '--format', 'json', '--format', 'text'], { cwd: root, encoding: 'utf8' });
  assert.equal(duplicate.status, 1);
  assert.equal(JSON.parse(duplicate.stdout).error.code, 'SNAPSHOT_PAYLOAD_INVALID');
});
