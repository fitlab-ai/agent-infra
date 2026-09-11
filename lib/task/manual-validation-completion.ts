import { readManualValidationReceipt } from './manual-validation-receipt.ts';
import type { ManualValidationReceipt, ManualValidationReceiptError, ManualValidationReceiptIdentity } from './manual-validation-receipt.ts';
import { readManualValidationTransaction } from './manual-validation-transaction.ts';
import type { ManualValidationTransaction, ManualValidationTransactionError } from './manual-validation-transaction.ts';

type ManualValidationCompletionIdentity = ManualValidationReceiptIdentity & Readonly<{
  receiptDigest?: string;
}>;
type ManualValidationCompletion = Readonly<{
  receipt: ManualValidationReceipt;
  transaction: ManualValidationTransaction;
}>;
type ManualValidationCompletionError = ManualValidationReceiptError | ManualValidationTransactionError;
type ManualValidationCompletionResult =
  | { ok: true; value: ManualValidationCompletion }
  | { ok: false; error: ManualValidationCompletionError };

function readManualValidationCompletion(taskDir: string, expected: ManualValidationCompletionIdentity = {}): ManualValidationCompletionResult {
  const { receiptDigest: expectedReceiptDigest, ...receiptIdentity } = expected;
  const receipt = readManualValidationReceipt(taskDir, receiptIdentity);
  if (!receipt.ok) return receipt;
  if (expectedReceiptDigest !== undefined && receipt.value.receiptDigest !== expectedReceiptDigest) {
    return { ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_IDENTITY_MISMATCH', message: 'receipt digest does not match the expected completion' } };
  }
  const transaction = readManualValidationTransaction(taskDir, {
    transactionId: receipt.value.transactionId,
    taskId: receipt.value.taskId,
    prNumber: receipt.value.prNumber,
    prHeadSha: receipt.value.prHeadSha,
    evidenceDigest: receipt.value.evidenceDigest,
    artifact: receipt.value.artifact
  });
  if (!transaction.ok) return transaction;
  if (transaction.value.committedReceipt !== receipt.value.receiptDigest) {
    return { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID', message: 'completion transaction is not bound to the canonical receipt' } };
  }
  return { ok: true, value: { receipt: receipt.value, transaction: transaction.value } };
}

export { readManualValidationCompletion };
export type { ManualValidationCompletion, ManualValidationCompletionError, ManualValidationCompletionIdentity, ManualValidationCompletionResult };
