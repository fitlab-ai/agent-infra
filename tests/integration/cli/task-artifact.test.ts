import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-artifact-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\ncurrent_step: requirement-analysis-review\n---\n\n# Task\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), '# Analysis\n');
  return { root, id, dir };
}

function run(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-artifact', ...args], { cwd: root, encoding: 'utf8' });
}

test('task-artifact inspect returns one read-only JSON context', () => {
  const f = fixture();
  const before = fs.readdirSync(f.dir).sort();
  const out = run(f.root, [f.id, 'inspect', '--family', 'plan']);
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'ready');
  assert.equal(result.changed, false);
  assert.deepEqual(result.next, { round: 1, name: 'plan.md' });
  assert.equal(result.inputs[0].name, 'analysis.md');
  assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
});

test('task-artifact reports usage and domain failures with nonzero exit codes', () => {
  const f = fixture();
  const usage = run(f.root, [f.id, 'inspect', '--family']);
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stdout).error.code, 'ARTIFACT_PAYLOAD_INVALID');
  const unknown = run(f.root, [f.id, 'inspect', '--family', 'unknown']);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'ARTIFACT_FAMILY_UNKNOWN');
});
