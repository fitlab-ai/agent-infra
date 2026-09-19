import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { parseArtifactName } from './artifact-name.ts';
import { validateCompletedArtifact, validateArtifactPublication } from './artifact-lifecycle.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import type { LedgerStageStatus, ReviewStage } from './ledger.ts';
import { finalizeReviewSummaryContent } from './review-artifacts.ts';
import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { validateLifecycleExecution } from './lifecycle-execution.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import type { ResolveTaskRefErrorCode } from './resolve-ref.ts';
import { allowsManualOverride } from './guard-override.ts';
import type { ManualOverrideCapability } from './guard-override.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { canonicalSemanticDigest, inspectArtifactContract, sha256Content } from './artifact-operations.ts';
import { expectedQualificationRelations, validateQualificationAudit } from './qualification-audit.ts';
import { currentLifecycleAuthority, recordLifecycleFinalizationReceipt } from './lifecycle-finalization-receipt.ts';
import { consumeLocalLifecycleAuthorityPhase, reserveLocalLifecycleAuthorityPhase } from './local-lifecycle-authority.ts';

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
  | 'REVIEW_ARTIFACT_QUALIFICATION_INVALID'
  | 'REVIEW_DECISION_DETAIL_INVALID'
  | 'REVIEW_ARTIFACT_CONFLICT'
  | 'REVIEW_PROVENANCE_INVALID'
  | 'REVIEW_RECOVERY_COMMIT_FAILED';
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
  operations: readonly {
    kind: 'artifact';
    artifact: string;
    operation: 'update';
  }[];
  error: ReviewFinalizationError | null;
};
type ReviewPreflightResult = Omit<ReviewFinalizationResult, 'status' | 'intent' | 'stageStatus'> & {
  status: 'passed' | 'failed';
  intent: 'preflight';
  stageStatus: null;
};
type ReviewFileSystem = {
  readFileSync: (file: string) => string;
};
type ReviewFinalizationOptions = {
  repoRoot?: string;
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
  readFileSync: (file) => fs.readFileSync(file, 'utf8')
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
    operations: [],
    error: { code, message },
    ...extra
  };
}

function preflightFailed(
  request: ReviewFinalizationRequest,
  code: ReviewFinalizationErrorCode,
  message: string,
  taskId: string | null = null,
  extra: Partial<ReviewPreflightResult> = {}
): ReviewPreflightResult {
  const { status: _status, intent: _intent, stageStatus: _stageStatus, ...finalizationExtra } = extra;
  return {
    ...failed(request, code, message, taskId, null, finalizationExtra),
    status: 'failed',
    intent: 'preflight',
    stageStatus: null
  };
}

