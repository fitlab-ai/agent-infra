import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { validateManualValidationReceipt } from './manual-validation-receipt.ts';

const MANUAL_VALIDATION_TRANSACTION_SCHEMA = 'agent-infra/manual-validation-transaction';
const MANUAL_VALIDATION_TRANSACTION_VERSION = 1;
const TASK_ID = /^TASK-\d{8}-\d{6}$/u;
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
const ARTIFACT = /^manual-validation(?:-r[2-9]|-r[1-9]\d+)?.md$/u;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type ManualValidationTransactionPhase = 'prepared' | 'summary-staged' | 'receipt-committed' | 'final-promotion-in-progress' | 'committed' | 'aborted' | 'recovery-required';
type ManualValidationSummaryPreimage = Readonly<{ commentId: number | string | null; body: string; digest: string }>;
type ManualValidationTransaction = Readonly<{
  schema: typeof MANUAL_VALIDATION_TRANSACTION_SCHEMA;
  version: typeof MANUAL_VALIDATION_TRANSACTION_VERSION;
  transactionId: string;
  taskId: string;
  prNumber: number;
  prHeadSha: string;
  evidenceDigest: string;
  summaryPreimage: ManualValidationSummaryPreimage;
  pendingSummaryDigest: string;
  finalSummaryDigest: string;
  artifact: string;
  phase: ManualValidationTransactionPhase;
  committedReceipt: string | null;
  eventAppended: boolean;
  attempt: number;
  postWriteVerified: boolean;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}>;
type ManualValidationTransactionInput = Omit<ManualValidationTransaction, 'schema' | 'version' | 'phase' | 'committedReceipt' | 'eventAppended' | 'postWriteVerified' | 'error'> & {
  transactionId?: string;
};
type ManualValidationTransactionPatch = Partial<Pick<ManualValidationTransaction, 'committedReceipt' | 'eventAppended' | 'postWriteVerified' | 'error' | 'updatedAt' | 'attempt'>>;
type ManualValidationTransactionErrorCode =
  | 'MANUAL_VALIDATION_TRANSACTION_INVALID'
  | 'MANUAL_VALIDATION_TRANSACTION_MISSING'
  | 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH'
  | 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID';
type ManualValidationTransactionError = { code: ManualValidationTransactionErrorCode; message: string };
type ManualValidationTransactionResult =
  | { ok: true; value: ManualValidationTransaction }
  | { ok: false; error: ManualValidationTransactionError };
