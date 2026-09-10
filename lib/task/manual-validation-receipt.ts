import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MANUAL_VALIDATION_ARTIFACT as ARTIFACT,
  MANUAL_VALIDATION_SHA40 as SHA40,
  MANUAL_VALIDATION_SHA64 as SHA64,
  MANUAL_VALIDATION_TASK_ID as TASK_ID,
  exactKeys,
  isRecord,
  validTimestamp,
  writeJsonAtomic
} from './manual-validation-shared.ts';

const MANUAL_VALIDATION_RECEIPT_SCHEMA = 'agent-infra/manual-validation-receipt';
const MANUAL_VALIDATION_RECEIPT_VERSION = 1;

type ManualValidationReceipt = Readonly<{
  schema: typeof MANUAL_VALIDATION_RECEIPT_SCHEMA;
  version: typeof MANUAL_VALIDATION_RECEIPT_VERSION;
  transactionId: string;
  taskId: string;
  prNumber: number;
  prHeadSha: string;
  evidenceDigest: string;
  artifact: string;
  artifactSha256: string;
  pendingSummaryDigest: string;
  finalSummaryDigest: string;
  committedAt: string;
  receiptDigest: string;
}>;
type ManualValidationReceiptInput = Omit<ManualValidationReceipt, 'schema' | 'version' | 'receiptDigest'>;
type ManualValidationReceiptErrorCode =
  | 'MANUAL_VALIDATION_RECEIPT_MISSING'
  | 'MANUAL_VALIDATION_RECEIPT_INVALID'
  | 'MANUAL_VALIDATION_RECEIPT_IDENTITY_MISMATCH';
type ManualValidationReceiptError = { code: ManualValidationReceiptErrorCode; message: string };
type ManualValidationReceiptResult =
  | { ok: true; value: ManualValidationReceipt }
  | { ok: false; error: ManualValidationReceiptError };
type ManualValidationReceiptIdentity = Partial<Pick<ManualValidationReceipt, 'transactionId' | 'taskId' | 'prNumber' | 'prHeadSha' | 'evidenceDigest' | 'artifact'>>;

