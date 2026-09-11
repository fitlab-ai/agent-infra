import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { sha256File } from '../../../lib/task/artifact-receipts.ts';
import { createManualValidationReceipt, writeManualValidationReceiptAtomic } from '../../../lib/task/manual-validation-receipt.ts';
import { createManualValidationTransaction, summaryPreimageDigest, transitionManualValidationTransaction, writeManualValidationTransactionAtomic } from '../../../lib/task/manual-validation-transaction.ts';

// Branch matrix for the complete-task.preflight `manual-validation` check
// (see plan-r6). Completion requires a committed receipt, transaction, artifact
// digest, and a matching append-only Activity Log entry.

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

function addCommittedManualValidation(taskDir: string, appendCompletion = true) {
  const artifact = path.join(taskDir, 'manual-validation.md');
  fs.writeFileSync(artifact, '# Manual Validation\n');
  const now = new Date().toISOString();
  const evidenceDigest = 'a'.repeat(64);
  const prHeadSha = 'b'.repeat(40);
  const transaction = createManualValidationTransaction({
    transactionId: 'mv-test-1',
    taskId: 'TASK-20260101-000001',
    prNumber: 1,
    prHeadSha,
    evidenceDigest,
    summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
    pendingSummaryDigest: 'c'.repeat(64),
    finalSummaryDigest: 'd'.repeat(64),
    artifact: 'manual-validation.md',
    attempt: 1,
    createdAt: now,
    updatedAt: now
  });
  const receipt = createManualValidationReceipt({
    transactionId: transaction.transactionId,
    taskId: transaction.taskId,
    prNumber: transaction.prNumber,
    prHeadSha,
    evidenceDigest,
    artifact: 'manual-validation.md',
    artifactSha256: sha256File(artifact),
    pendingSummaryDigest: transaction.pendingSummaryDigest,
    finalSummaryDigest: transaction.finalSummaryDigest,
    committedAt: now
  });
  const staged = transitionManualValidationTransaction(transaction, 'summary-staged');
  assert.equal(staged.ok, true);
  const receiptCommitted = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
  assert.equal(receiptCommitted.ok, true);
  const eventAppended = transitionManualValidationTransaction(receiptCommitted.value, 'receipt-committed', { eventAppended: true });
  assert.equal(eventAppended.ok, true);
  const promoting = transitionManualValidationTransaction(eventAppended.value, 'final-promotion-in-progress');
  assert.equal(promoting.ok, true);
  const committed = transitionManualValidationTransaction(promoting.value, 'committed', { postWriteVerified: true });
  assert.equal(committed.ok, true);
  writeManualValidationReceiptAtomic(taskDir, receipt);
  writeManualValidationTransactionAtomic(taskDir, committed.value);
  const completion = `- 2026-01-01 00:00:01+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; human-confirmed validation and committed receipt; transaction=${transaction.transactionId}; receipt=${receipt.receiptDigest}; head=${prHeadSha}`;
  if (appendCompletion) {
    const taskPath = path.join(taskDir, 'task.md');
    const task = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(taskPath, task.replace(/\n$/, `\n${completion}\n`));
  }
  return { receipt, transaction: committed.value, completion };
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
  assert.match(result.message, /receipt is unavailable/);
});

test('manual-validation check passes on the standard flow when completion follows the latest review-code', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md',
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  addCommittedManualValidation(taskDir);
  const result = await check(taskDir);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /committed receipt and post-write verification/);
});

test('manual-validation check fails when completion predates a newer review-code round', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md',
    '- 2026-01-01 00:00:01+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; human-confirmed validation and committed receipt; transaction=mv-test-1; receipt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; head=cccccccccccccccccccccccccccccccccccccccc',
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 2)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code-r2.md'
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'review-code-r2.md'), REVIEW_CODE_MV_1);
  const committed = addCommittedManualValidation(taskDir, false);
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');
  fs.writeFileSync(taskPath, task.replace(/(- 2026-01-01 00:00:00\+00:00 — \*\*Review Code \(Round 2\)\*\*)/u, `${committed.completion}\n$1`));
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /Latest review-code \(round 2\) came after/);
});

test('manual-validation check fails closed when the latest review-code completion entry is missing', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md'
  ]);
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), REVIEW_CODE_MV_1);
  addCommittedManualValidation(taskDir, false);
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /Committed manual validation completion is not recorded/);
});
