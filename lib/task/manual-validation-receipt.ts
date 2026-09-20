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
const MANUAL_VALIDATION_RECEIPT_PLACEHOLDER = '[[manual-validation-receipt]]';
const MANUAL_VALIDATION_STATUS_HEADING = /^###\s+(?:⚠️\s+(?:需人工校验|Manual Validation Required)|✅\s+(?:人工验证已通过|无需人工校验|Manual Validation Passed|No Manual Validation Required)|⏳\s+(?:人工验证待收尾|Manual Validation Pending))[ \t]*$/mu;
const MANUAL_VALIDATION_STATUS_SECTION = /^###\s+(?:⚠️\s+(?:需人工校验|Manual Validation Required)|✅\s+(?:人工验证已通过|无需人工校验|Manual Validation Passed|No Manual Validation Required)|⏳\s+(?:人工验证待收尾|Manual Validation Pending))[ \t]*$[\s\S]*?(?=^#{1,3}\s|(?![\s\S]))/gmu;
const TRAILING_CANONICAL_REPORT_PLACEHOLDER = /\n*<!--\s*canonical-pr-change-report\s*-->\s*$/u;

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

function renderManualValidationSummarySource(body: string, phase: 'pending' | 'final'): string {
  const normalizedBody = body.replace(/\r\n?/gu, '\n');
  const chinese = /###\s+(?:⚠️\s+需人工校验|✅\s+(?:人工验证已通过|无需人工校验)|⏳\s+人工验证待收尾)\s*$/mu.test(normalizedBody);
  const heading = phase === 'pending'
    ? chinese ? '### ⏳ 人工验证待收尾' : '### ⏳ Manual Validation Pending'
    : chinese ? '### ✅ 人工验证已通过' : '### ✅ Manual Validation Passed';
  const fallback = phase === 'pending'
    ? chinese ? '人工验证正在等待事务提交。' : 'Manual validation is awaiting transaction completion.'
    : chinese ? '人工验证已通过。' : 'Manual validation passed.';
  const receiptMetadata = phase === 'final' ? `\n\n${MANUAL_VALIDATION_RECEIPT_PLACEHOLDER}` : '';
  let inserted = false;
  const updated = normalizedBody.replace(MANUAL_VALIDATION_STATUS_SECTION, (matched) => {
    if (inserted) return '';
    inserted = true;
    const previousHeading = MANUAL_VALIDATION_STATUS_HEADING.exec(matched)?.[0] ?? '';
    const preserved = matched.slice(previousHeading.length);
    const trailingPlaceholder = TRAILING_CANONICAL_REPORT_PLACEHOLDER.exec(preserved)?.[0];
    const content = trailingPlaceholder
      ? preserved.slice(0, -trailingPlaceholder.length).replace(/\s+$/u, '')
      : preserved.replace(/\s+$/u, '');
    const section = `${heading}${content || `\n\n${fallback}`}${receiptMetadata}`;
    return trailingPlaceholder ? `${trailingPlaceholder.trim()}\n\n${section}\n\n` : `${section}\n\n`;
  });
  return inserted ? `${updated.replace(/\s+$/u, '')}\n` : `${normalizedBody.replace(/\s+$/u, '')}\n\n${heading}\n\n${fallback}${receiptMetadata}\n`;
}

function renderLegacyManualValidationHiddenSummary(body: string, receipt: ManualValidationReceipt): string {
  const marker = `<!-- manual-validation-receipt: transaction=${receipt.transactionId}; receipt=${receipt.receiptDigest}; evidence=${receipt.evidenceDigest}; head=${receipt.prHeadSha} -->`;
  return renderManualValidationSummarySource(body, 'final').replace(MANUAL_VALIDATION_RECEIPT_PLACEHOLDER, marker);
}

function manualValidationFinalSummaryDigest(body: string): string {
  const heading = /^###\s+✅\s+(?:Manual Validation Passed|人工验证已通过)\s*$/mu.exec(body);
  const afterHeading = heading ? body.slice(heading.index + heading[0].length) : '';
  const nextSection = heading ? /^#{1,3}\s/mu.exec(afterHeading) : null;
  const projection = heading
    ? body.slice(heading.index, heading.index + heading[0].length + (nextSection?.index ?? afterHeading.length)).replace(/\s+$/u, '')
    : body;
  const preimage = projection
    .replace(/<!--\s*manual-validation-receipt:\s*[\s\S]*?-->/gu, MANUAL_VALIDATION_RECEIPT_PLACEHOLDER)
    .replace(/receipt=(?:[a-f0-9]{64}|<receipt>)/gu, 'receipt=<receipt>');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

function manualValidationFinalSummaryProjectionMatches(body: string, receipt: ManualValidationReceipt): boolean {
  const identity = `transaction=${receipt.transactionId}; receipt=${receipt.receiptDigest}; evidence=${receipt.evidenceDigest}; head=${receipt.prHeadSha}`;
  return (body.includes(identity) || body.includes(MANUAL_VALIDATION_RECEIPT_PLACEHOLDER))
    && manualValidationFinalSummaryDigest(body) === receipt.finalSummaryDigest;
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
  MANUAL_VALIDATION_RECEIPT_PLACEHOLDER,
  createManualValidationReceipt,
  manualValidationFinalSummaryDigest,
  manualValidationFinalSummaryProjectionMatches,
  renderManualValidationSummarySource,
  manualValidationReceiptDigest,
  renderLegacyManualValidationHiddenSummary,
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