function invalid(message: string): ManualValidationReceiptResult {
  return { ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_INVALID', message } };
}

function canonicalPayload(receipt: ManualValidationReceipt | ManualValidationReceiptInput): Omit<ManualValidationReceipt, 'receiptDigest'> {
  return {
    schema: MANUAL_VALIDATION_RECEIPT_SCHEMA,
    version: MANUAL_VALIDATION_RECEIPT_VERSION,
    transactionId: receipt.transactionId,
    taskId: receipt.taskId,
    prNumber: receipt.prNumber,
    prHeadSha: receipt.prHeadSha,
    evidenceDigest: receipt.evidenceDigest,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    pendingSummaryDigest: receipt.pendingSummaryDigest,
    finalSummaryDigest: receipt.finalSummaryDigest,
    committedAt: receipt.committedAt
  };
}

function manualValidationReceiptDigest(receipt: ManualValidationReceipt | ManualValidationReceiptInput): string {
  return createHash('sha256').update(JSON.stringify(canonicalPayload(receipt)), 'utf8').digest('hex');
}

function manualValidationFinalSummaryDigest(body: string): string {
  const heading = /^###\s+✅\s+(?:Manual Validation Passed|人工验证已通过)\s*$/mu.exec(body);
  const projection = heading ? body.slice(heading.index).replace(/\s+$/u, '') : body;
  const preimage = projection.replace(/receipt=(?:[a-f0-9]{64}|<receipt>)/gu, 'receipt=<receipt>');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

function manualValidationFinalSummaryProjectionMatches(body: string, receipt: ManualValidationReceipt): boolean {
  const identity = `transaction=${receipt.transactionId}; receipt=${receipt.receiptDigest}; evidence=${receipt.evidenceDigest}; head=${receipt.prHeadSha}`;
  return body.includes(identity) && manualValidationFinalSummaryDigest(body) === receipt.finalSummaryDigest;
}

function validateManualValidationReceipt(value: unknown, expected?: ManualValidationReceiptIdentity): ManualValidationReceiptResult {
  if (!isRecord(value)) return invalid('receipt must be a JSON object');
  const keys = ['schema', 'version', 'transactionId', 'taskId', 'prNumber', 'prHeadSha', 'evidenceDigest', 'artifact', 'artifactSha256', 'pendingSummaryDigest', 'finalSummaryDigest', 'committedAt', 'receiptDigest'];
  const keyError = exactKeys(value, keys, 'receipt');
  if (keyError) return invalid(keyError);
  if (value.schema !== MANUAL_VALIDATION_RECEIPT_SCHEMA || value.version !== MANUAL_VALIDATION_RECEIPT_VERSION) return invalid('receipt schema or version is unsupported');
  if (typeof value.transactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.transactionId)) return invalid('transactionId is invalid');
  if (typeof value.taskId !== 'string' || !TASK_ID.test(value.taskId)) return invalid('taskId is invalid');
  const prNumber = value.prNumber;
  if (!Number.isSafeInteger(prNumber) || (prNumber as number) <= 0) return invalid('prNumber is invalid');
  for (const [name, pattern] of [['prHeadSha', SHA40], ['evidenceDigest', SHA64], ['artifactSha256', SHA64], ['pendingSummaryDigest', SHA64], ['finalSummaryDigest', SHA64], ['receiptDigest', SHA64]] as const) {
    if (typeof value[name] !== 'string' || !pattern.test(value[name])) return invalid(`${name} is invalid`);
  }
  if (typeof value.artifact !== 'string' || !ARTIFACT.test(value.artifact)) return invalid('artifact is not a canonical manual-validation artifact');
  if (!validTimestamp(value.committedAt)) return invalid('committedAt is invalid');
  const receipt = value as unknown as ManualValidationReceipt;
  if (manualValidationReceiptDigest(receipt) !== receipt.receiptDigest) return invalid('receiptDigest does not match receipt contents');
  if (expected && Object.entries(expected).some(([key, expectedValue]) => expectedValue !== undefined && receipt[key as keyof ManualValidationReceipt] !== expectedValue)) {
    return { ok: false, error: { code: 'MANUAL_VALIDATION_RECEIPT_IDENTITY_MISMATCH', message: 'receipt identity does not match the expected transaction' } };
  }
  return { ok: true, value: receipt };
}

function createManualValidationReceipt(input: ManualValidationReceiptInput): ManualValidationReceipt {
  const payload = canonicalPayload(input);
  const receipt = { ...payload, receiptDigest: manualValidationReceiptDigest(input) };
  const checked = validateManualValidationReceipt(receipt);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

function manualValidationReceiptPath(taskDir: string): string {
  return path.join(taskDir, '.manual-validation', 'receipt.json');
}

function writeManualValidationReceiptAtomic(taskDir: string, receipt: ManualValidationReceipt): string {
  const checked = validateManualValidationReceipt(receipt);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  const target = manualValidationReceiptPath(taskDir);
  return writeJsonAtomic(target, receipt);
}

function readManualValidationReceipt(taskDir: string, expected?: ManualValidationReceiptIdentity): ManualValidationReceiptResult {
  const file = manualValidationReceiptPath(taskDir);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; }
  catch (error) {
    return { ok: false, error: { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MANUAL_VALIDATION_RECEIPT_MISSING' : 'MANUAL_VALIDATION_RECEIPT_INVALID', message: error instanceof Error ? error.message : String(error) } };
  }
  return validateManualValidationReceipt(value, expected);
}

export {
  MANUAL_VALIDATION_RECEIPT_SCHEMA,
  MANUAL_VALIDATION_RECEIPT_VERSION,
  createManualValidationReceipt,
  manualValidationFinalSummaryDigest,
  manualValidationFinalSummaryProjectionMatches,
  manualValidationReceiptDigest,
  manualValidationReceiptPath,
  readManualValidationReceipt,
  validateManualValidationReceipt,
  writeManualValidationReceiptAtomic
};
export type {
  ManualValidationReceipt,
  ManualValidationReceiptError,
  ManualValidationReceiptErrorCode,
  ManualValidationReceiptIdentity,
  ManualValidationReceiptInput,
  ManualValidationReceiptResult
};
