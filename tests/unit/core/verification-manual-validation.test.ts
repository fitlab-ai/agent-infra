import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';

// Branch matrix for the complete-task.preflight `manual-validation` check
// (see plan-r5 改动二). The decision relies only on the latest review-code
// artifact plus the append-only Activity Log, so the fixture is a bare task
// directory with task.md and optional artifacts.

const REVIEW_CODE_MV_1 = `# Code Review

## 审查摘要

- **总体结论**：通过
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：1
`;

function fixture(activityEntries: string[]) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-manual-validation-'));
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: TASK-20260101-000001
---

# Task

## 活动日志

${activityEntries.join('\n')}
`);
  return taskDir;
}

async function check(taskDir: string) {
  return verifyInProcess({
    mode: 'check',
    skillName: 'complete-task',
    taskDir,
    artifactFile: undefined,
    checks: ['manual-validation'],
    repositoryRoot: process.cwd()
  });
}

test('manual-validation check passes when no review-code artifact exists', async () => {
  const taskDir = fixture([]);
  const result = await check(taskDir);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /No review-code artifact/);
});

test('manual-validation check passes when the latest review-code has zero pending items', async () => {
  const taskDir = fixture([]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1.replace('**人工校验**：1', '**人工校验**：0'));
  const result = await check(taskDir);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /No pending manual validation items/);
});

test('manual-validation check fails when pending items exist without a manual-validation artifact', async () => {
  const taskDir = fixture([]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /manual validation item\(s\) pending/);
});

test('manual-validation check fails when the artifact exists but completion is not recorded', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md'
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /completion is not recorded/);
});

test('manual-validation check passes on the standard flow when completion follows the latest review-code', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md',
    '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; verified on staging'
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
  const result = await check(taskDir);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /Manual validation completed → manual-validation\.md/);
});

test('manual-validation check fails when completion predates a newer review-code round', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md',
    '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; verified on staging',
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 2)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code-r2.md'
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'review-code-r2.md'), REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /Latest review-code \(round 2\) came after/);
});

test('manual-validation check fails closed when the latest review-code completion entry is missing', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; verified on staging'
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /completion entry is missing from the Activity Log/);
});
