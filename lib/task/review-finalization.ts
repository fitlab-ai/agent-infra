import fs from 'node:fs';

import { parseArtifactName } from './artifact-name.ts';
import { validateCompletedArtifact, hasOpenArtifactRound, validateArtifactPublication } from './artifact-lifecycle.ts';
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
import { readArtifactRecoveryIntent } from './artifact-repair-intent.ts';
import {
  beginArtifactRecovery,
  commitArtifactRecovery,
  prepareArtifactRecoveryFinal,
  prepareArtifactRecoveryCommit,
  recoveryContextFromIntent,
  stageArtifactCandidate
} from './artifact-recovery.ts';
import type { ArtifactRecoveryContext } from './artifact-recovery.ts';

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
  recoveryId?: string;
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
  recovery?: Readonly<{
    recoveryId: string;
    candidatePath: string;
    baselineSha256: string;
    baselineSemanticDigest: string;
  }>;
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
  startRecovery?: boolean;
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

/** Validate and seal a review draft before any finding-ledger write. */
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
  let recovery: ArtifactRecoveryContext | undefined;
  let existingIntent;
  try {
    taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
    if (request.recoveryId) {
      const intent = readArtifactRecoveryIntent(resolved.repoRoot, resolved.taskId, spec.family, request.artifact);
      if (!intent || intent.recoveryOperationId !== request.recoveryId) return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', 'recovery id does not match the artifact journal', resolved.taskId);
      if (!['awaiting-preflight-recovery', 'preflight-ready'].includes(intent.state)) return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', `recovery journal is in '${intent.state}' state`, resolved.taskId);
      recovery = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, intent);
      content = fs.existsSync(recovery.stagingPath)
        ? fs.readFileSync(recovery.stagingPath, 'utf8')
        : fs.readFileSync(recovery.formalPath, 'utf8');
    } else {
      const validated = validateCompletedArtifact(resolved.taskDir, spec.family, request.artifact);
      if (!validated.ok) return preflightFailed(request, validated.error.code === 'ARTIFACT_NOT_REGULAR' ? 'REVIEW_ARTIFACT_NOT_REGULAR' : 'REVIEW_ARTIFACT_IDENTITY_INVALID', validated.error.message, resolved.taskId);
      content = fs.readFileSync(validated.artifact.path, 'utf8');
      const intent = readArtifactRecoveryIntent(resolved.repoRoot, resolved.taskId, spec.family, request.artifact);
      existingIntent = intent;
      if (intent?.state === 'preflight-ready') recovery = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, intent);
      if (intent?.state === 'consumed') return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', 'review artifact was already finalized', resolved.taskId);
    }
  } catch (error) { return preflightFailed(request, 'REVIEW_ARTIFACT_NOT_REGULAR', String(error), resolved.taskId); }

  if (!hasOpenArtifactRound(taskContent, spec.family, parsed.round)) return preflightFailed(request, 'REVIEW_ARTIFACT_IDENTITY_INVALID', `${request.artifact} does not have one matching open started review event`, resolved.taskId);
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
    if (!recovery && !request.dryRun) {
      try {
        recovery = beginArtifactRecovery({
          taskId: resolved.taskId, family: spec.family, artifact: request.artifact, round: parsed.round,
          requestId: `review-preflight:${resolved.taskId}:${stage}:${parsed.round}`
        }, Buffer.from(content, 'utf8'), { repoRoot: resolved.repoRoot, taskDir: resolved.taskDir, lockAlreadyHeld: options.lockAlreadyHeld });
      } catch (error) { return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', String(error), resolved.taskId); }
    }
    const diagnostics = [
      ...(!detail.ok ? [`${detail.code}: ${detail.message}`] : []),
      ...structure.diagnostics.map((item) => `${item.code}: ${item.message}`),
      ...(qualificationError ? [`${qualificationError.code}: ${qualificationError.message}`] : [])
    ].join('; ');
    return preflightFailed(request, !detail.ok ? 'REVIEW_DECISION_DETAIL_INVALID' : !structure.ok ? 'REVIEW_ARTIFACT_STRUCTURE_INVALID' : 'REVIEW_ARTIFACT_QUALIFICATION_INVALID', diagnostics, resolved.taskId, {
      artifactSha256, semanticDigest,
      ...(recovery ? { recovery: recoveryInfo(recovery) } : {})
    });
  }
  if (!recovery && existingIntent?.state === 'passed') {
    return {
      ...preflightFailed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, { artifactSha256, semanticDigest }),
      status: 'passed', changed: false, error: null
    };
  }
  if (request.dryRun || recovery && readArtifactRecoveryIntent(resolved.repoRoot, resolved.taskId, spec.family, request.artifact)?.state === 'preflight-ready') {
    return {
      ...preflightFailed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, { artifactSha256, semanticDigest, ...(recovery ? { recovery: recoveryInfo(recovery) } : {}) }),
      status: 'passed', changed: false, error: null
    };
  }
  try {
    recovery ??= beginArtifactRecovery({
      taskId: resolved.taskId, family: spec.family, artifact: request.artifact, round: parsed.round,
      requestId: `review-preflight:${resolved.taskId}:${stage}:${parsed.round}`
    }, Buffer.from(content, 'utf8'), { repoRoot: resolved.repoRoot, taskDir: resolved.taskDir, lockAlreadyHeld: options.lockAlreadyHeld });
    const staged = stageArtifactCandidate(recovery, Buffer.from(content, 'utf8'), { lockAlreadyHeld: options.lockAlreadyHeld });
    prepareArtifactRecoveryCommit(recovery, staged.candidateSha256, staged.semanticDigest, { lockAlreadyHeld: options.lockAlreadyHeld });
    return {
      ...preflightFailed(request, 'REVIEW_ARTIFACT_CONFLICT', '', resolved.taskId, { artifactSha256, semanticDigest, recovery: recoveryInfo(recovery) }),
      status: 'passed', changed: false, error: null
    };
  } catch (error) { return preflightFailed(request, 'REVIEW_PROVENANCE_INVALID', String(error), resolved.taskId, { artifactSha256, semanticDigest }); }
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
  recovery?: ArtifactRecoveryContext;
  lockAlreadyHeld?: boolean;
}>;

