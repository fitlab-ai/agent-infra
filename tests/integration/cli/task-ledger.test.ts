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
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nupdated_at: old\nagent_infra_version: old\n---\n# Task\n\n## Implementation Inputs\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
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

test('task-ledger parses implementation intent for code decisions', () => {
  const f = fixture();
  try {
    const applied = run(f.root, [
      f.id, 'decision-upsert', '--id', 'HD-1', '--stage', 'code', '--artifact', 'code.md',
      '--needs-implementation', 'false'
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(fs.readFileSync(f.file, 'utf8'), /\| II-1 \| HD-1 \| code\.md#HD-1 \| code \| false \|\s*\| declared \|/);
    const invalid = run(f.root, [
      f.id, 'decision-upsert', '--id', 'HD-2', '--stage', 'code', '--artifact', 'code.md',
      '--needs-implementation', 'maybe'
    ]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'LEDGER_PAYLOAD_INVALID');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('task-ledger stage-status is read-only and reports unresolved minor findings', () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.file, '| AN-1 | analysis | 1 | minor | open | review-analysis.md#AN-1 |\n');
    const before = fs.readFileSync(f.file);
    const beforeMtime = fs.statSync(f.file).mtimeMs;
    const result = run(f.root, ['7', 'stage-status', '--stage', 'analysis']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.changed, false);
    assert.equal(payload.stageStatus.canAdvance, false);
    assert.deepEqual(payload.stageStatus.unresolvedFindingCounts, { blocker: 0, major: 0, minor: 1 });
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.statSync(f.file).mtimeMs, beforeMtime);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('task-ledger stage-status rejects invalid stages and invalid ledger rows', () => {
  const f = fixture();
  try {
    const badStage = run(f.root, [f.id, 'stage-status', '--stage', 'delivery']);
    assert.equal(badStage.status, 1);
    assert.equal(JSON.parse(badStage.stdout).error.code, 'LEDGER_PAYLOAD_INVALID');

    fs.appendFileSync(f.file, '| AN-1 | analysis | 1 | advisory | open | review-analysis.md#AN-1 |\n');
    const badLedger = run(f.root, [f.id, 'stage-status', '--stage', 'analysis']);
    assert.equal(badLedger.status, 1);
    assert.equal(JSON.parse(badLedger.stdout).error.code, 'LEDGER_DOCUMENT_INVALID');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
