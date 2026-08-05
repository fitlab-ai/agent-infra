import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyActivityAppendIntent } from '../../../lib/task/activity-intent.ts';
import { VERSION } from '../../../lib/version.ts';

function fixtureTask() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-intent-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const content = `---
id: ${taskId}
type: feature
workflow: feature-development
status: active
created_at: 2026-01-01 00:00:00+08:00
updated_at: 2026-01-01 00:00:00+08:00
agent_infra_version: v0.9.2
current_step: technical-design-review
assigned_to: claude-code
---

# 任务

## 活动日志

- 2026-01-01 00:00:00+08:00 — **Plan Task** by claude-code — plan done
`;
  fs.writeFileSync(path.join(taskDir, 'task.md'), content);
  return { root, taskId, taskDir };
}

test('task-activity append adds an Activity Log entry and refreshes version stamps without changing current_step', () => {
  const fixture = fixtureTask();
  try {
    const result = applyActivityAppendIntent({
      kind: 'append', taskRef: fixture.taskId,
      step: 'Review PR (Round 1)', agent: 'claude-code', note: 'receipt abc123'
    }, { repoRoot: fixture.root });
    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
    const updated = fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8');
    assert.match(updated, /\*\*Review PR \(Round 1\)\*\* by claude-code — receipt abc123/);
    assert.match(updated, /^current_step: technical-design-review$/m, 'current_step must not change');
    assert.match(updated, new RegExp(`^agent_infra_version: ${VERSION.replace('.', '\\.')}$`, 'm'));
    assert.match(updated, /^updated_at: \d{4}-\d{2}-\d{2} /m);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-activity append with a canonical pr-review artifact adds a review-feedback link', () => {
  const fixture = fixtureTask();
  try {
    const result = applyActivityAppendIntent({
      kind: 'append', taskRef: fixture.taskId,
      step: 'Review PR (Round 2)', agent: 'claude-code', note: 'receipt abc123', artifact: 'pr-review-r2.md'
    }, { repoRoot: fixture.root });
    assert.equal(result.status, 'applied');
    const updated = fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8');
    assert.match(updated, /## 审查反馈/);
    assert.match(updated, /\[PR 审查报告（Round 2）\]\(pr-review-r2\.md\)/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-activity append rejects non-canonical or non-pr-review artifacts', () => {
  const fixture = fixtureTask();
  try {
    const result = applyActivityAppendIntent({
      kind: 'append', taskRef: fixture.taskId,
      step: 'Review PR (Round 1)', agent: 'claude-code', note: 'receipt', artifact: 'code.md'
    }, { repoRoot: fixture.root });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'ACTIVITY_ARTIFACT_INVALID');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-activity append rejects empty or multiline payloads', () => {
  const fixture = fixtureTask();
  try {
    const missing = applyActivityAppendIntent({
      kind: 'append', taskRef: fixture.taskId,
      step: '', agent: 'claude-code', note: 'receipt'
    }, { repoRoot: fixture.root });
    assert.equal(missing.status, 'failed');
    assert.equal(missing.error?.code, 'ACTIVITY_INTENT_INVALID');

    const multiline = applyActivityAppendIntent({
      kind: 'append', taskRef: fixture.taskId,
      step: 'Review PR (Round 1)', agent: 'claude-code', note: 'line1\nline2'
    }, { repoRoot: fixture.root });
    assert.equal(multiline.status, 'failed');
    assert.equal(multiline.error?.code, 'ACTIVITY_INTENT_INVALID');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-activity append dry-run reports planned and leaves the task untouched', () => {
  const fixture = fixtureTask();
  try {
    const before = fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8');
    const result = applyActivityAppendIntent({
      kind: 'append', taskRef: fixture.taskId,
      step: 'Review PR (Round 1)', agent: 'claude-code', note: 'receipt', dryRun: true
    }, { repoRoot: fixture.root });
    assert.equal(result.status, 'planned');
    assert.equal(fs.readFileSync(path.join(fixture.taskDir, 'task.md'), 'utf8'), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task-activity append rejects a task that is not active', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-intent-'));
  try {
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'completed', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: completed\n---\n`);
    const result = applyActivityAppendIntent({
      kind: 'append', taskRef: taskId,
      step: 'Review PR (Round 1)', agent: 'claude-code', note: 'receipt'
    }, { repoRoot: root });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'TASK_STATE_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
