import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createManualValidationReceipt,
  manualValidationFinalSummaryDigest,
  manualValidationFinalSummaryProjectionMatches,
  manualValidationReceiptDigest,
  validateManualValidationReceipt
} from '../../../lib/task/manual-validation-receipt.ts';

const input = {
  transactionId: 'mv-transaction-1',
  taskId: 'TASK-20260910-000001',
  prNumber: 42,
  prHeadSha: 'a'.repeat(40),
  evidenceDigest: 'b'.repeat(64),
  artifact: 'manual-validation.md',
  artifactSha256: 'c'.repeat(64),
  pendingSummaryDigest: 'd'.repeat(64),
  finalSummaryDigest: 'e'.repeat(64),
  committedAt: '2026-09-10T00:00:00.000Z'
};

test('manual-validation receipt has a canonical digest and validates its identity', () => {
  const receipt = createManualValidationReceipt(input);
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(manualValidationReceiptDigest(receipt), receipt.receiptDigest);
  assert.deepEqual(validateManualValidationReceipt(receipt), { ok: true, value: receipt });
  const mismatch = validateManualValidationReceipt(receipt, { transactionId: 'mv-other' });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'MANUAL_VALIDATION_RECEIPT_IDENTITY_MISMATCH');
});

test('manual-validation receipt rejects tampered digest', () => {
  const receipt = createManualValidationReceipt(input);
  const tampered = { ...receipt, finalSummaryDigest: 'f'.repeat(64) };
  const result = validateManualValidationReceipt(tampered);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'MANUAL_VALIDATION_RECEIPT_INVALID');
});

test('manual-validation final summary digest binds the canonical identity projection', () => {
  const placeholder = `### ✅ Manual Validation Passed\n\nManual validation passed; transaction=${input.transactionId}; receipt=<receipt>; evidence=${input.evidenceDigest}; head=${input.prHeadSha}.\n`;
  const receipt = createManualValidationReceipt({
    ...input,
    finalSummaryDigest: manualValidationFinalSummaryDigest(placeholder)
  });
  const body = `<!-- sync-pr:TASK-20260910-000001:summary -->\n\n### PR 代码增减\n\nreport\n\n${placeholder.replace('<receipt>', receipt.receiptDigest)}`;
  assert.equal(manualValidationFinalSummaryProjectionMatches(body, receipt), true);
  assert.equal(manualValidationFinalSummaryProjectionMatches(body.replace(input.prHeadSha, 'f'.repeat(40)), receipt), false);
});
