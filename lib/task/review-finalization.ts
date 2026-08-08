import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { locateActivityLog, pairEntries } from './activity-log.ts';
import { parseArtifactName, validateCompletedArtifact } from './artifact-lifecycle.ts';
import { parseLedger, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import type { LedgerStageStatus, ReviewStage } from './ledger.ts';
import { finalizeReviewSummaryContent } from './review-artifacts.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { validateLifecycleExecution } from './lifecycle-execution.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import type { ResolveTaskRefErrorCode } from './resolve-ref.ts';

type ReviewFinalizationErrorCode =
  | ResolveTaskRefErrorCode
  | 'TASK_STATE_MISMATCH'
  | 'REVIEW_PAYLOAD_INVALID'
  | 'REVIEW_STAGE_INVALID'
  | 'REVIEW_ARTIFACT_IDENTITY_INVALID'
  | 'REVIEW_ARTIFACT_NOT_REGULAR'
  | 'REVIEW_LEDGER_INVALID'
  | 'REVIEW_SUMMARY_NOT_FOUND'
  | 'REVIEW_SUMMARY_PLACEHOLDER_INVALID'
  | 'REVIEW_SUMMARY_COUNT_MISMATCH'
  | 'REVIEW_ARTIFACT_CONFLICT'
  | 'REVIEW_PROVENANCE_INVALID'
  | 'REVIEW_TEMP_WRITE_FAILED'
  | 'REVIEW_RENAME_FAILED';
type ReviewFinalizationError = { code: ReviewFinalizationErrorCode; message: string };
type ReviewFinalizationRequest = {
  taskRef: string;
  stage: string;
  artifact: string;
  orchestrated?: boolean;
  dryRun?: boolean;
};
type ReviewFinalizationResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  intent: 'finalize-summary';
  requestRef: string;
  taskId: string | null;
  stage: string;
  artifact: string;
  stageStatus: LedgerStageStatus | null;
  operations: readonly {
    kind: 'artifact';
    artifact: string;
    operation: 'update';
  }[];
  error: ReviewFinalizationError | null;
};
type ReviewFileSystem = {
  readFileSync: (file: string) => string;
  statModeSync: (file: string) => number;
  writeFileSync: (file: string, content: string, mode: number) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (file: string) => void;
};
type ReviewFinalizationOptions = {
  repoRoot?: string;
  randomSuffix?: () => string;
  fileSystem?: Partial<ReviewFileSystem>;
};

const STAGES: Record<ReviewStage, { family: 'review-analysis' | 'review-plan' | 'review-code'; action: string }> = {
  analysis: { family: 'review-analysis', action: 'Review Analysis' },
  plan: { family: 'review-plan', action: 'Review Plan' },
  code: { family: 'review-code', action: 'Review Code' }
};
const DEFAULT_FILE_SYSTEM: ReviewFileSystem = {
  readFileSync: (file) => fs.readFileSync(file, 'utf8'),
  statModeSync: (file) => fs.statSync(file).mode,
  writeFileSync: (file, content, mode) => fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode }),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (file) => fs.unlinkSync(file)
};

function failed(
  request: ReviewFinalizationRequest,
  code: ReviewFinalizationErrorCode,
  message: string,
  taskId: string | null = null,
  stageStatus: LedgerStageStatus | null = null
): ReviewFinalizationResult {
  return {
    status: 'failed',
    changed: false,
    intent: 'finalize-summary',
    requestRef: request.taskRef,
    taskId,
    stage: request.stage,
    artifact: request.artifact,
    stageStatus,
    operations: [],
    error: { code, message }
  };
}

function openReviewRound(content: string, action: string, round: number): boolean {
  const section = locateActivityLog(content);
  if (!section) return false;
  const expected = `${action} (Round ${round})`;
  return pairEntries(section.entries).filter((row) => (
    row.step === expected && Boolean(row.started) && !row.done
  )).length === 1;
}

function cleanupTemp(fileSystem: ReviewFileSystem, tempPath: string): void {
  try {
    fileSystem.unlinkSync(tempPath);
  } catch {
    // Best-effort cleanup preserves the primary failure.
  }
}

