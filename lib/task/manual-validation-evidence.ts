import {
  MANUAL_VALIDATION_SHA40 as SHA40,
  MANUAL_VALIDATION_TASK_ID as TASK_ID,
  exactKeys,
  isRecord,
  validTimestamp
} from './manual-validation-shared.ts';

const MANUAL_VALIDATION_EVIDENCE_SCHEMA = 'agent-infra/branch-only-validation-evidence';
const MANUAL_VALIDATION_EVIDENCE_VERSION = 1;

type ManualValidationMode = 'task-bound' | 'branch-only';
type ManualValidationScope = 'snapshot' | 'inplace';
type ManualValidationCleanup = 'completed' | 'pending' | 'failed' | 'not-created';
type ManualValidationEvidence = Readonly<{
  schema: typeof MANUAL_VALIDATION_EVIDENCE_SCHEMA;
  version: typeof MANUAL_VALIDATION_EVIDENCE_VERSION;
  mode: ManualValidationMode;
  taskId: string | null;
  branch: string;
  commit: string;
  recoverable: boolean;
  source: 'run-manual-validation';
  result: Readonly<{
    scope: ManualValidationScope;
    command: string;
    startedAt: string;
    completedAt: string;
    exitCode: number;
    signal: string | null;
    cleanup: ManualValidationCleanup;
  }>;
}>;
type ManualValidationEvidenceInput = {
  mode: ManualValidationMode;
  taskId: string | null;
  branch: string;
  commit: string;
  recoverable: boolean;
  scope: ManualValidationScope;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  signal: string | null;
  cleanup: ManualValidationCleanup;
};
type ManualValidationEvidenceErrorCode =
  | 'MANUAL_VALIDATION_EVIDENCE_MISSING'
  | 'MANUAL_VALIDATION_EVIDENCE_INVALID'
  | 'MANUAL_VALIDATION_EVIDENCE_IDENTITY_MISMATCH'
  | 'MANUAL_VALIDATION_EVIDENCE_UNSUCCESSFUL'
  | 'MANUAL_VALIDATION_EVIDENCE_STALE';
type ManualValidationEvidenceError = { code: ManualValidationEvidenceErrorCode; message: string };
type ManualValidationEvidenceResult =
  | { ok: true; value: ManualValidationEvidence }
  | { ok: false; error: ManualValidationEvidenceError };

function invalid(message: string): ManualValidationEvidenceResult {
  return { ok: false, error: { code: 'MANUAL_VALIDATION_EVIDENCE_INVALID', message } };
}

function validateShape(value: unknown): ManualValidationEvidenceResult {
  if (!isRecord(value)) return invalid('evidence must be a JSON object');
  const topError = exactKeys(value, ['schema', 'version', 'mode', 'taskId', 'branch', 'commit', 'recoverable', 'source', 'result'], 'evidence');
  if (topError) return invalid(topError);
  if (value.schema !== MANUAL_VALIDATION_EVIDENCE_SCHEMA || value.version !== MANUAL_VALIDATION_EVIDENCE_VERSION) {
    return invalid('evidence schema or version is unsupported');
  }
  if (value.mode !== 'task-bound' && value.mode !== 'branch-only') return invalid('mode must be task-bound or branch-only');
  if (value.taskId !== null && (typeof value.taskId !== 'string' || !TASK_ID.test(value.taskId))) return invalid('taskId must be a TASK identifier or null');
  if (typeof value.branch !== 'string' || !value.branch.trim() || /[\r\n]/u.test(value.branch)) return invalid('branch must be a non-empty single line');
  if (typeof value.commit !== 'string' || !SHA40.test(value.commit)) return invalid('commit must be a 40-character lowercase hexadecimal SHA');
  if (typeof value.recoverable !== 'boolean') return invalid('recoverable must be boolean');
  if (value.source !== 'run-manual-validation') return invalid('source is unsupported');
  if (value.mode === 'branch-only' && (value.taskId !== null || value.recoverable !== false)) return invalid('branch-only evidence must be non-recoverable and task-free');
  if (value.mode === 'task-bound' && (value.taskId === null || value.recoverable !== true)) return invalid('task-bound evidence must identify a recoverable task');
  if (!isRecord(value.result)) return invalid('result must be a JSON object');
  const result = value.result;
  const resultError = exactKeys(result, ['scope', 'command', 'startedAt', 'completedAt', 'exitCode', 'signal', 'cleanup'], 'result');
  if (resultError) return invalid(resultError);
  if (result.scope !== 'snapshot' && result.scope !== 'inplace') return invalid('result.scope is invalid');
  if (typeof result.command !== 'string' || !result.command || /[\\/\r\n]/u.test(result.command)) return invalid('result.command must be a basename');
  if (!validTimestamp(result.startedAt) || !validTimestamp(result.completedAt) || Date.parse(result.completedAt) < Date.parse(result.startedAt)) return invalid('result timestamps are invalid');
  const exitCode = result.exitCode;
  if (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0) return invalid('result.exitCode must be a non-negative integer');
  if (result.signal !== null && (typeof result.signal !== 'string' || !result.signal || /[\r\n]/u.test(result.signal))) return invalid('result.signal must be a string or null');
  if (!['completed', 'pending', 'failed', 'not-created'].includes(result.cleanup as string)) return invalid('result.cleanup is invalid');
  return { ok: true, value: value as unknown as ManualValidationEvidence };
}

function createManualValidationEvidence(input: ManualValidationEvidenceInput): ManualValidationEvidence {
  const value: ManualValidationEvidence = {
    schema: MANUAL_VALIDATION_EVIDENCE_SCHEMA,
    version: MANUAL_VALIDATION_EVIDENCE_VERSION,
    mode: input.mode,
    taskId: input.taskId,
    branch: input.branch,
    commit: input.commit,
    recoverable: input.recoverable,
    source: 'run-manual-validation',
    result: {
      scope: input.scope,
      command: input.command,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      exitCode: input.exitCode,
      signal: input.signal,
      cleanup: input.cleanup
    }
  };
  const checked = validateShape(value);
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

type ManualValidationEvidenceSummary = Readonly<{
  version: 1;
  taskId: string | null;
  branch: string;
  scope: ManualValidationScope;
  commit: string;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  signal: string | null;
  cleanup: ManualValidationCleanup;
}>;

function manualValidationEvidenceSummary(evidence: ManualValidationEvidence): ManualValidationEvidenceSummary {
  return {
    version: 1,
    taskId: evidence.taskId,
    branch: evidence.branch,
    scope: evidence.result.scope,
    commit: evidence.commit,
    command: evidence.result.command,
    startedAt: evidence.result.startedAt,
    completedAt: evidence.result.completedAt,
    exitCode: evidence.result.exitCode,
    signal: evidence.result.signal,
    cleanup: evidence.result.cleanup
  };
}

export {
  MANUAL_VALIDATION_EVIDENCE_SCHEMA,
  MANUAL_VALIDATION_EVIDENCE_VERSION,
  createManualValidationEvidence,
  manualValidationEvidenceSummary
};
export type {
  ManualValidationCleanup,
  ManualValidationEvidence,
  ManualValidationEvidenceError,
  ManualValidationEvidenceErrorCode,
  ManualValidationEvidenceInput,
  ManualValidationEvidenceResult,
  ManualValidationEvidenceSummary,
  ManualValidationMode,
  ManualValidationScope
};