function recoveryInfo(recovery: ArtifactRecoveryContext): NonNullable<ReviewFinalizationResult['recovery']> {
  return {
    recoveryId: recovery.recoveryId,
    candidatePath: recovery.stagingPath,
    baselineSha256: recovery.baselineSha256,
    baselineSemanticDigest: recovery.baselineSemanticDigest
  };
}

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
  let recovery: ArtifactRecoveryContext | undefined;
  if (request.recoveryId) {
    try {
      const intent = readArtifactRecoveryIntent(resolved.repoRoot, taskId!, spec.family, request.artifact);
      if (!intent || intent.recoveryOperationId !== request.recoveryId) return reject('REVIEW_PROVENANCE_INVALID', 'recovery id does not match the artifact journal');
      if (!['awaiting-preflight-recovery', 'preflight-ready', 'preflight-commit-started', 'preflight-passed', 'full-finalizer-ready', 'commit-started'].includes(intent.state)) return reject('REVIEW_PROVENANCE_INVALID', `recovery journal is in '${intent.state}' state`);
      recovery = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, intent);
      artifactContent = fs.existsSync(recovery.stagingPath)
        ? fs.readFileSync(recovery.stagingPath, 'utf8')
        : fs.readFileSync(recovery.formalPath, 'utf8');
    } catch (error) { return reject('REVIEW_PROVENANCE_INVALID', String(error)); }
  }
  const artifactSha256 = sha256Content(artifactContent);
  const semanticDigest = canonicalSemanticDigest(artifactContent);
  const digests = { artifactSha256, semanticDigest };
  let repairIntent;
  try { repairIntent = readArtifactRecoveryIntent(resolved.repoRoot, taskId!, spec.family, request.artifact); }
  catch (error) { return reject('REVIEW_PROVENANCE_INVALID', String(error), digests); }
  if (repairIntent?.state === 'consumed') {
    if (repairIntent.finalArtifactSha256 !== artifactSha256 || repairIntent.finalSemanticDigest !== semanticDigest) {
      return reject('REVIEW_PROVENANCE_INVALID', 'the review artifact changed after its finalization provenance was recorded', digests);
    }
  }
  if (repairIntent?.state === 'passed'
    && (repairIntent.finalArtifactSha256 !== artifactSha256 || repairIntent.finalSemanticDigest !== semanticDigest)) {
    repairIntent = undefined;
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
  const schema = getArtifactSchema(spec.family)!;
  const structure = inspectArtifactContract(artifactContent, schema);
  if (!structure.ok) {
    if (!recovery && !request.dryRun && options.startRecovery) {
      try {
        recovery = beginArtifactRecovery({
          taskId: taskId!, family: spec.family, artifact: request.artifact, round: parsed.round,
          requestId: `review-finalize:${taskId!}:${stage}:${parsed.round}`
        }, Buffer.from(artifactContent, 'utf8'), { repoRoot: resolved.repoRoot, taskDir: resolved.taskDir, lockAlreadyHeld: options.lockAlreadyHeld });
      } catch (error) { return reject('REVIEW_PROVENANCE_INVALID', String(error), digests); }
    }
    return {
      ...reject('REVIEW_ARTIFACT_STRUCTURE_INVALID', structure.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '), {
        artifactSha256, semanticDigest: structure.semanticDigest,
        ...(recovery ? { recovery: {
          recoveryId: recovery.recoveryId,
          candidatePath: recovery.stagingPath,
          baselineSha256: recovery.baselineSha256,
          baselineSemanticDigest: recovery.baselineSemanticDigest
        } } : {})
      }),
      ...(recovery ? { recovery } : {})
    };
  }
  const transformed = finalizeReviewSummaryContent(artifactContent, stageStatus.unresolvedFindingCounts);
  if (!transformed.ok) return reject(transformed.code, transformed.message);
  const finalDigests = { artifactSha256: sha256Content(transformed.content), semanticDigest: canonicalSemanticDigest(transformed.content) };
  if (!recovery && (repairIntent?.state === 'passed' || repairIntent?.state === 'consumed')) {
    if (transformed.changed) return reject('REVIEW_PROVENANCE_INVALID', 'the review artifact requires changes after its completed recovery was consumed', finalDigests);
    return {
      content: transformed.content,
      result: {
        ...failed(request, 'REVIEW_ARTIFACT_CONFLICT', '', taskId, stageStatus, finalDigests),
        status: 'no-op',
        changed: false,
        error: null
      },
      lockAlreadyHeld: options.lockAlreadyHeld
    };
  }
  if (!recovery && !request.dryRun && options.startRecovery) {
    try {
      recovery = beginArtifactRecovery({
        taskId: taskId!, family: spec.family, artifact: request.artifact, round: parsed.round,
        requestId: `review-finalize:${taskId!}:${stage}:${parsed.round}`
      }, Buffer.from(artifactContent, 'utf8'), { repoRoot: resolved.repoRoot, taskDir: resolved.taskDir, lockAlreadyHeld: options.lockAlreadyHeld });
    } catch (error) { return reject('REVIEW_PROVENANCE_INVALID', String(error), finalDigests); }
  }
  return {
    content: transformed.content,
    result: {
      ...failed(request, 'REVIEW_ARTIFACT_CONFLICT', '', taskId, stageStatus, finalDigests),
      status: transformed.changed ? request.dryRun ? 'planned' : 'applied' : 'no-op',
      changed: transformed.changed,
      operations: transformed.changed ? [{ kind: 'artifact', artifact: request.artifact, operation: 'update' }] : [],
      error: null
    },
    ...(recovery ? { recovery } : {}),
    lockAlreadyHeld: options.lockAlreadyHeld
  };
}

