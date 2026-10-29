import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { sha256File } from '../../../lib/task/artifact-receipts.ts';
import { createManualValidationReceipt, writeManualValidationReceiptAtomic } from '../../../lib/task/manual-validation-receipt.ts';
import { createManualValidationTransaction, summaryPreimageDigest, transitionManualValidationTransaction, writeManualValidationTransactionAtomic } from '../../../lib/task/manual-validation-transaction.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { createTempDir } from '../../helpers.ts';

// Branch matrix for the complete-task.preflight `manual-validation` check
// (see plan-r6). Completion requires a committed receipt, transaction, artifact
// digest, and a review completion time preceding the committed receipt.

const REVIEW_CODE_MV_1 = `# Code Review

## 审查摘要

- **总体结论**：通过
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：1
`;

function fixture(activityEntries: string[]) {
  const taskDir = createTempDir('verification-manual-validation-');
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: TASK-20260101-000001
---

# Task

## 活动日志

${activityEntries.join('\n')}
`);
  return taskDir;
}

function markReviewCodeCompleted(taskDir: string, content: string, completedAt = "2026-01-01 08:00:00+08:00"): void {
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), content);
  const names = fs.readdirSync(taskDir).filter((name) => /^review-code(?:-r[2-9]\d*)?\.md$/u.test(name)).sort((left, right) => {
    const round = (name: string) => name === 'review-code.md' ? 1 : Number(/-r(\d+)\.md$/u.exec(name)?.[1]);
    return round(left) - round(right);
  });
  const facts = names.map((name) => {
    const artifact = path.join(taskDir, name);
    const artifactContent = fs.readFileSync(artifact, 'utf8');
    const round = name === 'review-code.md' ? 1 : Number(/-r(\d+)\.md$/u.exec(name)?.[1]);
    return {
      event: 'review-code.completed', output: name, outputSha256: sha256File(artifact),
      semanticDigest: canonicalSemanticDigest(artifactContent), requestId: `review-code-test-${round}`, result: 'completed', lifecycleInputs: [], round
    };
  });
  const taskPath = path.join(taskDir, 'task.md');
  let task = fs.readFileSync(taskPath, 'utf8');
  const fmEnd = task.indexOf('\n---', 4);
  task = `${task.slice(0, fmEnd)}\ncompletion_facts: '${JSON.stringify(facts)}'${task.slice(fmEnd)}`;
  const rows = facts.flatMap((fact, index) => {
    const step = `Review Code (Round ${fact.round})`;
    const baseSecond = 2 + index * 2;
    return [
      `- 2026-01-01 00:0${baseSecond}:00+00:00 — **${step} [started]** by claude — started`,
      `- 2026-01-01 00:0${baseSecond}:01+00:00 — **${step}** by claude — Review completed → ${fact.output}`
    ];
  }).join('\n');
  task += `${task.endsWith('\n') ? '' : '\n'}${rows}\n\n## 产物生命周期收据\n\n| event | output | input | input_sha256 | completed_at |\n| --- | --- | --- | --- | --- |\n${facts.map((fact) => `| review-code.completed | ${fact.output} | code.md | ${'a'.repeat(64)} | ${completedAt} |`).join('\n')}\n`;
  fs.writeFileSync(taskPath, task);
}

function addCommittedManualValidation(taskDir: string, appendCompletion = true, committedAt = "2026-01-01T00:00:01.000Z") {
  const artifact = path.join(taskDir, 'manual-validation.md');
  fs.writeFileSync(artifact, '# Manual Validation\n');
  const now = committedAt;
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
  markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1.replace('**人工校验**：1', '**人工校验**：0'));
  const result = await check(taskDir);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /No pending manual validation items/);
});

test('manual-validation check fails when pending items exist without a manual-validation artifact', async () => {
  const taskDir = fixture([]);
  markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1);
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /manual validation item\(s\) pending/);
});

test('manual-validation check fails when the artifact exists but completion is not recorded', async () => {
  const taskDir = fixture([
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md'
  ]);
  markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1);
  fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
  const result = await check(taskDir);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /receipt is unavailable/);
});

test('manual validation uses receipt times independent of activity log', async () => {
  const taskDir = fixture([]);
  markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1);
  addCommittedManualValidation(taskDir, false);
  const taskPath = path.join(taskDir, 'task.md');
  const original = fs.readFileSync(taskPath, 'utf8');
  for (const log of ['', 'malformed log entry', '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — done']) {
    fs.writeFileSync(taskPath, original.replace(/## 活动日志[\s\S]*?(?=## 产物生命周期收据)/u, log ? `## 活动日志\n\n${log}\n\n` : ''));
    assert.equal((await check(taskDir)).status, 'pass');
  }
});

test('manual validation must be strictly later than the latest review completion', async () => {
  for (const [reviewTime, expected] of [
    ['2026-01-01 08:00:00+08:00', 'pass'],
    ['2026-01-01 00:00:01+00:00', 'fail'],
    ['2026-01-01 00:00:02+00:00', 'fail']
  ]) {
    const taskDir = fixture([]);
    markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1, reviewTime);
    addCommittedManualValidation(taskDir, false);
    assert.equal((await check(taskDir)).status, expected);
  }
});

test('manual validation fails if review completion time is missing or invalid', async () => {
  for (const reviewTime of ['', 'invalid']) {
    const taskDir = fixture([]);
    markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1, reviewTime);
    addCommittedManualValidation(taskDir, false);
    assert.equal((await check(taskDir)).status, 'fail');
  }
});

test('the latest review receipt determines whether manual validation is stale', async () => {
  const taskDir = fixture([]);
  fs.writeFileSync(path.join(taskDir, 'review-code-r2.md'), REVIEW_CODE_MV_1);
  markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1, '2026-01-01 00:00:02+00:00');
  addCommittedManualValidation(taskDir, false);
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8').replace(
    '| review-code.completed | review-code.md | code.md | ' + 'a'.repeat(64) + ' | 2026-01-01 00:00:02+00:00 |',
    '| review-code.completed | review-code.md | code.md | ' + 'a'.repeat(64) + ' | 2026-01-01 00:00:00+00:00 |'
  );
  fs.writeFileSync(taskPath, task);
  assert.equal((await check(taskDir)).status, 'fail');
});

test('manual validation fails if the review has no lifecycle receipt', async () => {
  const taskDir = fixture([]);
  markReviewCodeCompleted(taskDir, REVIEW_CODE_MV_1);
  addCommittedManualValidation(taskDir, false);
  const taskPath = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace(/## 产物生命周期收据[\s\S]*$/u, ''));
  assert.equal((await check(taskDir)).status, 'fail');
});
