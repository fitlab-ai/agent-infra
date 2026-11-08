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
  const placeholder = `### ✅ Manual Validation Passed\n\n<!-- manual-validation-receipt: transaction=${input.transactionId}; receipt=<receipt>; evidence=${input.evidenceDigest}; head=${input.prHeadSha} -->\n\nManual validation passed.\n`;
  const receipt = createManualValidationReceipt({
    ...input,
    finalSummaryDigest: manualValidationFinalSummaryDigest(placeholder)
  });
  const body = `<!-- sync-pr:TASK-20260910-000001:summary -->\n\n### PR 代码增减\n\nreport\n\n${placeholder.replace('<receipt>', receipt.receiptDigest)}`;
  assert.equal(manualValidationFinalSummaryProjectionMatches(body, receipt), true);
  assert.equal(manualValidationFinalSummaryProjectionMatches(body.replace(input.prHeadSha, 'f'.repeat(40)), receipt), false);
});

test('receipt validation preserves field ordering and exact first errors', () => {
  const receipt = createManualValidationReceipt(input);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ schema: 'other', version: 2, transactionId: null }, 'receipt schema or version is unsupported'],
    [{ version: 2, transactionId: null }, 'receipt schema or version is unsupported'],
    [{ transactionId: null, taskId: null }, 'transactionId is invalid'],
    [{ transactionId: '', taskId: null }, 'transactionId is invalid'],
    [{ taskId: 1, prNumber: 0 }, 'taskId is invalid'],
    [{ taskId: 'bad', prNumber: 0 }, 'taskId is invalid'],
    [{ prNumber: 0, prHeadSha: null }, 'prNumber is invalid'],
    [{ prNumber: 1.5 }, 'prNumber is invalid'],
    [{ prNumber: Number.MAX_SAFE_INTEGER + 1 }, 'prNumber is invalid'],
    [{ prHeadSha: null, evidenceDigest: null }, 'prHeadSha is invalid'],
    [{ evidenceDigest: '', artifactSha256: null }, 'evidenceDigest is invalid'],
    [{ artifactSha256: '', pendingSummaryDigest: null }, 'artifactSha256 is invalid'],
    [{ pendingSummaryDigest: '', finalSummaryDigest: null }, 'pendingSummaryDigest is invalid'],
    [{ finalSummaryDigest: '', receiptDigest: null }, 'finalSummaryDigest is invalid'],
    [{ receiptDigest: '', artifact: null }, 'receiptDigest is invalid'],
    [{ artifact: 'other.md', committedAt: '' }, 'artifact is not a canonical manual-validation artifact'],
    [{ committedAt: '' }, 'committedAt is invalid'],
    [{ finalSummaryDigest: 'f'.repeat(64) }, 'receiptDigest does not match receipt contents']
  ];
  for (const [changes, message] of cases) {
    assert.deepEqual(validateManualValidationReceipt({ ...receipt, ...changes }, { taskId: 'other' }), {
      ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_INVALID', message }
    });
  }
  for (const value of [null, [], 42]) {
    assert.deepEqual(validateManualValidationReceipt(value), {
      ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_INVALID', message: 'receipt must be a JSON object' }
    });
  }
  const { schema: _schema, ...missing } = receipt;
  assert.deepEqual(validateManualValidationReceipt({ ...missing, extra: true }), {
    ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_INVALID', message: "receipt contains unknown field 'extra'" }
  });
  assert.deepEqual(validateManualValidationReceipt(missing), {
    ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_INVALID', message: "receipt is missing 'schema'" }
  });
});

test('receipt validation keeps successful reference and undefined expected identity semantics', () => {
  const receipt = createManualValidationReceipt(input);
  for (const expected of [undefined, {}, { transactionId: undefined }, {
    transactionId: input.transactionId, taskId: input.taskId, prNumber: input.prNumber,
    prHeadSha: input.prHeadSha, evidenceDigest: input.evidenceDigest, artifact: input.artifact
  }]) {
    const result = validateManualValidationReceipt(receipt, expected);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, receipt);
  }
  assert.deepEqual(validateManualValidationReceipt(receipt, { prNumber: 43 }), {
    ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_IDENTITY_MISMATCH', message: 'receipt identity does not match the expected transaction' }
  });
});

test('receipt field validation retains repeated getter reads and early exits', () => {
  const cases: Array<[Record<string, unknown>, string[]]> = [
    [{ schema: 'bad' }, ['schema']],
    [{ version: 2 }, ['schema', 'version']],
    [{ transactionId: null }, ['schema', 'version', 'transactionId']],
    [{ transactionId: '!' }, ['schema', 'version', 'transactionId', 'transactionId']],
    [{ taskId: null }, ['schema', 'version', 'transactionId', 'transactionId', 'taskId']],
    [{ prNumber: 0 }, ['schema', 'version', 'transactionId', 'transactionId', 'taskId', 'taskId', 'prNumber']]
  ];
  for (const [changes, expectedReads] of cases) {
    const reads: string[] = [];
    const receipt = new Proxy({ ...createManualValidationReceipt(input), ...changes }, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      }
    });
    assert.equal(validateManualValidationReceipt(receipt).ok, false);
    assert.deepEqual(reads, expectedReads);
  }
  const receipt = createManualValidationReceipt(input);
  const failure = new Error('getter failed');
  Object.defineProperty(receipt, 'transactionId', { get() { throw failure; } });
  assert.throws(() => validateManualValidationReceipt(receipt), (error) => error === failure);
});

test('receipt expected comparisons skip undefined and short circuit after the first mismatch', () => {
  const reads: string[] = [];
  const receipt = new Proxy(createManualValidationReceipt(input), {
    get(target, key, receiver) {
      reads.push(String(key));
      return Reflect.get(target, key, receiver);
    }
  });
  validateManualValidationReceipt(receipt);
  const validationReads = [...reads];
  reads.length = 0;
  const expected = { transactionId: undefined, prNumber: 43, taskId: 'other' };
  assert.equal(validateManualValidationReceipt(receipt, expected).ok, false);
  assert.deepEqual(reads, [...validationReads, 'prNumber']);
});