function commitReviewSummaryProvenance(
  prepared: ReviewSummaryCandidatePreparation,
  repoRoot: string
): ReviewFinalizationResult {
  if (prepared.result.status === 'failed' || !prepared.recovery) return prepared.result;
  try {
    const intent = readArtifactRecoveryIntent(prepared.recovery.repoRoot, prepared.recovery.taskId, prepared.recovery.family, prepared.recovery.artifact);
    if (!intent) throw new Error('ARTIFACT_RECOVERY_INTENT_MISSING');
    let committed;
    if (intent.state === 'passed' || intent.state === 'consumed') {
      return {
        ...prepared.result,
        status: 'no-op',
        changed: false,
        artifactSha256: intent.finalArtifactSha256,
        semanticDigest: intent.finalSemanticDigest,
        error: null
      };
    }
    if (intent.state === 'awaiting-preflight-recovery') {
      const staged = stageArtifactCandidate(prepared.recovery, Buffer.from(prepared.content, 'utf8'), { lockAlreadyHeld: prepared.lockAlreadyHeld });
      prepareArtifactRecoveryCommit(prepared.recovery, staged.candidateSha256, staged.semanticDigest, { lockAlreadyHeld: prepared.lockAlreadyHeld });
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld });
    } else if (intent.state === 'preflight-ready' || intent.state === 'preflight-commit-started') {
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld });
    }
    if (committed?.state === 'preflight-passed' || intent.state === 'preflight-passed') {
      prepareArtifactRecoveryFinal(prepared.recovery, Buffer.from(prepared.content, 'utf8'), { lockAlreadyHeld: prepared.lockAlreadyHeld });
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld });
    } else if (intent.state === 'full-finalizer-ready' || intent.state === 'commit-started') {
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld });
    }
    if (!committed || committed.state !== 'passed') throw new Error(`ARTIFACT_RECOVERY_STATE_INVALID: commit ended in '${committed?.state ?? intent.state}'`);
    return {
      ...prepared.result,
      changed: true,
      artifactSha256: committed.finalArtifactSha256,
      semanticDigest: committed.finalSemanticDigest,
      error: null
    };
  } catch (error) {
    return { ...prepared.result, status: 'failed', error: {
      code: 'REVIEW_RECOVERY_COMMIT_FAILED', message: `cannot publish review candidate: ${String(error)}`
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
  return commitReviewSummaryProvenance(prepared, resolved.repoRoot);
}

function finalizeReviewSummary(
  request: ReviewFinalizationRequest,
  options: ReviewFinalizationOptions = {}
): ReviewFinalizationResult {
  const effectiveOptions = { ...options, startRecovery: !request.dryRun };
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
