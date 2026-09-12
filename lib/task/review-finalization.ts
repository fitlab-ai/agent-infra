import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseArtifactName } from './artifact-name.ts';
import { validateCompletedArtifact, hasOpenArtifactRound, validateArtifactPublication } from './artifact-lifecycle.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import type { LedgerStageStatus, ReviewStage } from './ledger.ts';
import { finalizeReviewSummaryContent } from './review-artifacts.ts';
import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { validateLifecycleExecution } from './lifecycle-execution.ts';
import { TaskExecutionLockError, transitionLeaseHeld, withTaskExecutionLock } from './task-execution-lock.ts';
import type { ResolveTaskRefErrorCode } from './resolve-ref.ts';
import { allowsManualOverride } from './guard-override.ts';
import type { ManualOverrideCapability } from './guard-override.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { canonicalSemanticDigest, inspectArtifactContract, sha256Content } from './artifact-operations.ts';
import { readArtifactRepairIntent, writeArtifactRepairIntent } from './artifact-repair-intent.ts';
import type { ArtifactRepairOperation } from './artifact-operations.ts';
import type { ArtifactRepairIntent } from './artifact-repair-intent.ts';

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
  | 'REVIEW_ARTIFACT_STRUCTURE_INVALID'
  | 'REVIEW_DECISION_DETAIL_INVALID'
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
  artifactSha256: string | null;
  semanticDigest: string | null;
  repairable: boolean;
  operation: ArtifactRepairOperation | null;
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
  manualOverride?: ManualOverrideCapability;
  lockAlreadyHeld?: boolean;
};

const STAGES: Record<ReviewStage, { family: 'review-analysis' | 'review-plan' | 'review-code' }> = {
  analysis: { family: 'review-analysis' },
  plan: { family: 'review-plan' },
  code: { family: 'review-code' }
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
  stageStatus: LedgerStageStatus | null = null,
  extra: Partial<ReviewFinalizationResult> = {}
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
    artifactSha256: null,
    semanticDigest: null,
    repairable: false,
    operation: null,
    operations: [],
    error: { code, message },
    ...extra
  };
}

function cleanupTemp(fileSystem: ReviewFileSystem, tempPath: string): void {
  try {
    fileSystem.unlinkSync(tempPath);
  } catch {
    // Best-effort cleanup preserves the primary failure.
  }
}

type ReviewSummaryCandidatePreparation = Readonly<{
  result: ReviewFinalizationResult;
  content: string;
  provenance?: Parameters<typeof writeArtifactRepairIntent>[1];
  expectedIntent?: ArtifactRepairIntent | null;
}>;