type ManualValidationGenerationArchiveOptions = Readonly<{
  afterReceiptMove?: () => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): ManualValidationTransactionResult {
  return { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_INVALID', message } };
}

function summaryPreimageDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function validateManualValidationTransaction(value: unknown, expected?: Partial<Pick<ManualValidationTransaction, 'transactionId' | 'taskId' | 'prNumber' | 'prHeadSha' | 'evidenceDigest' | 'artifact'>>): ManualValidationTransactionResult {
  if (!isRecord(value)) return invalid('transaction must be a JSON object');
  const keys = ['schema', 'version', 'transactionId', 'taskId', 'prNumber', 'prHeadSha', 'evidenceDigest', 'summaryPreimage', 'pendingSummaryDigest', 'finalSummaryDigest', 'artifact', 'phase', 'committedReceipt', 'eventAppended', 'attempt', 'postWriteVerified', 'createdAt', 'updatedAt', 'error'];
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (unknown || missing) return invalid(unknown ? `transaction contains unknown field '${unknown}'` : `transaction is missing '${missing}'`);
  if (value.schema !== MANUAL_VALIDATION_TRANSACTION_SCHEMA || value.version !== MANUAL_VALIDATION_TRANSACTION_VERSION) return invalid('transaction schema or version is unsupported');
  if (typeof value.transactionId !== 'string' || !TRANSACTION_ID.test(value.transactionId)) return invalid('transactionId is invalid');
  if (typeof value.taskId !== 'string' || !TASK_ID.test(value.taskId)) return invalid('taskId is invalid');
  const prNumber = value.prNumber;
  if (!Number.isSafeInteger(prNumber) || (prNumber as number) <= 0) return invalid('prNumber is invalid');
  if (typeof value.prHeadSha !== 'string' || !SHA40.test(value.prHeadSha)) return invalid('prHeadSha is invalid');
  if (typeof value.evidenceDigest !== 'string' || !SHA64.test(value.evidenceDigest)) return invalid('evidenceDigest is invalid');
  if (!isRecord(value.summaryPreimage)) return invalid('summaryPreimage is invalid');
  const preimage = value.summaryPreimage;
  if (!Object.hasOwn(preimage, 'commentId') || !Object.hasOwn(preimage, 'body') || !Object.hasOwn(preimage, 'digest')) return invalid('summaryPreimage is incomplete');
  if (preimage.commentId !== null && typeof preimage.commentId !== 'number' && typeof preimage.commentId !== 'string') return invalid('summaryPreimage.commentId is invalid');
  if (typeof preimage.body !== 'string' || typeof preimage.digest !== 'string' || !SHA64.test(preimage.digest) || summaryPreimageDigest(preimage.body) !== preimage.digest) return invalid('summaryPreimage digest is invalid');
  for (const field of ['pendingSummaryDigest', 'finalSummaryDigest'] as const) if (typeof value[field] !== 'string' || !SHA64.test(value[field])) return invalid(`${field} is invalid`);
  if (typeof value.artifact !== 'string' || !ARTIFACT.test(value.artifact)) return invalid('artifact is invalid');
  if (!['prepared', 'summary-staged', 'receipt-committed', 'final-promotion-in-progress', 'committed', 'aborted', 'recovery-required'].includes(value.phase as string)) return invalid('phase is invalid');
  if (value.committedReceipt !== null && (typeof value.committedReceipt !== 'string' || !SHA64.test(value.committedReceipt))) return invalid('committedReceipt is invalid');
  if (typeof value.eventAppended !== 'boolean' || typeof value.postWriteVerified !== 'boolean') return invalid('transaction completion flags are invalid');
  const attempt = value.attempt;
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) return invalid('attempt is invalid');
  if (typeof value.createdAt !== 'string' || !TIMESTAMP.test(value.createdAt) || typeof value.updatedAt !== 'string' || !TIMESTAMP.test(value.updatedAt)) return invalid('transaction timestamps are invalid');
  if (value.error !== null && (typeof value.error !== 'string' || !value.error || /[\r\n]/u.test(value.error))) return invalid('transaction error is invalid');
  if (['receipt-committed', 'final-promotion-in-progress', 'committed'].includes(value.phase as string) && value.committedReceipt === null) return invalid('receipt-backed phases require committedReceipt');
  if (['final-promotion-in-progress', 'committed'].includes(value.phase as string) && !value.eventAppended) return invalid('final promotion requires an appended completion event');
  if (value.phase === 'committed' && !value.postWriteVerified) return invalid('committed phase requires post-write verification');
  const transaction = value as unknown as ManualValidationTransaction;
  if (expected && Object.entries(expected).some(([key, expectedValue]) => expectedValue !== undefined && transaction[key as keyof ManualValidationTransaction] !== expectedValue)) {
    return { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH', message: 'transaction identity does not match the expected operation' } };
  }
  return { ok: true, value: transaction };
}

function createManualValidationTransaction(input: ManualValidationTransactionInput): ManualValidationTransaction {
  const transaction: ManualValidationTransaction = {
    schema: MANUAL_VALIDATION_TRANSACTION_SCHEMA,
    version: MANUAL_VALIDATION_TRANSACTION_VERSION,
    transactionId: input.transactionId ?? `mv-${randomUUID()}`,
    taskId: input.taskId,
    prNumber: input.prNumber,
    prHeadSha: input.prHeadSha,
    evidenceDigest: input.evidenceDigest,
    summaryPreimage: input.summaryPreimage,
    pendingSummaryDigest: input.pendingSummaryDigest,
    finalSummaryDigest: input.finalSummaryDigest,
    artifact: input.artifact,
    phase: 'prepared',
    committedReceipt: null,
    eventAppended: false,
    attempt: input.attempt,
    postWriteVerified: false,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    error: null
  };
  const checked = validateManualValidationTransaction(transaction);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

const allowedTransitions: Record<ManualValidationTransactionPhase, readonly ManualValidationTransactionPhase[]> = {
  prepared: ['prepared', 'summary-staged', 'aborted', 'recovery-required'],
  'summary-staged': ['summary-staged', 'receipt-committed', 'aborted', 'recovery-required'],
  'receipt-committed': ['receipt-committed', 'final-promotion-in-progress', 'aborted', 'recovery-required'],
  'final-promotion-in-progress': ['final-promotion-in-progress', 'committed', 'aborted', 'recovery-required'],
  committed: ['committed'],
  aborted: ['aborted', 'prepared'],
  'recovery-required': ['recovery-required', 'prepared']
};

function transitionManualValidationTransaction(
  current: ManualValidationTransaction,
  phase: ManualValidationTransactionPhase,
  patch: ManualValidationTransactionPatch = {}
): ManualValidationTransactionResult {
  if (!allowedTransitions[current.phase].includes(phase)) return { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID', message: `cannot transition from ${current.phase} to ${phase}` } };
  if (phase === 'final-promotion-in-progress' && (!current.eventAppended && patch.eventAppended !== true)) return { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID', message: 'final promotion requires an appended completion event' } };
  const next: ManualValidationTransaction = {
    ...current,
    phase,
    committedReceipt: patch.committedReceipt !== undefined ? patch.committedReceipt : current.committedReceipt,
    eventAppended: patch.eventAppended ?? current.eventAppended,
    postWriteVerified: patch.postWriteVerified ?? current.postWriteVerified,
    attempt: patch.attempt ?? current.attempt,
    error: patch.error !== undefined ? patch.error : current.error,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  const checked = validateManualValidationTransaction(next);
  if (!checked.ok) return checked;
  return checked;
}

function retryManualValidationTransaction(current: ManualValidationTransaction, now = new Date().toISOString()): ManualValidationTransactionResult {
  if (!['aborted', 'recovery-required'].includes(current.phase)) return { ok: false, error: { code: 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID', message: 'only aborted or recovery-required transactions can be retried' } };
  return transitionManualValidationTransaction(current, 'prepared', {
    updatedAt: now,
    error: null,
    committedReceipt: null,
    eventAppended: false,
    postWriteVerified: false,
    attempt: current.attempt + 1
  });
}

function manualValidationTransactionPath(taskDir: string): string {
  return path.join(taskDir, '.manual-validation', 'transaction.json');
}

function manualValidationReceiptHistoryPath(taskDir: string, transaction: ManualValidationTransaction): string {
  return path.join(taskDir, '.manual-validation', 'history', `receipt-${transaction.transactionId}-attempt-${transaction.attempt}.json`);
}

function manualValidationTransactionHistoryPath(taskDir: string, transaction: ManualValidationTransaction): string {
  return path.join(taskDir, '.manual-validation', 'history', `transaction-${transaction.transactionId}-attempt-${transaction.attempt}.json`);
}

function readReceiptAt(file: string, transaction: ManualValidationTransaction): 'missing' | 'valid' {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new Error(`manual-validation receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = validateManualValidationReceipt(value, {
    transactionId: transaction.transactionId,
    taskId: transaction.taskId,
    prNumber: transaction.prNumber,
    prHeadSha: transaction.prHeadSha,
    evidenceDigest: transaction.evidenceDigest,
    artifact: transaction.artifact
  });
  if (!checked.ok) throw new Error(`manual-validation receipt is invalid: ${checked.error.message}`);
  if (transaction.committedReceipt !== null && checked.value.receiptDigest !== transaction.committedReceipt) {
    throw new Error('manual-validation receipt does not match the committed transaction');
  }
  return 'valid';
}

function validateManualValidationGenerationArchive(taskDir: string, transaction: ManualValidationTransaction, requireReceipt = false): void {
  const receiptPath = path.join(taskDir, '.manual-validation', 'receipt.json');
  const receiptHistoryPath = manualValidationReceiptHistoryPath(taskDir, transaction);
  const transactionPath = manualValidationTransactionPath(taskDir);
  const transactionHistoryPath = manualValidationTransactionHistoryPath(taskDir, transaction);
  const currentTransaction = fs.existsSync(transactionPath);
  const archivedTransaction = fs.existsSync(transactionHistoryPath);
  if (currentTransaction && archivedTransaction) throw new Error(`manual-validation archive has conflicting transaction files for ${transaction.transactionId}`);
  if (!currentTransaction && !archivedTransaction) throw new Error(`manual-validation archive source is missing: ${transactionPath}`);
  const currentReceipt = requireReceipt
    ? readReceiptAt(receiptPath, transaction)
    : (fs.existsSync(receiptPath) ? 'valid' : 'missing');
  const archivedReceipt = requireReceipt
    ? readReceiptAt(receiptHistoryPath, transaction)
    : (fs.existsSync(receiptHistoryPath) ? 'valid' : 'missing');
  if (requireReceipt && currentReceipt === 'missing' && archivedReceipt === 'missing') {
    throw new Error(`manual-validation receipt is missing for transaction ${transaction.transactionId}`);
  }
  if (currentReceipt === 'valid' && archivedReceipt === 'valid') {
    throw new Error(`manual-validation archive has conflicting receipt files for ${transaction.transactionId}`);
  }
}

function archiveManualValidationGeneration(
  taskDir: string,
  transaction: ManualValidationTransaction,
  requireReceipt = false,
  options: ManualValidationGenerationArchiveOptions = {}
): void {
  const historyDir = path.join(taskDir, '.manual-validation', 'history');
  validateManualValidationGenerationArchive(taskDir, transaction, requireReceipt);
  fs.mkdirSync(historyDir, { recursive: true });
  const receiptPath = path.join(taskDir, '.manual-validation', 'receipt.json');
  const receiptHistoryPath = manualValidationReceiptHistoryPath(taskDir, transaction);
  const transactionPath = manualValidationTransactionPath(taskDir);
  const transactionHistoryPath = manualValidationTransactionHistoryPath(taskDir, transaction);
  const move = (source: string, target: string, required: boolean): void => {
    if (!fs.existsSync(source)) {
      if (fs.existsSync(target) || !required) return;
      throw new Error(`manual-validation archive source is missing: ${source}`);
    }
    if (fs.existsSync(target)) throw new Error(`manual-validation archive target already exists: ${target}`);
    fs.renameSync(source, target);
  };
  move(receiptPath, receiptHistoryPath, requireReceipt);
  options.afterReceiptMove?.();
  move(transactionPath, transactionHistoryPath, true);
}

function writeManualValidationTransactionAtomic(taskDir: string, transaction: ManualValidationTransaction): string {
  const checked = validateManualValidationTransaction(transaction);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  const target = manualValidationTransactionPath(taskDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort cleanup of our own temp file */ }
    throw error;
  }
  return target;
}

function readManualValidationTransaction(taskDir: string, expected?: Parameters<typeof validateManualValidationTransaction>[1]): ManualValidationTransactionResult {
  const file = manualValidationTransactionPath(taskDir);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; }
  catch (error) {
    return { ok: false, error: { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MANUAL_VALIDATION_TRANSACTION_MISSING' : 'MANUAL_VALIDATION_TRANSACTION_INVALID', message: error instanceof Error ? error.message : String(error) } };
  }
  return validateManualValidationTransaction(value, expected);
}

export {
  MANUAL_VALIDATION_TRANSACTION_SCHEMA,
  MANUAL_VALIDATION_TRANSACTION_VERSION,
  archiveManualValidationGeneration,
  createManualValidationTransaction,
  manualValidationTransactionPath,
  validateManualValidationGenerationArchive,
  readManualValidationTransaction,
  retryManualValidationTransaction,
  summaryPreimageDigest,
  transitionManualValidationTransaction,
  validateManualValidationTransaction,
  writeManualValidationTransactionAtomic
};
export type {
  ManualValidationSummaryPreimage,
  ManualValidationTransaction,
  ManualValidationTransactionError,
  ManualValidationTransactionErrorCode,
  ManualValidationTransactionInput,
  ManualValidationTransactionPatch,
  ManualValidationTransactionPhase,
  ManualValidationTransactionResult
};
