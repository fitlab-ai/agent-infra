import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseArtifactName } from './artifact-name.ts';
import { validateCompletedArtifact, validateArtifactPublication } from './artifact-lifecycle.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import type { LedgerStageStatus, ReviewStage } from './ledger.ts';
import { finalizeReviewSummaryContent } from './review-artifacts.ts';
import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import type { ResolveTaskRefErrorCode } from './resolve-ref.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { validateQualificationAudit } from './qualification-audit.ts';
import { canonicalSemanticDigest, inspectArtifactContract, sha256Content } from './artifact-operations.ts';

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
  | 'REVIEW_RECOVERY_COMMIT_FAILED';
type ReviewFinalizationError = { code: ReviewFinalizationErrorCode; message: string };
type ReviewFinalizationRequest = {
  taskRef: string;
  stage: string;
  artifact: string;
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

type PreflightContext = Readonly<{
  spec: (typeof STAGES)[ReviewStage];
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;
}>;
type PreflightContextResult = Readonly<{ ok: true; context: PreflightContext }> | Readonly<{ ok: false; result: ReviewPreflightResult }>;

function resolvePreflightContext(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): PreflightContextResult {
  const stage = request.stage as ReviewStage;
  const spec = STAGES[stage];
  if (!spec) return { ok: false, result: preflightFailed(request, 'REVIEW_STAGE_INVALID', `unsupported review stage '${request.stage}'`) };
  if (!request.taskRef || !request.artifact) return { ok: false, result: preflightFailed(request, 'REVIEW_PAYLOAD_INVALID', 'taskRef, stage, and artifact are required') };
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { ok: false, result: preflightFailed(request, resolved.code, resolved.message, resolved.taskId ?? null) };
  if (resolved.state !== 'active') return { ok: false, result: preflightFailed(request, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId) };
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== spec.family) return { ok: false, result: preflightFailed(request, 'REVIEW_ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${spec.family}`, resolved.taskId) };
  const publicationError = validateArtifactPublication(resolved.taskDir, spec.family, request.artifact);
  if (publicationError) return { ok: false, result: preflightFailed(request, 'REVIEW_ARTIFACT_IDENTITY_INVALID', publicationError.message, resolved.taskId) };
  return { ok: true, context: { spec, resolved } };
}

function readPreflightArtifact(
  request: ReviewFinalizationRequest,
  context: PreflightContext
): { ok: true; content: string } | { ok: false; result: ReviewPreflightResult } {
  try {
    const validated = validateCompletedArtifact(context.resolved.taskDir, context.spec.family, request.artifact);
    if (!validated.ok) {
      const code = validated.error.code === 'ARTIFACT_NOT_REGULAR' ? 'REVIEW_ARTIFACT_NOT_REGULAR' : 'REVIEW_ARTIFACT_IDENTITY_INVALID';
      return { ok: false, result: preflightFailed(request, code, validated.error.message, context.resolved.taskId) };
    }
    return { ok: true, content: fs.readFileSync(validated.artifact.path, 'utf8') };
  } catch (error) {
    return { ok: false, result: preflightFailed(request, 'REVIEW_ARTIFACT_NOT_REGULAR', String(error), context.resolved.taskId) };
  }
}

function inspectPreflightArtifact(
  request: ReviewFinalizationRequest,
  context: PreflightContext,
  content: string
): ReviewPreflightResult {
  const artifactSha256 = sha256Content(content);
  const semanticDigest = canonicalSemanticDigest(content);
  const detail = inspectDecisionDetailDuplicates(content);
  const structure = inspectArtifactContract(content, getArtifactSchema(context.spec.family)!);
  if (!detail.ok || !structure.ok) {
    const diagnostics = [
      ...(!detail.ok ? [`${detail.code}: ${detail.message}`] : []),
      ...structure.diagnostics.map((item) => `${item.code}: ${item.message}`)
    ].join('; ');
    return preflightFailed(request, !detail.ok ? 'REVIEW_DECISION_DETAIL_INVALID' : 'REVIEW_ARTIFACT_STRUCTURE_INVALID', diagnostics, context.resolved.taskId, {
      artifactSha256, semanticDigest,
    });
  }
  return {
    ...preflightFailed(request, 'REVIEW_ARTIFACT_CONFLICT', '', context.resolved.taskId, { artifactSha256, semanticDigest }),
    status: 'passed', changed: false, error: null
  };
}

/** Validate the current review draft before any finding-ledger write. */
function preflightReviewSummary(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewPreflightResult {
  const context = resolvePreflightContext(request, options);
  if (!context.ok) return context.result;
  const artifact = readPreflightArtifact(request, context.context);
  if (!artifact.ok) return artifact.result;
  return inspectPreflightArtifact(request, context.context, artifact.content);
}

type ReviewSummaryCandidatePreparation = Readonly<{
  result: ReviewFinalizationResult;
  content: string;
}>;

type CandidateContext = Readonly<{
  stage: ReviewStage;
  spec: (typeof STAGES)[ReviewStage];
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;
}>;
type CandidateContextResult = Readonly<{ ok: true; context: CandidateContext }> | Readonly<{ ok: false; result: ReviewSummaryCandidatePreparation }>;

function candidateFailure(
  request: ReviewFinalizationRequest,
  content: string,
  code: ReviewFinalizationErrorCode,
  message: string,
  taskId: string | null = null,
  stageStatus: LedgerStageStatus | null = null,
  extra: Partial<ReviewFinalizationResult> = {}
): ReviewSummaryCandidatePreparation {
  return { result: failed(request, code, message, taskId, stageStatus, extra), content };
}

function resolveCandidateContext(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  options: ReviewFinalizationOptions
): CandidateContextResult {
  const stage = request.stage as ReviewStage;
  const spec = STAGES[stage];
  if (!spec) return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_STAGE_INVALID', `unsupported review stage '${request.stage}'`) };
  if (!request.taskRef || !request.artifact) return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_PAYLOAD_INVALID', 'taskRef, stage, and artifact are required') };
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  const taskId = resolved.taskId ?? null;
  if (!resolved.ok) return { ok: false, result: candidateFailure(request, artifactContent, resolved.code, resolved.message, taskId) };
  if (resolved.state !== 'active') return { ok: false, result: candidateFailure(request, artifactContent, 'TASK_STATE_MISMATCH', `task ${taskId} is ${resolved.state}, expected active`, taskId) };
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== spec.family) return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${spec.family}`, taskId) };
  const publicationError = validateArtifactPublication(resolved.taskDir, spec.family, request.artifact);
  if (publicationError) return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_ARTIFACT_IDENTITY_INVALID', publicationError.message, taskId) };
  return { ok: true, context: { stage, spec, resolved } };
}

function readCandidateTaskContent(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  context: CandidateContext,
  options: ReviewFinalizationOptions
): { ok: true; taskContent: string } | { ok: false; result: ReviewSummaryCandidatePreparation } {
  try {
    const readFile = options.fileSystem?.readFileSync ?? DEFAULT_FILE_SYSTEM.readFileSync;
    return { ok: true, taskContent: readFile(context.resolved.taskMdPath) };
  } catch (error) {
    return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_ARTIFACT_NOT_REGULAR', String(error), context.resolved.taskId) };
  }
}

function validateCandidateLedger(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  taskContent: string,
  context: CandidateContext
): { ok: true; stageStatus: LedgerStageStatus } | { ok: false; result: ReviewSummaryCandidatePreparation } {
  try {
    const ledger = parseLedgerDocument(taskContent);
    if (!ledger.present) return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_LEDGER_INVALID', `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}`, context.resolved.taskId) };
    const error = validateLedgerRows(ledger.rows);
    if (error) return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_LEDGER_INVALID', `${error.code}: ${error.message}`, context.resolved.taskId) };
    return { ok: true, stageStatus: summarizeLedgerStage(ledger.rows, context.stage) };
  } catch (error) {
    return { ok: false, result: candidateFailure(request, artifactContent, 'REVIEW_LEDGER_INVALID', String(error), context.resolved.taskId) };
  }
}

function validateCandidateArtifact(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  taskContent: string,
  context: CandidateContext,
  stageStatus: LedgerStageStatus,
  digests: { artifactSha256: string; semanticDigest: string }
): ReviewSummaryCandidatePreparation | null {
  const detail = inspectDecisionDetailDuplicates(artifactContent);
  if (!detail.ok) return candidateFailure(request, artifactContent, 'REVIEW_DECISION_DETAIL_INVALID', `${detail.code}: ${detail.message}`, context.resolved.taskId, stageStatus);
  const structure = inspectArtifactContract(artifactContent, getArtifactSchema(context.spec.family)!);
  if (!structure.ok) return candidateFailure(request, artifactContent, 'REVIEW_ARTIFACT_STRUCTURE_INVALID', structure.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '), context.resolved.taskId, stageStatus, {
    artifactSha256: digests.artifactSha256, semanticDigest: structure.semanticDigest
  });
  const qualification = validateQualificationAudit(taskContent, artifactContent, { family: context.spec.family, artifact: request.artifact });
  if (!qualification.ok) return candidateFailure(request, artifactContent, 'REVIEW_ARTIFACT_STRUCTURE_INVALID', `${qualification.code}: ${qualification.message}`, context.resolved.taskId, stageStatus, digests);
  return null;
}

function finalizeCandidateSummary(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  context: CandidateContext,
  stageStatus: LedgerStageStatus
): ReviewSummaryCandidatePreparation {
  const transformed = finalizeReviewSummaryContent(artifactContent, stageStatus.unresolvedFindingCounts, {
    refreshNumericCounts: true
  });
  if (!transformed.ok) return candidateFailure(request, artifactContent, transformed.code, transformed.message, context.resolved.taskId, stageStatus);
  const finalDigests = { artifactSha256: sha256Content(transformed.content), semanticDigest: canonicalSemanticDigest(transformed.content) };
  return {
    content: transformed.content,
    result: {
      ...failed(request, 'REVIEW_ARTIFACT_CONFLICT', '', context.resolved.taskId, stageStatus, finalDigests),
      status: transformed.changed ? request.dryRun ? 'planned' : 'applied' : 'no-op',
      changed: transformed.changed,
      operations: transformed.changed ? [{ kind: 'artifact', artifact: request.artifact, operation: 'update' }] : [],
      error: null
    },
  };
}

/** Prepare domain validation, summary bytes and provenance before any publication. */
function prepareReviewSummaryCandidate(
  request: ReviewFinalizationRequest,
  artifactContent: string,
  options: ReviewFinalizationOptions = {}
): ReviewSummaryCandidatePreparation {
  const context = resolveCandidateContext(request, artifactContent, options);
  if (!context.ok) return context.result;
  const task = readCandidateTaskContent(request, artifactContent, context.context, options);
  if (!task.ok) return task.result;
  const digests = { artifactSha256: sha256Content(artifactContent), semanticDigest: canonicalSemanticDigest(artifactContent) };
  const ledger = validateCandidateLedger(request, artifactContent, task.taskContent, context.context);
  if (!ledger.ok) return ledger.result;
  const artifactError = validateCandidateArtifact(request, artifactContent, task.taskContent, context.context, ledger.stageStatus, digests);
  if (artifactError) return artifactError;
  return finalizeCandidateSummary(request, artifactContent, context.context, ledger.stageStatus);
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

function finalizeReviewSummary(
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
  if (prepared.result.status === 'failed' || !prepared.result.changed) return prepared.result;
  try {
    replaceCurrentArtifactAtomically(validated.artifact.path, prepared.content);
    return {
      ...prepared.result,
      status: 'applied',
      artifactSha256: sha256Content(prepared.content),
      semanticDigest: canonicalSemanticDigest(prepared.content)
    };
  } catch (error) {
    return failed(
      request,
      'REVIEW_RECOVERY_COMMIT_FAILED',
      `cannot update current review artifact: ${error instanceof Error ? error.message : String(error)}`,
      resolved.taskId
    );
  }
}

export { finalizeReviewSummary, preflightReviewSummary, prepareReviewSummaryCandidate };
export type {
  ReviewFinalizationError,
  ReviewFinalizationErrorCode,
  ReviewFinalizationOptions,
  ReviewFinalizationRequest,
  ReviewFinalizationResult,
  ReviewPreflightResult,
  ReviewSummaryCandidatePreparation
};