/** Prepare domain validation, summary bytes and provenance before any publication. */
function prepareReviewSummaryCandidate(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  options: ReviewFinalizationOptions = {}
): ReviewSummaryCandidatePreparation {
  let taskId: string | null = null;
  let stageStatus: LedgerStageStatus | null = null;
  const reject = (code: ReviewFinalizationErrorCode, message: string, extra: Partial<ReviewFinalizationResult> = {}): ReviewSummaryCandidatePreparation => ({
    result: failed(request, code, message, taskId, stageStatus, extra), content: artifactContent
  });
  const stage = request.stage as ReviewStage;
  const spec = STAGES[stage];
  if (!spec) return reject('REVIEW_STAGE_INVALID', `unsupported review stage '${request.stage}'`);
  if (!request.taskRef || !request.artifact) return reject('REVIEW_PAYLOAD_INVALID', 'taskRef, stage, and artifact are required');
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  taskId = resolved.taskId ?? null;
  if (!resolved.ok) return reject(resolved.code, resolved.message);
  if (resolved.state !== 'active' && !allowsManualOverride(options.manualOverride, 'review-finalization', 'TASK_STATE_MISMATCH')) {
    return reject('TASK_STATE_MISMATCH', `task ${taskId} is ${resolved.state}, expected active`);
  }
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== spec.family) return reject('REVIEW_ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${spec.family}`);
  const publicationError = validateArtifactPublication(resolved.taskDir, spec.family, request.artifact);
  if (publicationError) return reject('REVIEW_ARTIFACT_IDENTITY_INVALID', publicationError.message);
  let taskContent: string;
  try { taskContent = (options.fileSystem?.readFileSync ?? DEFAULT_FILE_SYSTEM.readFileSync)(resolved.taskMdPath); }
  catch (error) { return reject('REVIEW_ARTIFACT_NOT_REGULAR', String(error)); }
  const artifactSha256 = sha256Content(artifactContent);
  const semanticDigest = canonicalSemanticDigest(artifactContent);
  const digests = { artifactSha256, semanticDigest };
  let repairIntent;
  try { repairIntent = readArtifactRepairIntent(resolved.repoRoot, taskId!, spec.family, request.artifact); }
  catch (error) { return reject('REVIEW_PROVENANCE_INVALID', String(error), digests); }
  const schema = getArtifactSchema(spec.family)!;
  const structure = inspectArtifactContract(artifactContent, schema);
  if (!structure.ok) {
    const repairable = structure.repair !== null && structure.diagnostics.length === 1 && structure.diagnostics[0]?.repairable === true;
    if (repairable && repairIntent && (repairIntent.state !== 'awaiting-repair'
      || repairIntent.artifactSha256 !== artifactSha256 || repairIntent.semanticDigest !== structure.semanticDigest)) {
      return reject('REVIEW_PROVENANCE_INVALID', 'a different review repair baseline is already recorded for this artifact', digests);
    }
    return {
      ...reject('REVIEW_ARTIFACT_STRUCTURE_INVALID', structure.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '), {
        artifactSha256, semanticDigest: structure.semanticDigest, repairable, operation: structure.repair
      }),
      ...(repairable && !repairIntent ? { provenance: {
        version: 2 as const, taskId: taskId!, family: spec.family, artifact: request.artifact,
        state: 'awaiting-repair' as const, baselineSemanticDigest: structure.semanticDigest,
        artifactSha256, semanticDigest: structure.semanticDigest,
        recoveryOperationId: null, phase: null, authorityDigest: null,
        requestId: `review-finalize:${taskId!}`, createdAt: Date.now(), updatedAt: Date.now()
      }, expectedIntent: null } : {})
    };
  }
  if (repairIntent?.state === 'awaiting-repair' && repairIntent.baselineSemanticDigest !== semanticDigest) {
    return reject('REVIEW_PROVENANCE_INVALID', 'the repaired review artifact semantic digest does not match the recorded repair baseline', digests);
  }
  if ((repairIntent?.state === 'passed' || repairIntent?.state === 'consumed')
    && (repairIntent.artifactSha256 !== artifactSha256 || repairIntent.semanticDigest !== semanticDigest)) {
    return reject('REVIEW_PROVENANCE_INVALID', 'the review artifact changed after its finalization provenance was recorded', digests);
  }
  if (!hasOpenArtifactRound(taskContent, spec.family, parsed.round)) {
    return reject('REVIEW_ARTIFACT_IDENTITY_INVALID', `${request.artifact} does not have one matching open started review event`);
  }
  const execution = validateLifecycleExecution(request.taskRef, {
    mode: request.orchestrated ? 'orchestrated' : 'standalone',
    identity: { stage: spec.family, round: parsed.round, artifact: request.artifact, role: 'reviewer' },
    dryRun: request.dryRun
  }, { repoRoot: options.repoRoot });
  if (!execution.ok) {
    return reject('REVIEW_PROVENANCE_INVALID', `${execution.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH'}: ${execution.error?.message ?? 'orchestration provenance validation failed'}`);
  }
  try {
    const ledger = parseLedgerDocument(taskContent);
    if (!ledger.present) return reject('REVIEW_LEDGER_INVALID', `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}`);
    const error = validateLedgerRows(ledger.rows);
    if (error) return reject('REVIEW_LEDGER_INVALID', `${error.code}: ${error.message}`);
    stageStatus = summarizeLedgerStage(ledger.rows, stage);
  } catch (error) { return reject('REVIEW_LEDGER_INVALID', String(error)); }
  const detail = inspectDecisionDetailDuplicates(artifactContent);
  if (!detail.ok) return reject('REVIEW_DECISION_DETAIL_INVALID', `${detail.code}: ${detail.message}`);
  const transformed = finalizeReviewSummaryContent(artifactContent, stageStatus.unresolvedFindingCounts);
  if (!transformed.ok) return reject(transformed.code, transformed.message);
  const finalDigests = { artifactSha256: sha256Content(transformed.content), semanticDigest: canonicalSemanticDigest(transformed.content) };
  return {
    content: transformed.content,
    result: {
      ...failed(request, 'REVIEW_ARTIFACT_CONFLICT', '', taskId, stageStatus, finalDigests),
      status: transformed.changed ? request.dryRun ? 'planned' : 'applied' : 'no-op',
      changed: transformed.changed,
      operations: transformed.changed ? [{ kind: 'artifact', artifact: request.artifact, operation: 'update' }] : [],
      error: null
    },
    ...(repairIntent?.state === 'awaiting-repair' ? {
      provenance: { ...repairIntent, state: 'passed' as const, ...finalDigests },
      expectedIntent: repairIntent
    } : {})
  };
}

