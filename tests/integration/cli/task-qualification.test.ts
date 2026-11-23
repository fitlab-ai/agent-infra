import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTempDir, INTERNAL_CLI_PATH } from '../../helpers.ts';
import { parseTaskQualification } from '../../../lib/task/qualification-audit.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = createTempDir('qualify-cli-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(taskWorkspaceRoot(root),  'active', TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  const taskPath = path.join(dir, 'task.md');
  fs.writeFileSync(taskPath, `---
id: ${TASK_ID}
status: active
updated_at: 2026-01-01 00:00:00+00:00
agent_infra_version: v0.9.13-alpha.0
---

# Task

## 约束

| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Keep the public writer | derived | plan | plan.md | plan.md#scope |  |  |

## 候选与否决方案

| candidate_id | statement | status | constraint_ids | impact | evidence |
| --- | --- | --- | --- | --- | --- |
| A | Use the writer | pending | C-1 | Small | task.md#input |

## 审查分歧账本

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 活动日志

- 2026-01-01 00:00:00+00:00 — **Create Task** by codex — created
`);
  return { root, taskPath };
}

function digest(taskPath: string): string {
  const parsed = parseTaskQualification(fs.readFileSync(taskPath, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.qualification.constraintDigest;
}

function run(root: string, operation: 'confirm' | 'supersede' | 'revoke', taskPath: string, rationale: string) {
  const input = path.join(root, `${operation}.json`);
  fs.writeFileSync(input, JSON.stringify({ constraintId: 'C-1', expectedDigest: digest(taskPath), rationale }));
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', TASK_ID, operation, '--input', input], { cwd: root, encoding: 'utf8' });
}

test('internal task-qualification exposes supersede and revoke transitions', () => {
  for (const transition of ['supersede', 'revoke'] as const) {
    const f = fixture();
    try {
      const confirmed = run(f.root, 'confirm', f.taskPath, 'Confirm constraint.');
      assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);
      const changed = run(f.root, transition, f.taskPath, 'Change confirmation.');
      assert.equal(changed.status, 0, changed.stderr || changed.stdout);
      const parsed = parseTaskQualification(fs.readFileSync(f.taskPath, 'utf8'));
      assert.equal(parsed.ok, true);
      if (!parsed.ok) continue;
      assert.equal(parsed.qualification.constraints[0]?.status, transition === 'supersede' ? 'superseded' : 'open');
      assert.equal(parsed.qualification.constraints[0]?.approvalEvidence, '');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('internal task-qualification rejects unknown operations', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', TASK_ID, 'unknown', '--input', f.taskPath], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'QUALIFICATION_PROPOSAL_INVALID');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('internal task-qualification rejects duplicate or missing options', () => {
  const f = fixture();
  try {
    const duplicateInput = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', TASK_ID, 'confirm',
      '--input', f.taskPath, '--input', f.taskPath], { cwd: f.root, encoding: 'utf8' });
    assert.equal(duplicateInput.status, 1);
    assert.equal(JSON.parse(duplicateInput.stdout).error.code, 'QUALIFICATION_PROPOSAL_INVALID');

    const missingInput = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', TASK_ID, 'confirm'], {
      cwd: f.root, encoding: 'utf8'
    });
    assert.equal(missingInput.status, 1);
    assert.equal(JSON.parse(missingInput.stdout).error.code, 'QUALIFICATION_PROPOSAL_INVALID');

    const duplicateDryRun = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', TASK_ID, 'confirm',
      '--input', f.taskPath, '--dry-run', '--dry-run'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(duplicateDryRun.status, 1);
    assert.equal(JSON.parse(duplicateDryRun.stdout).error.code, 'QUALIFICATION_PROPOSAL_INVALID');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('CLI controls task identity, operation and dry-run for both qualification handlers', () => {
  for (const operation of ['proposal', 'confirm'] as const) {
    for (const dryRun of [true, false]) {
      const f = fixture();
      try {
        const before = fs.readFileSync(f.taskPath, 'utf8');
        const parsed = parseTaskQualification(before);
        assert.equal(parsed.ok, true);
        const payload = operation === 'proposal' ? {
          taskRef: 'invalid', dryRun: !dryRun, expectedTaskInputDigest: parsed.qualification.taskInputDigest,
          constraints: [{ constraintId: 'C-2', statement: 'Use atomic writes', status: 'assumption', authority: 'model', source: 'analysis.md', evidence: 'analysis.md#risk', derivedFrom: [], approvalEvidence: '' }]
        } : {
          taskRef: 'invalid', dryRun: !dryRun, operation: 'revoke', constraintId: 'C-1',
          expectedDigest: parsed.qualification.constraintDigest, rationale: 'Confirm constraint.'
        };
        const input = path.join(f.root, 'input.json');
        fs.writeFileSync(input, JSON.stringify(payload));
        const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', TASK_ID, operation, '--input', input, ...(dryRun ? ['--dry-run'] : [])], { cwd: f.root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const response = JSON.parse(result.stdout);
        assert.equal(response.taskId, TASK_ID);
        assert.equal(response.status, dryRun ? 'planned' : 'applied');
        const after = fs.readFileSync(f.taskPath, 'utf8');
        if (dryRun) assert.equal(after, before);
        else {
          const updated = parseTaskQualification(after);
          assert.equal(updated.ok, true);
          assert.equal(updated.qualification.constraints.find((row) => row.constraintId === (operation === 'proposal' ? 'C-2' : 'C-1'))?.status, operation === 'proposal' ? 'assumption' : 'confirmed');
        }
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    }
  }
});

test('CLI preserves error precedence across operation, options and input', () => {
  const f = fixture();
  try {
    const malformed = path.join(f.root, 'malformed.json');
    fs.writeFileSync(malformed, '{');
    const cases = [
      { args: ['missing', 'unknown', '--input', malformed], message: 'task ref and a valid qualification operation are required' },
      { args: ['missing', 'confirm', '--input', malformed, '--input', malformed], message: "unknown or duplicate option '--input'" },
      { args: ['missing', 'confirm', '--input', malformed], prefix: 'cannot read qualification input:' }
    ];
    for (const item of cases) {
      const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-qualification', ...item.args], { cwd: f.root, encoding: 'utf8' });
      assert.equal(result.status, 1);
      const error = JSON.parse(result.stdout).error;
      assert.equal(error.code, 'QUALIFICATION_PROPOSAL_INVALID');
      if (item.message) assert.equal(error.message, item.message);
      else assert.ok(error.message.startsWith(item.prefix));
      assert.ok(result.stderr.startsWith('Usage:'));
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
