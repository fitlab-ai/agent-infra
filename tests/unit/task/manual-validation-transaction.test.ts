import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createManualValidationTransaction,
  summaryPreimageDigest,
  transitionManualValidationTransaction,
  validateManualValidationTransaction
} from '../../../lib/task/manual-validation-transaction.ts';

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
