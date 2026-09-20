import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveManualValidationGeneration,
  createManualValidationTransaction,
  manualValidationTransactionPath,
  retryManualValidationTransaction,
  summaryPreimageDigest,
  transitionManualValidationTransaction,
  validateManualValidationTransaction,
  writeManualValidationTransactionAtomic
} from '../../../lib/task/manual-validation-transaction.ts';
import { createManualValidationReceipt, writeManualValidationReceiptAtomic } from '../../../lib/task/manual-validation-receipt.ts';

const input = {
  transactionId: 'mv-transaction-1',
  taskId: 'TASK-20260910-000001',
  prNumber: 42,
  prHeadSha: 'a'.repeat(40),
  evidenceDigest: 'b'.repeat(64),
  summaryPreimage: { commentId: 9, body: 'pending', digest: summaryPreimageDigest('pending') },
  pendingSummaryDigest: 'd'.repeat(64),
  finalSummaryDigest: 'e'.repeat(64),
  artifact: 'manual-validation.md',
  attempt: 1,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z'
};

test('manual-validation transaction enforces pending-first phase order', () => {
  const prepared = createManualValidationTransaction(input);
  const staged = transitionManualValidationTransaction(prepared, 'summary-staged');
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  const receipt = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: 'f'.repeat(64) });
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  const blocked = transitionManualValidationTransaction(receipt.value, 'final-promotion-in-progress');
  assert.equal(blocked.ok, false);
  const finalReady = transitionManualValidationTransaction(receipt.value, 'final-promotion-in-progress', { eventAppended: true });
  assert.equal(finalReady.ok, true);
  assert.deepEqual(validateManualValidationTransaction(prepared).ok, true);
});

test('manual-validation transaction accepts only verified committed final state', () => {
  const prepared = createManualValidationTransaction(input);
  const committed = transitionManualValidationTransaction(prepared, 'committed', { eventAppended: true, committedReceipt: 'f'.repeat(64), postWriteVerified: true });
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.equal(committed.error.code, 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID');
});

test('manual-validation retry starts a clean next attempt', () => {
  const prepared = createManualValidationTransaction(input);
  const staged = transitionManualValidationTransaction(prepared, 'summary-staged');
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  const receipt = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: 'f'.repeat(64) });
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  const promoted = transitionManualValidationTransaction(receipt.value, 'final-promotion-in-progress', { eventAppended: true });
  assert.equal(promoted.ok, true);
  if (!promoted.ok) return;
  const failed = transitionManualValidationTransaction(promoted.value, 'recovery-required', { error: 'remote write failed' });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  const retried = retryManualValidationTransaction(failed.value, '2026-09-10T00:00:02.000Z');
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.equal(retried.value.phase, 'prepared');
  assert.equal(retried.value.transactionId, failed.value.transactionId);
  assert.equal(retried.value.attempt, 2);
  assert.equal(retried.value.committedReceipt, null);
  assert.equal(retried.value.eventAppended, false);
  assert.equal(retried.value.postWriteVerified, false);
  assert.equal(retried.value.error, null);
});

test('manual-validation generation archive is retryable after an interrupted receipt move', () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-validation-generation-'));
  const stateDir = path.join(taskDir, '.manual-validation');
  const historyDir = path.join(stateDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const prepared = createManualValidationTransaction(input);
  const staged = transitionManualValidationTransaction(prepared, 'summary-staged');
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  const receipt = createManualValidationReceipt({
    transactionId: prepared.transactionId,
    taskId: prepared.taskId,
    prNumber: prepared.prNumber,
    prHeadSha: prepared.prHeadSha,
    evidenceDigest: prepared.evidenceDigest,
    artifact: prepared.artifact,
    artifactSha256: 'c'.repeat(64),
    pendingSummaryDigest: prepared.pendingSummaryDigest,
    finalSummaryDigest: prepared.finalSummaryDigest,
    committedAt: '2026-09-10T00:00:00.000Z'
  });
  const committed = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  writeManualValidationReceiptAtomic(taskDir, receipt);
  writeManualValidationTransactionAtomic(taskDir, committed.value);
  const transaction = committed.value;
  const receiptPath = path.join(stateDir, 'receipt.json');
  assert.equal(fs.existsSync(receiptPath), true);
  fs.renameSync(receiptPath, path.join(historyDir, `receipt-${transaction.transactionId}-attempt-${transaction.attempt}.json`));

  archiveManualValidationGeneration(taskDir, transaction, true);

  assert.equal(fs.existsSync(manualValidationTransactionPath(taskDir)), false);
  assert.equal(fs.existsSync(path.join(historyDir, `transaction-${transaction.transactionId}-attempt-${transaction.attempt}.json`)), true);
});

test('manual-validation generation archive rejects an invalid history receipt', () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-validation-generation-invalid-'));
  const stateDir = path.join(taskDir, '.manual-validation');
  const historyDir = path.join(stateDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const prepared = createManualValidationTransaction(input);
  const staged = transitionManualValidationTransaction(prepared, 'summary-staged');
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  const receipt = createManualValidationReceipt({
    transactionId: prepared.transactionId,
    taskId: prepared.taskId,
    prNumber: prepared.prNumber,
    prHeadSha: prepared.prHeadSha,
    evidenceDigest: prepared.evidenceDigest,
    artifact: prepared.artifact,
    artifactSha256: 'c'.repeat(64),
    pendingSummaryDigest: prepared.pendingSummaryDigest,
    finalSummaryDigest: prepared.finalSummaryDigest,
    committedAt: '2026-09-10T00:00:00.000Z'
  });
  const committed = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  writeManualValidationTransactionAtomic(taskDir, committed.value);
  fs.writeFileSync(path.join(historyDir, `receipt-${prepared.transactionId}-attempt-${prepared.attempt}.json`), JSON.stringify({ ...receipt, prHeadSha: 'f'.repeat(40) }));
  assert.throws(() => archiveManualValidationGeneration(taskDir, committed.value, true), /receipt is invalid|does not match/);
  assert.equal(fs.existsSync(manualValidationTransactionPath(taskDir)), true);
});