/** Validate the current review draft before any finding-ledger write. */
function preflightReviewSummaryUnlocked(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewPreflightResult {
  const stage = request.stage as ReviewStage;
  const spec = STAGES[stage];
  if (!spec) return preflightFailed(request, 'REVIEW_STAGE_INVALID', `unsupported review stage '${request.stage}'`);
  if (!request.taskRef || !request.artifact) return preflightFailed(request, 'REVIEW_PAYLOAD_INVALID', 'taskRef, stage, and artifact are required');
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return preflightFailed(request, resolved.code, resolved.message, resolved.taskId ?? null);
  if (resolved.state !== 'active') return preflightFailed(request, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== spec.family) return preflightFailed(request, 'REVIEW_ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${spec.family}`, resolved.taskId);
  const publicationError = validateArtifactPublication(resolved.taskDir, spec.family, request.artifact);
  if (publicationError) return preflightFailed(request, 'REVIEW_ARTIFACT_IDENTITY_INVALID', publicationError.message, resolved.taskId);

  let taskContent: string;
  let content: string;
  try {
    taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
    const validated = validateCompletedArtifact(resolved.taskDir, spec.family, request.artifact);
    if (!validated.ok) return preflightFailed(request, validated.error.code === 'ARTIFACT_NOT_REGULAR' ? 'REVIEW_ARTIFACT_NOT_REGULAR' : 'REVIEW_ARTIFACT_IDENTITY_INVALID', validated.error.message, resolved.taskId);
    content = fs.readFileSync(validated.artifact.path, 'utf8');
  } catch (error) { return preflightFailed(request, 'REVIEW_ARTIFACT_NOT_REGULAR', String(error), resolved.taskId); }

  const execution = validateLifecycleExecution(request.taskRef, {
    mode: request.orchestrated ? 'orchestrated' : 'standalone',
    identity: { stage: spec.family, round: parsed.round, artifact: request.artifact, role: 'reviewer' },
    dryRun: request.dryRun
  }, { repoRoot: options.repoRoot });
  if (!execution.ok) return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', `${execution.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH'}: ${execution.error?.message ?? 'orchestration provenance validation failed'}`, resolved.taskId);

  const artifactSha256 = sha256Content(content);
  const semanticDigest = canonicalSemanticDigest(content);
  const detail = inspectDecisionDetailDuplicates(content);
  const structure = inspectArtifactContract(content, getArtifactSchema(spec.family)!);
  const expected = expectedQualificationRelations(taskContent, spec.family);
  if (!expected.ok) return preflightFailed(request, 'REVIEW_ARTIFACT_QUALIFICATION_INVALID', `${expected.code}: ${expected.message}`, resolved.taskId, { artifactSha256, semanticDigest });
  const qualification = validateQualificationAudit(taskContent, content, {
    family: spec.family,
    artifact: request.artifact,
    expectedUpstreamRelations: expected.relations
  });
  const qualificationError = qualification.ok ? null : qualification;
  if (!detail.ok || !structure.ok || qualificationError) {
    const diagnostics = [
      ...(!detail.ok ? [`${detail.code}: ${detail.message}`] : []),
      ...structure.diagnostics.map((item) => `${item.code}: ${item.message}`),
      ...(qualificationError ? [`${qualificationError.code}: ${qualificationError.message}`] : [])
    ].join('; ');
    return preflightFailed(request, !detail.ok ? 'REVIEW_DECISION_DETAIL_INVALID' : !structure.ok ? 'REVIEW_ARTIFACT_STRUCTURE_INVALID' : 'REVIEW_ARTIFACT_QUALIFICATION_INVALID', diagnostics, resolved.taskId, {
      artifactSha256, semanticDigest,
    });
  }
  if (request.dryRun) {
    return {
      ...preflightFailed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, { artifactSha256, semanticDigest }),
      status: 'passed', changed: false, error: null
    };
  }
  return {
    ...preflightFailed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, { artifactSha256, semanticDigest }),
    status: 'passed', changed: false, error: null
  };
}

function preflightReviewSummary(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewPreflightResult {
  if (request.dryRun || options.lockAlreadyHeld) return preflightReviewSummaryUnlocked(request, options);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return preflightReviewSummaryUnlocked(request, options);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      'task-review.preflight',
      () => preflightReviewSummaryUnlocked(request, { ...options, lockAlreadyHeld: true })
    );
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', `${error.code}: ${error.message}`, resolved.taskId);
  }
}

type ReviewSummaryCandidatePreparation = Readonly<{
  result: ReviewFinalizationResult;
  content: string;
  lockAlreadyHeld?: boolean;
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
  const schema = getArtifactSchema(spec.family)!;
  const structure = inspectArtifactContract(artifactContent, schema);
  if (!structure.ok) {
    return reject('REVIEW_ARTIFACT_STRUCTURE_INVALID', structure.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '), {
      artifactSha256, semanticDigest: structure.semanticDigest
    });
  }
  const transformed = finalizeReviewSummaryContent(artifactContent, stageStatus.unresolvedFindingCounts, {
    refreshNumericCounts: true
  });
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
    lockAlreadyHeld: options.lockAlreadyHeld
  };
}

function commitReviewSummaryProvenance(
  prepared: ReviewSummaryCandidatePreparation,
  repoRoot: string,
  options: Readonly<{ afterPublish?: () => void }> = {}
): ReviewFinalizationResult {
  const result = prepared.result;
  if (result.status === 'failed' || result.status === 'planned' || !result.taskId
    || !result.artifactSha256 || !result.semanticDigest) return result;
  const parsed = parseArtifactName(result.artifact);
  const spec = STAGES[result.stage as ReviewStage];
  if (!parsed || !spec) return failed({
    taskRef: result.requestRef, stage: result.stage, artifact: result.artifact
  }, 'REVIEW_ARTIFACT_IDENTITY_INVALID', 'review artifact identity is invalid', result.taskId);
  try {
    options.afterPublish?.();
    const authority = currentLifecycleAuthority(process.env, result.taskId);
    const operationId = createHash('sha256').update([
      result.taskId, spec.family, result.artifact, result.artifactSha256, result.semanticDigest
    ].join('\0')).digest('hex');
    const attestation = authority.mode === 'sandbox-active'
      ? reserveLocalLifecycleAuthorityPhase({
          taskId: result.taskId, family: spec.family, artifact: result.artifact,
          round: parsed.round, operationId, phase: 'artifact.finalize-local',
          lifecycleRequestId: `${spec.family}:${result.artifact}:finalize`
        })
      : null;
    recordLifecycleFinalizationReceipt(repoRoot, {
      taskId: result.taskId,
      family: spec.family,
      artifact: result.artifact,
      round: parsed.round,
      artifactSha256: result.artifactSha256,
      semanticDigest: result.semanticDigest,
      finalizer: 'review',
      authorityMode: authority.mode,
      authorityDigest: authority.digest
    }, { operationId });
    consumeLocalLifecycleAuthorityPhase(attestation);
    return result;
  } catch (error) {
    return failed(
      { taskRef: result.requestRef, stage: result.stage, artifact: result.artifact },
      'REVIEW_RECOVERY_COMMIT_FAILED',
      error instanceof Error ? error.message : String(error),
      result.taskId,
      result.stageStatus,
      { artifactSha256: result.artifactSha256, semanticDigest: result.semanticDigest }
    );
  }
}

function replaceCurrentArtifactAtomically(file: string, content: string): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
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
  if (prepared.result.status === 'failed') return prepared.result;
  if (!prepared.result.changed) return commitReviewSummaryProvenance(prepared, resolved.repoRoot);
  try {
    replaceCurrentArtifactAtomically(validated.artifact.path, prepared.content);
    const published = {
      ...prepared.result,
      status: 'applied',
      artifactSha256: sha256Content(prepared.content),
      semanticDigest: canonicalSemanticDigest(prepared.content)
    } as ReviewFinalizationResult;
    return commitReviewSummaryProvenance({ ...prepared, result: published }, resolved.repoRoot);
  } catch (error) {
    return failed(
      request,
      'REVIEW_RECOVERY_COMMIT_FAILED',
      `cannot update current review artifact: ${error instanceof Error ? error.message : String(error)}`,
      resolved.taskId
    );
  }
}

function finalizeReviewSummary(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewFinalizationResult {
  const effectiveOptions = options;
  if (request.dryRun || options.lockAlreadyHeld) return finalizeReviewSummaryUnlocked(request, effectiveOptions);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return finalizeReviewSummaryUnlocked(request, effectiveOptions);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      'task-review.finalize-summary',
      () => finalizeReviewSummaryUnlocked(request, { ...effectiveOptions, lockAlreadyHeld: true })
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

export { finalizeReviewSummary, preflightReviewSummary, prepareReviewSummaryCandidate, commitReviewSummaryProvenance };
export type {
  ReviewFinalizationError,
  ReviewFinalizationErrorCode,
  ReviewFinalizationOptions,
  ReviewFinalizationRequest,
  ReviewFinalizationResult,
  ReviewPreflightResult,
  ReviewSummaryCandidatePreparation
};
