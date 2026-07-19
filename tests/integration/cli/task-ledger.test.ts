import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ledger-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const active = path.join(root, '.agents', 'workspace', 'active');
  const dir = path.join(active, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(active, '.short-ids.json'), JSON.stringify({ version: 1, ids: { '07': id } }));
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nupdated_at: old\nagent_infra_version: old\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  return { root, id, file: path.join(dir, 'task.md') };
}

function run(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-ledger', ...args], { cwd: root, encoding: 'utf8' });
}

test('task-ledger accepts a short id and returns structured applied/no-op results', () => {
  const f = fixture();
  try {
    const args = ['7', 'finding-upsert', '--stage', 'code', '--review-artifact', 'review-code.md', '--ordinal', '1', '--severity', 'major', '--evidence', 'review-code.md#CD-1'];
    const applied = run(f.root, args);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).entityId, 'CD-1');
    assert.equal(JSON.parse(run(f.root, args).stdout).status, 'no-op');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('task-ledger rejects duplicate flags and preserves bytes for dry-run', () => {
  const f = fixture();
  try {
    const bad = run(f.root, [f.id, 'decision-next-id', '--dry-run', '--dry-run']);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).error.code, 'LEDGER_PAYLOAD_INVALID');
    const before = fs.readFileSync(f.file);
    const planned = run(f.root, [f.id, 'decision-upsert', '--id', 'HD-1', '--stage', 'plan', '--artifact', 'plan.md', '--dry-run']);
    assert.equal(JSON.parse(planned.stdout).status, 'planned');
    assert.deepEqual(fs.readFileSync(f.file), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