function finalizeReviewSummaryUnlocked(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewFinalizationResult {
  const stage = request.stage as ReviewStage;
  const spec = STAGES[stage];
  if (!spec) return failed(request, 'REVIEW_STAGE_INVALID', `unsupported review stage '${request.stage}'`);
  if (!request.taskRef || !request.artifact) {
    return failed(request, 'REVIEW_PAYLOAD_INVALID', 'taskRef, stage, and artifact are required');
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(request, resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') {
    return failed(request, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  }
  const parsedArtifact = parseArtifactName(request.artifact);
  if (!parsedArtifact || parsedArtifact.family !== spec.family) {
    return failed(
      request,
      'REVIEW_ARTIFACT_IDENTITY_INVALID',
      `artifact '${request.artifact}' does not match ${spec.family}`,
      resolved.taskId
    );
  }
  const validated = validateCompletedArtifact(
    resolved.taskDir,
    spec.family,
    request.artifact,
    parsedArtifact.round
  );
  if (!validated.ok) {
    const code = validated.error.code === 'ARTIFACT_NOT_REGULAR'
      ? 'REVIEW_ARTIFACT_NOT_REGULAR'
      : 'REVIEW_ARTIFACT_IDENTITY_INVALID';
    return failed(request, code, validated.error.message, resolved.taskId);
  }

  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  let taskContent: string;
  let artifactContent: string;
  try {
    taskContent = fileSystem.readFileSync(resolved.taskMdPath);
    artifactContent = fileSystem.readFileSync(validated.artifact.path);
  } catch (error) {
    return failed(request, 'REVIEW_ARTIFACT_NOT_REGULAR', String(error), resolved.taskId);
  }
  if (!openReviewRound(taskContent, spec.action, parsedArtifact.round)) {
    return failed(
      request,
      'REVIEW_ARTIFACT_IDENTITY_INVALID',
      `${request.artifact} does not have one matching open started review event`,
      resolved.taskId
    );
  }
  const execution = validateLifecycleExecution(request.taskRef, {
    mode: request.orchestrated ? 'orchestrated' : 'standalone',
    identity: {
      stage: spec.family,
      round: parsedArtifact.round,
      artifact: request.artifact,
      role: 'reviewer'
    },
    dryRun: request.dryRun
  }, { repoRoot: options.repoRoot });
  if (!execution.ok) {
    return failed(
      request,
      'REVIEW_PROVENANCE_INVALID',
      `${execution.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH'}: ${execution.error?.message ?? 'orchestration provenance validation failed'}`,
      resolved.taskId
    );
  }

  let rows;
  try {
    rows = parseLedger(taskContent);
  } catch (error) {
    return failed(request, 'REVIEW_LEDGER_INVALID', String(error), resolved.taskId);
  }
  const ledgerError = validateLedgerRows(rows);
  if (ledgerError) {
    return failed(
      request,
      'REVIEW_LEDGER_INVALID',
      `${ledgerError.code}: ${ledgerError.message}`,
      resolved.taskId
    );
  }
  const stageStatus = summarizeLedgerStage(rows, stage);
  const transformed = finalizeReviewSummaryContent(
    artifactContent,
    stageStatus.unresolvedFindingCounts
  );
  if (!transformed.ok) {
    return failed(request, transformed.code, transformed.message, resolved.taskId, stageStatus);
  }
  if (!transformed.changed) {
    return {
      ...failed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, stageStatus),
      status: 'no-op',
      error: null
    };
  }
  const operations = [{ kind: 'artifact' as const, artifact: request.artifact, operation: 'update' as const }];
  if (request.dryRun) {
    return {
      ...failed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, stageStatus),
      status: 'planned',
      changed: true,
      operations,
      error: null
    };
  }

  const tempPath = path.join(
    resolved.taskDir,
    `.${request.artifact}.tmp-${process.pid}-${(options.randomSuffix ?? randomUUID)()}`
  );
  let mode: number;
  try {
    mode = fileSystem.statModeSync(validated.artifact.path);
    fileSystem.writeFileSync(tempPath, transformed.content, mode);
  } catch (error) {
    cleanupTemp(fileSystem, tempPath);
    return failed(request, 'REVIEW_TEMP_WRITE_FAILED', String(error), resolved.taskId, stageStatus);
  }
  try {
    if (fileSystem.readFileSync(validated.artifact.path) !== artifactContent) {
      cleanupTemp(fileSystem, tempPath);
      return failed(
        request,
        'REVIEW_ARTIFACT_CONFLICT',
        `${request.artifact} changed during finalization`,
        resolved.taskId,
        stageStatus
      );
    }
    fileSystem.renameSync(tempPath, validated.artifact.path);
  } catch (error) {
    cleanupTemp(fileSystem, tempPath);
    return failed(request, 'REVIEW_RENAME_FAILED', String(error), resolved.taskId, stageStatus);
  }
  return {
    status: 'applied',
    changed: true,
    intent: 'finalize-summary',
    requestRef: request.taskRef,
    taskId: resolved.taskId,
    stage,
    artifact: request.artifact,
    stageStatus,
    operations,
    error: null
  };
}

function finalizeReviewSummary(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewFinalizationResult {
  if (request.dryRun) return finalizeReviewSummaryUnlocked(request, options);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return finalizeReviewSummaryUnlocked(request, options);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      'task-review.finalize-summary',
      () => finalizeReviewSummaryUnlocked(request, options)
    );
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    return failed(
      request,
      'REVIEW_PROVENANCE_INVALID',
      `${error.code}: ${error.message}`,
      resolved.taskId
    );
  }
}

export { finalizeReviewSummary };
export type {
  ReviewFinalizationError,
  ReviewFinalizationErrorCode,
  ReviewFinalizationOptions,
  ReviewFinalizationRequest,
  ReviewFinalizationResult
};
