import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';
import { parseTaskQualification } from '../../../lib/task/qualification-audit.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qualify-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
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

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, 'qualify', ...args], { cwd: root, encoding: 'utf8' });
}

test('ai qualify exposes supersede and revoke transitions', () => {
  for (const transition of ['--supersede', '--revoke'] as const) {
    const f = fixture();
    try {
      const confirmed = run(f.root, ['--task', TASK_ID, '--constraint', 'C-1', '--digest', digest(f.taskPath), 'Confirm constraint.']);
      assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);
      const changed = run(f.root, ['--task', TASK_ID, '--constraint', 'C-1', '--digest', digest(f.taskPath), transition, 'Change confirmation.']);
      assert.equal(changed.status, 0, changed.stderr || changed.stdout);
      const parsed = parseTaskQualification(fs.readFileSync(f.taskPath, 'utf8'));
      assert.equal(parsed.ok, true);
      if (!parsed.ok) continue;
      assert.equal(parsed.qualification.constraints[0]?.status, transition === '--supersede' ? 'superseded' : 'open');
      assert.equal(parsed.qualification.constraints[0]?.approvalEvidence, '');
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('ai qualify rejects conflicting transition flags', () => {
  const f = fixture();
  try {
    const result = run(f.root, [
      '--task', TASK_ID, '--constraint', 'C-1', '--digest', digest(f.taskPath),
      '--supersede', '--revoke', 'Invalid transition.'
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be combined/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