function commitReviewSummaryProvenance(
  prepared: ReviewSummaryCandidatePreparation,
  repoRoot: string
): ReviewFinalizationResult {
  try {
    if (prepared.provenance) {
      writeArtifactRepairIntent(repoRoot, prepared.provenance, { expected: prepared.expectedIntent ?? null });
    }
    return prepared.result;
  } catch (error) {
    return { ...prepared.result, status: 'failed', error: {
      code: 'REVIEW_PROVENANCE_INVALID', message: `cannot record review provenance: ${String(error)}`
    } };
  }
}

function finalizeReviewSummaryUnlocked(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewFinalizationResult {
  const spec = STAGES[request.stage as ReviewStage];
  if (!spec || !request.taskRef || !request.artifact) return prepareReviewSummaryCandidate(request, '', options).result;
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(request, resolved.code, resolved.message, resolved.taskId);
  const validated = validateCompletedArtifact(resolved.taskDir, spec.family, request.artifact);
  if (!validated.ok) {
    return failed(request, validated.error.code === 'ARTIFACT_NOT_REGULAR' ? 'REVIEW_ARTIFACT_NOT_REGULAR' : 'REVIEW_ARTIFACT_IDENTITY_INVALID', validated.error.message, resolved.taskId);
  }
  const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  let content: string;
  try { content = fileSystem.readFileSync(validated.artifact.path); }
  catch (error) { return failed(request, 'REVIEW_ARTIFACT_NOT_REGULAR', String(error), resolved.taskId); }
  const prepared = prepareReviewSummaryCandidate(request, content, options);
  if (request.dryRun) return prepared.result;
  if (prepared.result.status !== 'applied') return commitReviewSummaryProvenance(prepared, resolved.repoRoot);
  const tempPath = path.join(resolved.taskDir, `.${request.artifact}.tmp-${process.pid}-${(options.randomSuffix ?? randomUUID)()}`);
  try {
    fileSystem.writeFileSync(tempPath, prepared.content, fileSystem.statModeSync(validated.artifact.path));
  } catch (error) {
    cleanupTemp(fileSystem, tempPath);
    return failed(request, 'REVIEW_TEMP_WRITE_FAILED', String(error), resolved.taskId, prepared.result.stageStatus);
  }
  try {
    if (fileSystem.readFileSync(validated.artifact.path) !== content) {
      cleanupTemp(fileSystem, tempPath);
      return failed(request, 'REVIEW_ARTIFACT_CONFLICT', `${request.artifact} changed during finalization`, resolved.taskId, prepared.result.stageStatus);
    }
    fileSystem.renameSync(tempPath, validated.artifact.path);
  } catch (error) {
    cleanupTemp(fileSystem, tempPath);
    return failed(request, 'REVIEW_RENAME_FAILED', String(error), resolved.taskId, prepared.result.stageStatus);
  }
  return commitReviewSummaryProvenance(prepared, resolved.repoRoot);
}

function finalizeReviewSummary(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewFinalizationResult {
  if (request.dryRun || (options.lockAlreadyHeld && transitionLeaseHeld())) {
    return finalizeReviewSummaryUnlocked(request, options);
  }
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

export { finalizeReviewSummary, prepareReviewSummaryCandidate, commitReviewSummaryProvenance };
export type {
  ReviewFinalizationError,
  ReviewFinalizationErrorCode,
  ReviewFinalizationOptions,
  ReviewFinalizationRequest,
  ReviewFinalizationResult,
  ReviewSummaryCandidatePreparation
};
