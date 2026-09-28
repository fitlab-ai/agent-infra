import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveBranchWorktree } from '../git/branch-worktree.ts';

import { appendActivityEntry, locateActivityLog, pairEntries, startedBackedRows } from './activity-log.ts';
import {
  buildArtifactLinkSection,
  inspectArtifactDirectory,
  resolveArtifactContext,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import { artifactName, parseArtifactName } from './artifact-name.ts';
import type { ArtifactContextResult, ArtifactErrorCode, ArtifactFamily, ArtifactIdentity } from './artifact-lifecycle.ts';
import { ArtifactReceiptError, parseArtifactReceipts, sha256File, upsertArtifactReceipts } from './artifact-receipts.ts';
import type { ArtifactReceipt } from './artifact-receipts.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import {
  consumeImplementationInput,
  IMPLEMENTATION_INPUT_ALIASES,
  parseImplementationInputs,
  renderImplementationInputs
} from './implementation-inputs.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, summarizeLedgerStage, validateLedgerRows } from './ledger.ts';
import type { ReviewStage } from './ledger.ts';
import { parseReviewSummary, resolveCanonicalVerdict } from './review-artifacts.ts';
import { extractReviewBaseline, extractReviewedHead, extractReviewedSnapshotTree } from './review-fingerprint.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { findSectionHeading } from './sections.ts';
import { validateLifecycleExecution } from './lifecycle-execution.ts';
import { commitOrchestrationStageCompletion } from './orchestration.ts';
import type { OrchestrationStageCompletion } from './orchestration.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskOperationSummary, TaskWriteErrorCode, TaskWriteOptions } from './write.ts';
import { validateLocalArtifact } from './local-artifact-finalization.ts';
import type { LocalArtifactFamily } from './local-artifact-finalization.ts';
import { buildLifecycleFacts, canStart, effectiveReworkTarget } from './capabilities.ts';
import type { ExplicitTrigger, LifecycleAction, TriggerInitiator, TriggerReason } from './capabilities.ts';
import { createInvalidationOperation, invalidationMutation, parseInvalidationDocument, targetIdFor, upsertInvalidation } from './invalidation.ts';
import type { InvalidationTargetKind } from './invalidation.ts';
import { reconcileTaskInvalidation } from './invalidation-command.ts';
import { consumeReworkIntents, parseReworkIntentDocument, reworkIntentMutation, supersedeReworkIntents } from './rework-intent.ts';
import type { ReworkTarget } from './rework-intent.ts';
import { ARTIFACT_FAMILIES, parseQualificationAudit, parseTaskQualification } from './qualification-audit.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { canonicalSemanticDigest, inspectArtifactContract } from './artifact-operations.ts';
import { inspectReviewIdentity } from './review-identity.ts';
import { parseCompletionFacts, type CompletionFact } from './completion-facts.ts';
import {
  consumeLifecycleRecoveryAttestation,
  lifecycleRecoveryAttestationDigest,
  validateLifecycleRecoveryAttestation,
  type LifecycleRecoveryAttestationV1
} from './control-authority.ts';
import { readManualValidationCompletion } from './manual-validation-completion.ts';
import { parseLifecyclePathDecision } from './lifecycle-path.ts';

const eventCatalog = [
  'analyze.started', 'analyze.awaiting-input', 'analyze.completed',
  'review-analysis.started', 'review-analysis.completed',
  'plan.started', 'plan.completed',
  'review-plan.started', 'review-plan.completed',
  'code.started', 'code.completed',
  'review-code.started', 'review-code.completed',
  'manual-validation.started', 'manual-validation.completed',
  'validation-run.started', 'validation-run.completed'
] as const;
type TaskEventName = (typeof eventCatalog)[number];
type Verdict = 'approved' | 'changes-requested' | 'rejected';
type TaskEventErrorCode =
  | 'EVENT_UNKNOWN' | 'EVENT_PAYLOAD_INVALID' | 'EVENT_TRANSITION_INVALID'
  | 'EVENT_TRIGGER_REQUIRED'
  | 'EVENT_LOG_MISSING' | 'EVENT_START_MISSING' | 'EVENT_ALREADY_COMPLETED'
  | 'EVENT_LOG_CONFLICT' | 'EVENT_ARTIFACT_CONFLICT' | 'EVENT_FINDING_COUNT_MISMATCH'
  | 'EVENT_VERDICT_INVALID'
  | 'EVENT_ORCHESTRATION_COMMIT_FAILED'
  | 'MANUAL_VALIDATION_RECEIPT_MISSING' | 'MANUAL_VALIDATION_RECEIPT_INVALID'
  | 'MANUAL_VALIDATION_RECEIPT_IDENTITY_MISMATCH'
  | 'MANUAL_VALIDATION_TRANSACTION_MISSING' | 'MANUAL_VALIDATION_TRANSACTION_INVALID'
  | 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH' | 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID'
  | ArtifactErrorCode | TaskWriteErrorCode;
type TaskEventRequest = {
  taskRef: string; event: TaskEventName | string; agent: string; dryRun?: boolean; orchestrated?: boolean;
  initiator?: TriggerInitiator; requestId?: string; reasonCode?: TriggerReason;
  sourceFinding?: string; sourceArtifact?: string; sourceSha256?: string;
  round?: number; question?: number; artifact?: string; fixFor?: string; implementationInput?: string;
  artifactSha256?: string; semanticDigest?: string;
  verdict?: Verdict; blockers?: number; major?: number; minor?: number;
  manualValidation?: number; filesModified?: number; testsPassed?: number;
  summaryResult?: string;
  transactionId?: string; receiptDigest?: string; prHeadSha?: string;
};
type TaskEventError = { code: TaskEventErrorCode; message: string };
type TaskEventOptions = TaskWriteOptions & {
  commitOrchestrationCompletion?: (plan: OrchestrationStageCompletion) => void;
  lockAlreadyHeld?: boolean;
  lifecycleRecoveryAttestation?: LifecycleRecoveryAttestationV1 | null;
  deferLifecycleRecoveryConsumption?: boolean;
};
type TaskEventResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed'; changed: boolean;
  event: string; requestRef: string; taskId: string | null; taskMdPath: string | null;
  fromStep: string | null; toStep: string | null; action: string | null;
  phase: 'started' | 'waiting' | 'completed' | null; round: number | null;
  artifact: string | null; fixFor: string | null; implementationInput: string | null;
  artifactContext: ArtifactContextResult | null;
  timestamp: string | null; agentInfraVersion: string | null;
  operations: readonly TaskOperationSummary[]; error: TaskEventError | null;
};

function branchWorktree(repoRoot: string, branch: string): string | null {
  if (!branch) return repoRoot;
  return resolveBranchWorktree(repoRoot, branch);
}

function approvedCleanReviewedCommit(reviewContent: string, verdict: Verdict | undefined, repoRoot: string, branch: string): string | null {
  if (verdict !== 'approved') return null;
  const reviewedHead = extractReviewedHead(reviewContent) || extractReviewBaseline(reviewContent);
  const reviewedTree = extractReviewedSnapshotTree(reviewContent);
  if (!/^[a-f0-9]{40}$/.test(reviewedHead) || !/^[a-f0-9]{40}$/.test(reviewedTree)) return null;
  const worktree = branchWorktree(repoRoot, branch);
  if (!worktree) return null;
  try {
    const currentHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (currentHead !== reviewedHead) return null;
    const currentTree = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    if (currentTree !== reviewedTree) return null;
    execFileSync('git', ['-C', worktree, 'diff-index', '--quiet', 'HEAD', '--']);
    return reviewedHead;
  } catch {
    return null;
  }
}

const BASE_FIELDS = new Set(['taskRef', 'event', 'agent', 'dryRun', 'initiator', 'requestId', 'reasonCode', 'sourceFinding', 'sourceArtifact', 'sourceSha256']);
const SCHEMAS: Record<TaskEventName, { required?: string[]; optional?: string[] }> = {
  'analyze.started': { optional: ['round'] },
  'analyze.awaiting-input': { required: ['question'] },
  'analyze.completed': { required: ['artifact', 'artifactSha256', 'semanticDigest'], optional: ['round', 'orchestrated'] },
  'review-analysis.started': { optional: ['round'] },
  'review-analysis.completed': { required: ['artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'], optional: ['round', 'orchestrated'] },
  'plan.started': { optional: ['round'] },
  'plan.completed': { required: ['artifact', 'artifactSha256', 'semanticDigest'], optional: ['round', 'orchestrated'] },
  'review-plan.started': { optional: ['round'] },
  'review-plan.completed': { required: ['artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'], optional: ['round', 'orchestrated'] },
  'code.started': { optional: ['round', 'fixFor', 'implementationInput'] },
  'code.completed': { required: ['artifact', 'artifactSha256', 'semanticDigest'], optional: ['round', 'fixFor', 'implementationInput', 'filesModified', 'testsPassed', 'blockers', 'major', 'minor', 'manualValidation', 'orchestrated'] },
  'review-code.started': { optional: ['round'] },
  'review-code.completed': { required: ['artifact', 'verdict', 'blockers', 'major', 'minor', 'manualValidation'], optional: ['round', 'orchestrated'] },
  'manual-validation.started': { optional: ['round', 'transactionId'] },
  'manual-validation.completed': { required: ['artifact', 'summaryResult', 'transactionId', 'receiptDigest', 'prHeadSha'], optional: ['round'] },
  'validation-run.started': { optional: ['round'] },
  'validation-run.completed': { required: ['artifact'], optional: ['round'] }
};

function validateTaskEventRequest(request: TaskEventRequest): TaskEventError | null {
  if (!eventCatalog.includes(request.event as TaskEventName)) return { code: 'EVENT_UNKNOWN', message: `unknown task event '${request.event}'` };
  if (!request.taskRef || !request.agent) return { code: 'EVENT_PAYLOAD_INVALID', message: 'taskRef and agent are required' };
  const schema = SCHEMAS[request.event as TaskEventName];
  const required = schema.required ?? [];
  const allowed = new Set([...BASE_FIELDS, ...required, ...(schema.optional ?? [])]);
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && !allowed.has(key)) return { code: 'EVENT_PAYLOAD_INVALID', message: `${request.event} does not accept '${key}'` };
  }
  for (const key of required) if (request[key as keyof TaskEventRequest] === undefined) return { code: 'EVENT_PAYLOAD_INVALID', message: `${request.event} requires '${key}'` };
  for (const key of ['round', 'question', 'blockers', 'major', 'minor', 'manualValidation', 'filesModified', 'testsPassed'] as const) {
    const value = request[key];
    if (value !== undefined && (!Number.isInteger(value) || value < (key === 'round' || key === 'question' ? 1 : 0))) return { code: 'EVENT_PAYLOAD_INVALID', message: `'${key}' must be a ${key === 'round' || key === 'question' ? 'positive' : 'non-negative'} integer` };
  }
  if (request.verdict && !['approved', 'changes-requested', 'rejected'].includes(request.verdict)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'verdict is invalid' };
  if (request.initiator && !['human', 'model', 'orchestrator'].includes(request.initiator)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'initiator is invalid' };
  if (request.requestId !== undefined && (!request.requestId.trim() || /[\r\n]/.test(request.requestId))) return { code: 'EVENT_PAYLOAD_INVALID', message: 'requestId must be a non-empty single line' };
  if (request.reasonCode && !['user-request', 'new-requirement', 'upstream-fact-doubt', 'review-finding', 'retry', 'validation-rerun'].includes(request.reasonCode)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'reasonCode is invalid' };
  for (const [name, value] of [['sourceFinding', request.sourceFinding], ['sourceArtifact', request.sourceArtifact], ['sourceSha256', request.sourceSha256]] as const) {
    if (value !== undefined && (!value.trim() || /[\r\n]/.test(value))) return { code: 'EVENT_PAYLOAD_INVALID', message: `${name} must be a non-empty single line` };
  }
  if (request.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(request.sourceSha256)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'sourceSha256 must be a sha256 digest' };
  if (request.event === 'code.completed') {
    const fix = request.fixFor !== undefined || ['blockers', 'major', 'minor', 'manualValidation'].some((key) => request[key as keyof TaskEventRequest] !== undefined);
    const modeRequired = fix ? ['fixFor', 'blockers', 'major', 'minor', 'manualValidation'] : ['filesModified', 'testsPassed'];
    const forbidden = fix ? ['filesModified', 'testsPassed'] : ['fixFor', 'blockers', 'major', 'minor', 'manualValidation'];
    if (modeRequired.some((key) => request[key as keyof TaskEventRequest] === undefined) || forbidden.some((key) => request[key as keyof TaskEventRequest] !== undefined)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'code.completed requires either initial or fix completion payload' };
  }
  if (request.fixFor && parseArtifactName(request.fixFor)?.family !== 'review-code') return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor must reference a canonical review-code artifact' };
  if (request.implementationInput && !/^II-[1-9]\d*$/.test(request.implementationInput)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'implementationInput must be a canonical II-N id' };
  if (request.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(request.artifactSha256)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'artifactSha256 must be a 64-character hexadecimal digest' };
  if (request.semanticDigest !== undefined && !/^[0-9a-f]{64}$/i.test(request.semanticDigest)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'semanticDigest must be a 64-character hexadecimal digest' };
  if (request.fixFor && request.implementationInput) return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor and implementationInput are mutually exclusive' };
  if (request.summaryResult !== undefined && (!request.summaryResult.trim() || /[\r\n]/.test(request.summaryResult))) return { code: 'EVENT_PAYLOAD_INVALID', message: 'summaryResult must be a non-empty single line' };
  if (request.event === 'manual-validation.completed') {
    for (const [name, value, pattern] of [
      ['transactionId', request.transactionId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u],
      ['receiptDigest', request.receiptDigest, /^[a-f0-9]{64}$/u],
      ['prHeadSha', request.prHeadSha, /^[a-f0-9]{40}$/u]
    ] as const) if (!value || !pattern.test(value)) return { code: 'EVENT_PAYLOAD_INVALID', message: `manual-validation.completed requires a valid ${name}` };
  }
  if (request.event === 'manual-validation.started' && request.transactionId !== undefined
    && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.transactionId)) {
    return { code: 'EVENT_PAYLOAD_INVALID', message: 'manual-validation.started requires a valid transactionId' };
  }
  if (request.event !== 'analyze.awaiting-input' && /\.(?:started|completed)$/.test(request.event)) {
    if (!request.initiator || !request.requestId || !request.reasonCode) {
      return { code: 'EVENT_TRIGGER_REQUIRED', message: `${request.event} requires --initiator, --request-id, and --reason-code` };
    }
  }
  return null;
}

const FAMILY = {
  analyze: { artifact: 'analysis', target: 'requirement-analysis', label: 'Analyze Task' },
  'review-analysis': { artifact: 'review-analysis', target: 'requirement-analysis-review', label: 'Review Analysis' },
  plan: { artifact: 'plan', target: 'technical-design', label: 'Plan Task' },
  'review-plan': { artifact: 'review-plan', target: 'technical-design-review', label: 'Review Plan' },
  code: { artifact: 'code', target: 'code', label: 'Code Task' },
  'review-code': { artifact: 'review-code', target: 'code-review', label: 'Review Code' },
  'manual-validation': { artifact: 'manual-validation', target: null, label: 'Complete Manual Validation' },
  'validation-run': { artifact: 'validation-run', target: null, label: 'Run Manual Validation' }
} as const;
type EventFamily = keyof typeof FAMILY;

const REVIEW_LEDGER_STAGES: Partial<Record<EventFamily, ReviewStage>> = {
  'review-analysis': 'analysis',
  'review-plan': 'plan',
  'review-code': 'code'
};

function validateReviewFindingCounts(
  request: TaskEventRequest,
  content: string,
  family: EventFamily,
  artifactPath: string | null
): TaskEventError | null {
  const stage = REVIEW_LEDGER_STAGES[family];
  if (!stage || !artifactPath) return null;
  const ledger = parseLedgerDocument(content);
  if (!ledger.present) return { code: 'EVENT_FINDING_COUNT_MISMATCH', message: `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}` };
  const rows = ledger.rows;
  const invalid = validateLedgerRows(rows);
  if (invalid) return { code: 'TASK_DOCUMENT_INVALID', message: `${invalid.code}: ${invalid.message}` };
  const expected = summarizeLedgerStage(rows, stage).unresolvedFindingCounts;
  const payload = {
    blocker: request.blockers!,
    major: request.major!,
    minor: request.minor!
  };
  let reportContent: string;
  try {
    reportContent = fs.readFileSync(artifactPath, 'utf8');
  } catch (error) {
    return { code: 'EVENT_FINDING_COUNT_MISMATCH', message: String(error) };
  }
  const parsed = parseReviewSummary(reportContent);
  if (!parsed.ok || !parsed.summary.counts) {
    return {
      code: 'EVENT_FINDING_COUNT_MISMATCH',
      message: parsed.ok ? 'review summary finding counts are not finalized' : parsed.message
    };
  }
  const canonical = resolveCanonicalVerdict(parsed.summary);
  if (!canonical.ok) return { code: 'EVENT_VERDICT_INVALID', message: `${canonical.code}: ${canonical.message}` };
  const report = parsed.summary.counts;
  const reportVerdict = parsed.summary.verdict === 'Approved'
    ? 'approved'
    : parsed.summary.verdict === 'Changes Requested' ? 'changes-requested' : 'rejected';
  const fields = [
    ['blocker', 'blockers'],
    ['major', 'major'],
    ['minor', 'minor']
  ] as const;
  const differences = fields.flatMap(([severity, cliField]) => {
    const values = [
      expected[severity] === payload[severity]
        ? null
        : `${cliField} ledger ${expected[severity]}, payload ${payload[severity]}`,
      expected[severity] === report[severity]
        ? null
        : `${cliField} ledger ${expected[severity]}, report ${report[severity]}`
    ];
    return values.filter((value): value is string => value !== null);
  });
  if (request.verdict !== reportVerdict) {
    differences.push(`verdict report ${reportVerdict}, payload ${request.verdict}`);
  }
  if (differences.length === 0) return null;
  return {
    code: 'EVENT_FINDING_COUNT_MISMATCH',
    message: `review summary, payload, and ${stage} ledger do not match: ${differences.join('; ')}`
  };
}

function eventParts(event: string): { family: EventFamily; phase: 'started' | 'waiting' | 'completed' } {
  const [family, suffix] = event.split('.') as [EventFamily, string];
  return { family, phase: suffix === 'started' ? 'started' : suffix === 'awaiting-input' ? 'waiting' : 'completed' };
}

function identity(request: TaskEventRequest) {
  const { family, phase } = eventParts(request.event);
  if (phase === 'waiting') return { family, phase, action: 'Analyze Task (Brainstorming)', note: `Asked Q${request.question}, awaiting answer`, target: FAMILY.analyze.target } as const;
  const spec = FAMILY[family];
  if (family === 'manual-validation') {
    return {
      family, phase, action: spec.label,
      note: phase === 'started'
        ? `started${request.transactionId ? `; transaction=${request.transactionId}` : ''}`
        : `Manual validation passed → ${request.artifact}; ${request.summaryResult}; transaction=${request.transactionId}; receipt=${request.receiptDigest}; head=${request.prHeadSha}`,
      target: null
    } as const;
  }
  const qualifier = request.fixFor
    ? `, fix for ${request.fixFor}`
    : request.implementationInput ? `, decision ${request.implementationInput}` : '';
  const action = `${spec.label} (Round ${request.round}${qualifier})`;
  if (phase === 'started') return { family, phase, action, note: 'started', target: null } as const;
  let note = '';
  if (family === 'analyze') note = `Analysis completed → ${request.artifact}`;
  else if (family === 'plan') note = `Plan completed, awaiting human review → ${request.artifact}`;
  else if (family === 'code' && request.fixFor) note = `Fixed ${request.blockers} blockers, ${request.major} major, ${request.minor} minor issues${request.manualValidation ? `, skipped ${request.manualValidation} manual-validation` : ''} → ${request.artifact}`;
  else if (family === 'code') note = `Code implemented, ${request.filesModified} files modified, ${request.testsPassed} tests passed → ${request.artifact}`;
  else if (family === 'validation-run') note = `Validation evidence recorded → ${request.artifact}`;
  else {
    const verdict = request.verdict === 'approved' ? 'Approved' : request.verdict === 'changes-requested' ? 'Changes Requested' : 'Rejected';
    note = `Verdict: ${verdict}, blockers: ${request.blockers}, major: ${request.major}, minor: ${request.minor}, Manual-validation: ${request.manualValidation} → ${request.artifact}`;
  }
  return { family, phase, action, note, target: spec.target } as const;
}

function failed(request: TaskEventRequest, error: TaskEventError, extra: Partial<TaskEventResult> = {}): TaskEventResult {
  return {
    status: 'failed', changed: false, event: request.event, requestRef: request.taskRef,
    taskId: null, taskMdPath: null, fromStep: null, toStep: null, action: null,
    phase: null, round: request.round ?? null, artifact: request.artifact ?? null,
    fixFor: request.fixFor ?? null, implementationInput: request.implementationInput ?? null,
    artifactContext: null, timestamp: null,
    agentInfraVersion: null, operations: [], error, ...extra
  };
}

function normalizeStarted(request: TaskEventRequest, repoRoot: string): { request: TaskEventRequest; context: ArtifactContextResult } | { error: TaskEventError; context: ArtifactContextResult } {
  const family = eventParts(request.event).family;
  const context = resolveArtifactContext(request.taskRef, FAMILY[family].artifact, {
    repoRoot,
    reasonCode: request.reasonCode,
    sourceFinding: request.sourceFinding,
    sourceArtifact: request.sourceArtifact,
    sourceSha256: request.sourceSha256
  });
  if (context.status !== 'ready' || !context.next) {
    return { error: { code: context.error?.code ?? 'EVENT_ARTIFACT_CONFLICT', message: context.error?.message ?? context.codeMode?.message ?? 'artifact context is not writable' }, context };
  }
  const round = context.next.round;
  if (request.round !== undefined && request.round !== round) return { error: { code: 'EVENT_ARTIFACT_CONFLICT', message: `round ${request.round} conflicts with expected round ${round}` }, context };
  const expectedFix = family === 'code' && context.codeMode?.mode === 'fix' ? context.codeMode.reviewArtifact ?? undefined : undefined;
  const expectedImplementation = family === 'code' && context.codeMode?.mode === 'decision'
    ? context.codeMode.implementationInput ?? undefined : undefined;
  if (request.fixFor !== undefined && request.fixFor !== expectedFix) return { error: { code: 'EVENT_ARTIFACT_CONFLICT', message: `fixFor '${request.fixFor}' conflicts with artifact context` }, context };
  if (request.implementationInput !== expectedImplementation) return { error: { code: 'EVENT_ARTIFACT_CONFLICT', message: `implementationInput '${request.implementationInput ?? ''}' conflicts with artifact context` }, context };
  return { request: { ...request, round, artifact: context.next.name, fixFor: expectedFix, implementationInput: expectedImplementation }, context };
}

function validateManualValidationCompletion(
  taskDir: string,
  taskId: string,
  request: TaskEventRequest,
  artifactPath: string
): TaskEventError | null {
  const completion = readManualValidationCompletion(taskDir, {
    transactionId: request.transactionId,
    taskId,
    prHeadSha: request.prHeadSha,
    artifact: request.artifact,
    receiptDigest: request.receiptDigest
  });
  if (!completion.ok) return completion.error;
  const { receipt, transaction } = completion.value;
  if (!['receipt-committed', 'final-promotion-in-progress', 'committed'].includes(transaction.phase)) {
    return { code: 'MANUAL_VALIDATION_TRANSACTION_PHASE_INVALID', message: 'manual validation completion requires the receipt-backed transaction phase' };
  }
  if (sha256File(artifactPath) !== receipt.artifactSha256) return { code: 'MANUAL_VALIDATION_RECEIPT_INVALID', message: 'manual-validation artifact digest does not match the receipt' };
  return null;
}

function openStartedIdentity(rows: ReturnType<typeof pairEntries>, family: EventFamily) {
  const spec = FAMILY[family];
  if (family === 'manual-validation') {
    const row = rows.filter((item) => item.step === spec.label && item.started && !item.done).at(-1);
    const completed = rows.filter((item) => item.step === spec.label && item.done).length;
    return row ? { row, round: completed + 1, fixFor: undefined, implementationInput: undefined } : null;
  }
  const escaped = spec.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped} \\(Round (\\d+)(?:(?:, fix for (review-code(?:-r\\d+)?\\.md))|(?:, decision (II-[1-9]\\d*)))?\\)$`);
  const matches = rows.flatMap((row) => {
    if (!row.started || row.done) return [];
    const match = pattern.exec(row.step);
    return match ? [{ row, round: Number(match[1]), fixFor: match[2], implementationInput: match[3] }] : [];
  });
  return matches.length === 1 ? matches[0] : matches.length > 1 ? { conflict: true as const } : null;
}

function reviewInputFamily(family: EventFamily): ArtifactFamily {
  return family === 'review-analysis' ? 'analysis' : family === 'review-plan' ? 'plan' : 'code';
}

function lifecycleAction(family: EventFamily): LifecycleAction {
  return family === 'analyze' ? 'analysis' : family;
}

function eventTrigger(request: TaskEventRequest, family: EventFamily): ExplicitTrigger {
  return {
    initiator: request.initiator ?? (request.orchestrated ? 'orchestrator' : request.agent === 'human' ? 'human' : 'model'),
    requestId: request.requestId ?? `${request.taskRef}:${request.event}:${request.round ?? 1}`,
    requestedAction: lifecycleAction(family),
    reasonCode: request.reasonCode ?? (request.fixFor || request.implementationInput ? 'review-finding' : 'user-request'),
    ...(request.sourceFinding ? { sourceFinding: request.sourceFinding } : {}),
    ...(request.sourceArtifact ? { sourceArtifact: request.sourceArtifact } : {}),
    ...(request.sourceSha256 ? { sourceSha256: request.sourceSha256 } : {}),
    ...(request.implementationInput ? { implementationInput: request.implementationInput } : {}),
    explicitRequest: request.requestId !== undefined || request.reasonCode !== undefined || request.initiator !== undefined || request.orchestrated === true
  };
}

function receiptGraphHasCycle(receipts: readonly ArtifactReceipt[]): boolean {
  const edges = new Map<string, string[]>();
  for (const receipt of receipts) {
    const outputs = edges.get(receipt.input) ?? [];
    outputs.push(receipt.output);
    edges.set(receipt.input, outputs);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const output of edges.get(node) ?? []) if (visit(output)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...edges.keys()].some(visit);
}

function qualificationInvalidationSeeds(
  content: string,
  taskDir: string,
  inventory: readonly { family: string; name: string }[]
): { changed: boolean; safe: boolean; seeds: readonly string[] } {
  const task = parseTaskQualification(content);
  if (!task.ok) return { changed: true, safe: false, seeds: [] };
  const audits: Array<{ name: string; snapshotTaskDigest: string; snapshotNonConstraintDigest: string; dependencies: readonly { constraintId: string; constraintDigest: string }[]; candidates: readonly { candidateId: string; status: string; impact: string; constraintIds: readonly string[]; evidence: string }[] }> = [];
  let observedQualification = false;
  for (const artifact of inventory) {
    let artifactContent: string;
    try { artifactContent = fs.readFileSync(path.join(taskDir, artifact.name), 'utf8'); }
    catch { return { changed: true, safe: false, seeds: [] }; }
    const parsed = parseQualificationAudit(artifactContent);
    if (!parsed.ok) return { changed: true, safe: false, seeds: [] };
    if (!parsed.audit.present) continue;
    observedQualification = true;
    const snapshot = parsed.audit.snapshot;
    if (!snapshot) return { changed: true, safe: false, seeds: [] };
    audits.push({
      name: artifact.name,
      snapshotTaskDigest: snapshot.taskInputDigest,
      snapshotNonConstraintDigest: snapshot.nonConstraintInputDigest,
      dependencies: parsed.audit.constraintDependencies,
      candidates: parsed.audit.candidateQualifications
    });
  }
  if (!task.qualification.present) return { changed: false, safe: true, seeds: [] };
  const allAuditsPresent = observedQualification && audits.length === inventory.length;
  if (!allAuditsPresent) return { changed: true, safe: false, seeds: [] };
  if (audits.every((audit) => audit.snapshotTaskDigest === task.qualification.taskInputDigest)) {
    return { changed: false, safe: true, seeds: [] };
  }
  const candidateMap = new Map(task.qualification.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const currentConstraints = new Map(task.qualification.constraints.map((constraint) => [constraint.constraintId, constraint.digest]));
  const snapshotsMatch = audits.every((audit) => audit.snapshotNonConstraintDigest === task.qualification.nonConstraintInputDigest);
  const candidatesMatch = audits.every((audit) => audit.candidates.length === candidateMap.size
    && audit.candidates.every((row) => {
      const current = candidateMap.get(row.candidateId);
      return Boolean(current && row.status === current.status && row.impact === current.impact
        && row.evidence === current.evidence && row.constraintIds.join(',') === current.constraintIds.join(','));
    }));
  const changedConstraints = new Set<string>();
  let referencesValid = true;
  for (const audit of audits) {
    for (const dependency of audit.dependencies) {
      const currentDigest = currentConstraints.get(dependency.constraintId);
      if (!currentDigest) referencesValid = false;
      else if (currentDigest !== dependency.constraintDigest) changedConstraints.add(dependency.constraintId);
    }
  }
  const safe = allAuditsPresent && snapshotsMatch && candidatesMatch && referencesValid && changedConstraints.size > 0;
  if (!safe) return { changed: true, safe: false, seeds: [] };
  const seeds = new Set<string>();
  for (const audit of audits) {
    if (audit.dependencies.some((dependency) => changedConstraints.has(dependency.constraintId))) seeds.add(audit.name);
  }
  return { changed: true, safe: true, seeds: [...seeds] };
}

function invalidationMutationForCompletion(
  content: string,
  taskDir: string,
  family: EventFamily,
  artifact: ArtifactIdentity,
  timestamp: string,
  frontmatter: Record<string, unknown>
): { mutation: ReturnType<typeof invalidationMutation> | null } | { error: string } {
  if (!['analyze', 'plan', 'code'].includes(family)) return { mutation: null };
  const parsed = parseInvalidationDocument(content);
  if (!parsed.ok) return { error: parsed.message };
  const downstream: Record<'analyze' | 'plan' | 'code', readonly string[]> = {
    analyze: ['review-analysis', 'plan', 'review-plan', 'code', 'review-code'],
    plan: ['review-plan', 'code', 'review-code'],
    code: ['review-code']
  };
  const qualificationFallback = ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'];
  const sourceFamily = family as 'analyze' | 'plan' | 'code';
  const sourceArtifactFamily = sourceFamily === 'analyze' ? 'analysis' : sourceFamily;
  let receipts: readonly ArtifactReceipt[] = [];
  try {
    receipts = parseArtifactReceipts(content).rows;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const inventory = fs.readdirSync(taskDir).flatMap((name) => {
    const identity = parseArtifactName(name);
    if (!identity || !(ARTIFACT_FAMILIES as readonly string[]).includes(identity.family)) return [];
    try {
      const stat = fs.lstatSync(path.join(taskDir, name));
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      return [{ family: identity.family, name, round: identity.round, sha256: sha256File(path.join(taskDir, name)) }];
    } catch (error) {
      throw new Error(`cannot inspect invalidation artifact '${name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const nodeMap = new Map(inventory.map((node) => [`${node.family}/${node.name}`, node]));
  let graphUsable = receipts.length > 0;
  for (const receipt of receipts) {
    const output = parseArtifactName(receipt.output);
    const input = nodeMap.get(`${parseArtifactName(receipt.input)?.family}/${receipt.input}`);
    if (!output || !nodeMap.has(`${output.family}/${receipt.output}`) || !input || input.sha256 !== receipt.inputSha256) {
      graphUsable = false;
      break;
    }
  }
  if (graphUsable && receiptGraphHasCycle(receipts)) graphUsable = false;
  if (inventory.some((node) => node.family !== 'analysis' && node.name !== artifact.name
    && !receipts.some((receipt) => receipt.output === node.name))) graphUsable = false;
  const selected = new Set<string>();
  if (graphUsable) {
    const currentIdentity = parseArtifactName(artifact.name);
    const previousName = currentIdentity && currentIdentity.round > 1 ? artifactName(sourceArtifactFamily, currentIdentity.round - 1) : null;
    const previous = previousName ? inventory.find((node) => node.family === sourceArtifactFamily && node.name === previousName) : null;
    const previousFact = previousName ? completionFacts(frontmatter).find((fact) => fact.output === previousName && fact.event === `${sourceFamily === 'analyze' ? 'analysis' : sourceFamily}.completed`) : null;
    if (!previous || !previousFact || previousFact.outputSha256 !== previous.sha256) graphUsable = false;
    if (graphUsable && previous) {
      selected.add(`${previous.family}/${previous.name}`);
      let changed = true;
      while (changed) {
        changed = false;
        for (const receipt of receipts) {
          const consumer = `${parseArtifactName(receipt.output)!.family}/${receipt.output}`;
          if (selected.has(`${parseArtifactName(receipt.input)!.family}/${receipt.input}`) && !selected.has(consumer)) {
            selected.add(consumer);
            changed = true;
          }
        }
      }
      selected.delete(`${previous.family}/${previous.name}`);
    }
  }
  const qualification = qualificationInvalidationSeeds(content, taskDir, inventory);
  let qualificationChange = qualification.changed;
  if (qualificationChange && (!graphUsable || !qualification.safe)) graphUsable = false;
  if (qualificationChange && graphUsable) {
    for (const seed of qualification.seeds) selected.add(`${parseArtifactName(seed)?.family}/${seed}`);
    let changed = true;
    while (changed) {
      changed = false;
      for (const receipt of receipts) {
        const consumer = `${parseArtifactName(receipt.output)!.family}/${receipt.output}`;
        if (selected.has(`${parseArtifactName(receipt.input)!.family}/${receipt.input}`) && !selected.has(consumer)) {
          selected.add(consumer);
          changed = true;
        }
      }
    }
  }
  const reasonCode = qualificationChange ? 'qualification-changed' : 'upstream-replaced';
  const fallbackFamilies = qualificationChange ? qualificationFallback : downstream[sourceFamily];
  const targetNodes = (graphUsable
    ? inventory.filter((node) => selected.has(`${node.family}/${node.name}`))
    : inventory.filter((node) => fallbackFamilies.includes(node.family)))
    .filter((node) => !(node.family === FAMILY[family].artifact && node.name === artifact.name));
  const targets = targetNodes.flatMap((node) => {
    const shapes: Array<{ targetKind: InvalidationTargetKind; targetFamily: string; targetArtifact: string; targetRound: number; targetSha256: string }> = [
      { targetKind: 'artifact', targetFamily: node.family, targetArtifact: node.name, targetRound: node.round, targetSha256: node.sha256 }
    ];
    for (const receipt of receipts.filter((candidate) => candidate.output === node.name)) {
      shapes.push({ targetKind: 'receipt', targetFamily: node.family, targetArtifact: node.name, targetRound: node.round, targetSha256: receipt.inputSha256 });
    }
    if (node.family.startsWith('review-')) shapes.push({ targetKind: 'approval', targetFamily: node.family, targetArtifact: node.name, targetRound: node.round, targetSha256: node.sha256 });
    if (node.family === 'review-code') shapes.push({ targetKind: 'reviewed-snapshot', targetFamily: node.family, targetArtifact: node.name, targetRound: node.round, targetSha256: node.sha256 });
    return shapes.map((targetShape) => ({ ...targetShape, targetId: targetIdFor('pending', targetShape), operationId: 'pending', status: 'pending' as const, reasonCode, updatedAt: timestamp }));
  });
  if (targets.length === 0) return { mutation: null };
  const source = {
    sourceFamily: lifecycleAction(family), sourceArtifact: artifact.name,
    sourceRound: parseArtifactName(artifact.name)?.round ?? 1, sourceSha256: sha256File(artifact.path),
    createdAt: timestamp, updatedAt: timestamp
  };
  const operation = createInvalidationOperation(source);
  const normalizedTargets = targets.map((target: (typeof targets)[number]) => ({
    ...target, operationId: operation.operationId,
    targetId: targetIdFor(operation.operationId, target)
  }));
  const operationWithTotal = createInvalidationOperation(source, normalizedTargets);
  const next = upsertInvalidation(parsed.document, operationWithTotal, normalizedTargets);
  if (!next.ok) return { error: next.message };
  return { mutation: next.changed ? invalidationMutation(content, next.document) : null };
}

function reworkIntentMutationForCompletion(
  content: string,
  taskDir: string,
  family: EventFamily,
  artifact: ArtifactIdentity,
  timestamp: string
): { mutation: ReturnType<typeof reworkIntentMutation> | null } | { error: string } {
  const parsed = parseReworkIntentDocument(content);
  if (!parsed.ok) return { error: parsed.message };
  const hash = sha256File(artifact.path);
  let next = parsed.intents;
  if (family === 'analyze' || family === 'plan' || family === 'code') {
    const hashes = Object.fromEntries(fs.readdirSync(taskDir).flatMap((name) => {
      if (!/^review-(?:analysis|plan|code)(?:-r\d+)?\.md$/.test(name)) return [];
      try { return [[name, sha256File(path.join(taskDir, name))]]; }
      catch { return []; }
    }));
    const action = family === 'analyze' ? 'analysis' : family;
    let target: ReworkTarget = action;
    if (family === 'analyze') {
      const previousAnalysis = fs.readdirSync(taskDir)
        .map((name) => parseArtifactName(name))
        .filter((identity) => identity?.family === 'analysis' && identity.name !== artifact.name)
        .sort((left, right) => right!.round - left!.round || left!.name.localeCompare(right!.name))[0];
      const pathState = previousAnalysis
        ? parseLifecyclePathDecision(fs.readFileSync(path.join(taskDir, previousAnalysis.name), 'utf8'))
        : undefined;
      const pending = next.find((intent) => intent.status === 'pending');
      if (pending && effectiveReworkTarget(pending.target, pathState) === action) target = pending.target;
    }
    next = consumeReworkIntents(next, target, hashes, timestamp).intents;
  }
  if (family === 'review-analysis' || family === 'review-plan' || family === 'review-code') {
    next = supersedeReworkIntents(next, artifact.name, hash, timestamp).intents;
  }
  return { mutation: JSON.stringify(next) === JSON.stringify(parsed.intents) ? null : reworkIntentMutation(content, next) };
}

function buildCompletionReceipt(
  content: string,
  taskDir: string,
  family: EventFamily,
  artifact: ArtifactIdentity,
  completedAt: string,
  frontmatter: Record<string, unknown>,
  request: TaskEventRequest
): { ok: true; receipts: readonly ArtifactReceipt[] } | { ok: false; message: string } | null {
  if (!['analyze', 'plan', 'code'].includes(family) && !family.startsWith('review-')) return null;
  if (family === 'review-code') {
    const identity = inspectReviewIdentity(taskDir, fs.readFileSync(artifact.path, 'utf8'));
    if (identity.status !== 'matched') return { ok: false, message: `review-code identity is ${identity.status}: ${identity.message}` };
  }
  const event = family === 'analyze' ? 'analysis.completed'
    : family === 'plan' ? 'plan.completed'
      : family === 'code' ? 'code.completed'
        : `${family}.completed`;
  const existingReceipts = parseArtifactReceipts(content).rows.filter((row) => row.output === artifact.name);
  let inputs: Array<{ name: string; sha256: string }>;
  try {
    const raw = frontmatter.lifecycle_input_relations;
    if (typeof raw !== 'string') {
      const replayFact = currentCompletionFact(request, artifact);
      const recordedFact = completionFacts(frontmatter).find((fact) => sameCompletionFact(fact, replayFact));
      if (!recordedFact) {
        return { ok: false, message: 'started lifecycle input context is missing and no matching completion fact exists for replay' };
      }
      const expected = recordedFact.lifecycleInputs;
      if (!Array.isArray(expected)
        || expected.some((input) => !input || typeof input.name !== 'string' || !parseArtifactName(input.name)
          || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256))) {
        return { ok: false, message: 'matching completion fact does not record a valid lifecycle input set for replay' };
      }
      const actual = existingReceipts.map((receipt) => ({ name: receipt.input, sha256: receipt.inputSha256 }));
      if (expected.length !== actual.length || expected.some((input) => !actual.some((receipt) => receipt.name === input.name && receipt.sha256 === input.sha256))) {
        return { ok: false, message: 'existing input receipts do not match the complete input receipt set recorded at completion' };
      }
      for (const receipt of existingReceipts) {
        const identity = parseArtifactName(receipt.input);
        if (!identity) return { ok: false, message: `lifecycle input '${receipt.input}' has an invalid artifact identity` };
        const inventory = inspectArtifactDirectory(taskDir, identity.family);
        const current = inventory.status === 'ready' && inventory.latest?.name === receipt.input
          ? inventory.artifacts.find((item) => item.name === receipt.input) : null;
        if (!current || sha256File(current.path) !== receipt.inputSha256) return { ok: false, message: `lifecycle input '${receipt.input}' changed after completion` };
      }
      return { ok: true, receipts: existingReceipts };
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('started lifecycle input context is invalid');
    inputs = parsed;
  } catch (error) { return { ok: false, message: `invalid lifecycle input context: ${error instanceof Error ? error.message : String(error)}` }; }
  const receipts: ArtifactReceipt[] = [];
  for (const input of inputs) {
    if (typeof input?.name !== 'string' || typeof input?.sha256 !== 'string') return { ok: false, message: 'lifecycle input context has an invalid row' };
    const identity = parseArtifactName(input.name);
    if (!identity) return { ok: false, message: `lifecycle input '${input.name}' has an invalid artifact identity` };
    const inventory = inspectArtifactDirectory(taskDir, identity.family);
    const current = inventory.status === 'ready' && inventory.latest?.name === input.name
      ? inventory.artifacts.find((item) => item.name === input.name) : null;
    if (!current) return { ok: false, message: `lifecycle input '${input.name}' is missing, invalidated, or no longer latest` };
    try {
      const actualSha256 = sha256File(current.path);
      if (actualSha256 !== input.sha256) return { ok: false, message: `lifecycle input '${input.name}' changed after stage start` };
      const previous = parseArtifactReceipts(content).rows.find((row) => row.output === artifact.name && row.input === input.name);
      receipts.push({ event: event as ArtifactReceipt['event'], output: artifact.name, input: input.name, inputSha256: actualSha256, completedAt: previous?.completedAt ?? completedAt });
    } catch (error) { return { ok: false, message: `cannot verify lifecycle input '${input.name}': ${error instanceof Error ? error.message : String(error)}` }; }
  }
  return { ok: true, receipts };
}

type CompletionFact = Readonly<{
  event: string;
  output: string;
  outputSha256: string;
  semanticDigest: string;
  requestId: string;
  result: string;
  lifecycleInputs?: readonly Readonly<{ name: string; sha256: string }>[];
}>;

function completionFacts(frontmatter: Record<string, unknown>): CompletionFact[] {
  if (typeof frontmatter.completion_facts !== 'string') return [];
  try {
    const facts: unknown = JSON.parse(frontmatter.completion_facts);
    if (!Array.isArray(facts)) return [];
    return facts.filter((fact): fact is CompletionFact => Boolean(
      fact && typeof fact === 'object' && !Array.isArray(fact)
      && typeof (fact as CompletionFact).event === 'string'
      && typeof (fact as CompletionFact).output === 'string'
      && /^[a-f0-9]{64}$/u.test((fact as CompletionFact).outputSha256)
      && /^[a-f0-9]{64}$/u.test((fact as CompletionFact).semanticDigest)
      && typeof (fact as CompletionFact).requestId === 'string'
      && typeof (fact as CompletionFact).result === 'string'
    ));
  } catch {
    return [];
  }
}

function currentCompletionFact(
  request: TaskEventRequest,
  artifact: ArtifactIdentity,
  lifecycleInputs?: readonly Readonly<{ name: string; sha256: string }>[]
): CompletionFact {
  const content = fs.readFileSync(artifact.path, 'utf8');
  return {
    event: request.event,
    output: artifact.name,
    outputSha256: sha256File(artifact.path),
    semanticDigest: canonicalSemanticDigest(content),
    requestId: request.requestId ?? '',
    result: JSON.stringify({
      filesModified: request.filesModified,
      testsPassed: request.testsPassed,
      blockers: request.blockers,
      major: request.major,
      minor: request.minor,
      manualValidation: request.manualValidation ?? 0,
      verdict: request.verdict,
      fixFor: request.fixFor,
      implementationInput: request.implementationInput
    }),
    ...(lifecycleInputs ? { lifecycleInputs } : {})
  };
}

function sameCompletionFact(left: CompletionFact, right: CompletionFact): boolean {
  return left.event === right.event
    && left.output === right.output
    && left.outputSha256 === right.outputSha256
    && left.semanticDigest === right.semanticDigest
    && left.requestId === right.requestId
    && left.result === right.result;
}

function replaceCompletionFact(facts: readonly CompletionFact[], next: CompletionFact): CompletionFact[] {
  return [...facts.filter((fact) => !(fact.event === next.event && fact.output === next.output)), next];
}

function applyTaskEventUnlocked(request: TaskEventRequest, options: TaskEventOptions = {}): TaskEventResult {
  const invalid = validateTaskEventRequest(request);
  if (invalid) return failed(request, invalid);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(request, { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
  if (resolved.state !== 'active') return failed(request, { code: 'TASK_STATE_MISMATCH', message: `task ${resolved.taskId} is ${resolved.state}, expected active` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return failed(request, { code: 'TASK_READ_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const initialParts = eventParts(request.event);
  if (initialParts.phase === 'started' && !request.dryRun) {
    const reconciled = reconcileTaskInvalidation(request.taskRef, { repoRoot: resolved.repoRoot });
    if (reconciled.status === 'failed') {
      return failed(request, {
        code: 'EVENT_TRANSITION_INVALID',
        message: `INVALIDATION_RECONCILE_FAILED: ${reconciled.error?.code ?? 'UNKNOWN'}: ${reconciled.error?.message ?? ''}`
      }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    }
    if (reconciled.changed) {
      try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
      catch (error) { return failed(request, { code: 'TASK_READ_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
    }
  }
  let frontmatter;
  try { frontmatter = parseTypedTaskFrontmatter(content); }
  catch (error) { return failed(request, { code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const section = locateActivityLog(content);
  if (!section) return failed(request, { code: 'EVENT_LOG_MISSING', message: 'task has no unique Activity Log section' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  const rows = startedBackedRows(pairEntries(section.entries));
  let normalized = request;
  let artifactContext: ArtifactContextResult | null = null;
  if (initialParts.phase === 'started') {
    const openIdentity = openStartedIdentity(rows, initialParts.family);
    if (openIdentity && 'conflict' in openIdentity) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'artifact family has more than one open started event' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    if (openIdentity) {
      if (openIdentity.row.agent !== request.agent) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (initialParts.family === 'manual-validation' && request.transactionId !== undefined) {
        const existingTransactionId = /(?:^|;\s*)transaction=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:;|$)/u.exec(openIdentity.row.note)?.[1];
        if (existingTransactionId !== undefined && existingTransactionId !== request.transactionId) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'open manual-validation started event has a different transactionId' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      }
      if (request.round !== undefined && request.round !== openIdentity.round) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `round ${request.round} conflicts with open round ${openIdentity.round}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.fixFor !== undefined && request.fixFor !== openIdentity.fixFor) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `fixFor '${request.fixFor}' conflicts with open event` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.implementationInput !== openIdentity.implementationInput) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `implementationInput '${request.implementationInput ?? ''}' conflicts with open event` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      normalized = { ...request, round: openIdentity.round, artifact: artifactName(FAMILY[initialParts.family].artifact, openIdentity.round), fixFor: openIdentity.fixFor, implementationInput: openIdentity.implementationInput };
      return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '', identity(normalized), openIdentity.row.started, frontmatter, null);
    }
    if (rows.some((item) => item.started && !item.done)) {
      return failed(request, {
        code: 'EVENT_TRANSITION_INVALID',
        message: 'EXECUTION_BUSY: another lifecycle execution is open'
      }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    }
    const result = normalizeStarted(request, resolved.repoRoot);
    artifactContext = result.context;
    if ('error' in result) return failed(request, result.error, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, artifactContext });
    normalized = result.request;
  } else if (initialParts.phase === 'completed') {
    const identity = request.artifact ? parseArtifactName(request.artifact) : null;
    if (identity?.family === FAMILY[initialParts.family].artifact) normalized = { ...request, round: identity.round };
  }
  const eventIdentity = identity(normalized);
  const lifecycleAuthority = options.lifecycleRecoveryAttestation ?? null;
  if (lifecycleAuthority) {
    try { validateLifecycleRecoveryAttestation(lifecycleAuthority); }
    catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    }
    const expectedFamily = eventIdentity.family === 'analyze' ? 'analysis' : eventIdentity.family;
    if (eventIdentity.phase !== 'completed'
      || lifecycleAuthority.phase !== 'task-event.completed'
      || lifecycleAuthority.taskId !== resolved.taskId
      || lifecycleAuthority.family !== expectedFamily
      || lifecycleAuthority.artifact !== normalized.artifact
      || lifecycleAuthority.round !== normalized.round
      || (normalized.requestId !== undefined && lifecycleAuthority.lifecycleRequestId !== normalized.requestId)) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: 'lifecycle completion authority does not match the event tuple' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    }
  }
  const currentStep = typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '';
  const matchingRows = rows.filter((item) => item.step === eventIdentity.action);
  const manual = eventIdentity.family === 'manual-validation';
  const openRows = matchingRows.filter((item) => item.started && !item.done);
  const completedRows = matchingRows.filter((item) => item.done);
  if (!manual && openRows.length > 1) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'event identity has more than one open attempt' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
  const row = openRows.at(-1);
  let completedArtifact: ArtifactIdentity | null = null;
  let reviewContent: string | null = null;
  if (eventIdentity.phase === 'started' && row) {
    if (row.agent !== normalized.agent) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    if (manual && normalized.transactionId !== undefined) {
      const existingTransactionId = /(?:^|;\s*)transaction=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:;|$)/u.exec(row.note)?.[1];
      if (existingTransactionId !== undefined && existingTransactionId !== normalized.transactionId) {
        return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'open manual-validation started event has a different transactionId' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      }
    }
    return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, row.started, frontmatter, artifactContext);
  }
  if (eventIdentity.phase === 'completed' && !row?.started && completedRows.length === 0) return failed(normalized, { code: 'EVENT_START_MISSING', message: 'completion requires a started event or an earlier completed attempt' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  if (eventIdentity.phase === 'completed') {
    const validated = validateCompletedArtifact(resolved.taskDir, FAMILY[eventIdentity.family].artifact, normalized.artifact!, normalized.round);
    if (!validated.ok) return failed(normalized, validated.error, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    completedArtifact = validated.artifact;
    if (eventIdentity.family === 'manual-validation') {
      const validationError = validateManualValidationCompletion(
        resolved.taskDir,
        resolved.taskId,
        normalized,
        completedArtifact.path
      );
      if (validationError) return failed(normalized, validationError, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
    if (eventIdentity.family.startsWith('review-')) {
      try { reviewContent = fs.readFileSync(completedArtifact.path, 'utf8'); }
      catch (error) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot read ${completedArtifact.name}: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      const schema = getArtifactSchema(eventIdentity.family);
      const structure = schema ? inspectArtifactContract(reviewContent, schema) : null;
      if (structure && !structure.ok) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `shared artifact structure invalid: ${structure.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
    }
    if (eventIdentity.family === 'analyze' || eventIdentity.family === 'plan' || eventIdentity.family === 'code') {
      const localFamily = eventIdentity.family === 'analyze'
        ? 'analysis'
        : eventIdentity.family === 'plan' ? 'plan' : 'code';
      let artifactContent: string;
      try { artifactContent = fs.readFileSync(completedArtifact.path, 'utf8'); }
      catch (error) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot read ${completedArtifact.name}: ${String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      const local = validateLocalArtifact(artifactContent, {
        family: localFamily
      });
      if (!local.ok) {
        return failed(normalized, {
          code: 'EVENT_ARTIFACT_CONFLICT',
          message: `LOCAL_ARTIFACT_INVALID: ${local.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`
        }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      const actualSha256 = sha256File(completedArtifact.path);
      if (actualSha256 !== normalized.artifactSha256) {
        return failed(normalized, {
          code: 'EVENT_ARTIFACT_CONFLICT',
          message: `artifact SHA-256 does not match finalizer result for ${completedArtifact.name}`
        }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      if (local.semanticDigest !== normalized.semanticDigest) {
        return failed(normalized, {
          code: 'EVENT_ARTIFACT_CONFLICT',
          message: `semantic digest does not match finalizer result for ${completedArtifact.name}`
        }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
    }
  }
  if (eventIdentity.phase === 'waiting' && section.entries.some((entry) => entry.step === eventIdentity.action && entry.note === eventIdentity.note)) {
    const existing = section.entries.find((entry) => entry.step === eventIdentity.action && entry.note === eventIdentity.note)!;
    return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, existing.time, frontmatter, artifactContext);
  }
  if (eventIdentity.phase === 'started') {
    const trigger = eventTrigger(normalized, eventIdentity.family);
    const facts = buildLifecycleFacts(resolved.taskDir, content, resolved.state);
    if (!facts.ok) return failed(normalized, { code: 'EVENT_TRANSITION_INVALID', message: `${facts.code}: ${facts.message}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    const capability = canStart(lifecycleAction(eventIdentity.family), facts.facts, trigger);
    const safetyFailure = capability.reasonCode === 'TASK_NOT_ACTIVE'
      || capability.reasonCode === 'LIFECYCLE_EXECUTION_OPEN';
    if (!capability.allowed && (normalized.initiator === 'orchestrator' || safetyFailure)) {
      const code = capability.reasonCode === 'INVALIDATION_INCOMPLETE' ? 'TASK_INVALIDATION_BLOCKED' : 'EVENT_TRANSITION_INVALID';
      return failed(normalized, { code, message: `${capability.reasonCode}: ${capability.evidence.join(', ')}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
  }
  const findingCountError = validateReviewFindingCounts(
    normalized,
    content,
    eventIdentity.family,
    completedArtifact?.path ?? null
  );
  if (findingCountError) return failed(normalized, findingCountError, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  let orchestrationCompletion: OrchestrationStageCompletion | null = null;
  if (eventIdentity.phase === 'completed' && normalized.orchestrated
    && eventIdentity.family !== 'manual-validation' && eventIdentity.family !== 'validation-run') {
    const orchestrationStage = eventIdentity.family === 'analyze' ? 'analysis' : eventIdentity.family;
    const execution = validateLifecycleExecution(normalized.taskRef, {
      mode: 'orchestrated',
      identity: {
        stage: orchestrationStage,
        round: normalized.round!,
        artifact: normalized.artifact!,
        role: eventIdentity.family.startsWith('review-') ? 'reviewer' : 'executor'
      },
      agent: normalized.agent,
      dryRun: normalized.dryRun
    }, { repoRoot: options.repoRoot });
    if (!execution.ok) {
      return failed(normalized, {
        code: 'EVENT_TRANSITION_INVALID',
        message: `${execution.error?.code ?? 'ORCHESTRATION_PROVENANCE_MISMATCH'}: ${execution.error?.message ?? 'orchestration provenance validation failed'}`
      }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
    orchestrationCompletion = execution.completionPlan;
  }
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed(normalized, { code: 'METADATA_CAPTURE_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  let completionReceipts: readonly ArtifactReceipt[] = [];
  let currentFact: CompletionFact | null = null;
  let completionInvalidation: ReturnType<typeof invalidationMutation> | null = null;
  let completionRework: ReturnType<typeof reworkIntentMutation> | null = null;
  if (eventIdentity.phase === 'completed' && completedArtifact) {
    const receipt = buildCompletionReceipt(content, resolved.taskDir, eventIdentity.family, completedArtifact, metadata.timestamp, frontmatter, normalized);
    if (receipt && !receipt.ok) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: receipt.message }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
    completionReceipts = receipt?.receipts ?? [];
    try {
      currentFact = currentCompletionFact(normalized, completedArtifact, completionReceipts.map((receipt) => ({
        name: receipt.input,
        sha256: receipt.inputSha256
      })));
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot inspect current completion result: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    }
    if (parseCompletionFacts(frontmatter.completion_facts).some((fact) => sameCompletionFact(fact, currentFact!))) {
      return successNoOp(
        normalized,
        resolved.taskId,
        resolved.taskMdPath,
        currentStep,
        eventIdentity,
        completionReceipts[0]?.completedAt ?? metadata.timestamp,
        frontmatter,
        artifactContext
      );
    }
    try {
      const invalidation = invalidationMutationForCompletion(content, resolved.taskDir, eventIdentity.family, completedArtifact, metadata.timestamp, frontmatter);
      if ('error' in invalidation) return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: invalidation.error }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      completionInvalidation = invalidation.mutation;
      const rework = reworkIntentMutationForCompletion(content, resolved.taskDir, eventIdentity.family, completedArtifact, metadata.timestamp);
      if ('error' in rework) return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: rework.error }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      completionRework = rework.mutation;
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
  }
  const step = eventIdentity.phase === 'started' || eventIdentity.target === null ? currentStep : eventIdentity.target;
  const logStep = eventIdentity.phase === 'started' ? `${eventIdentity.action} [started]` : eventIdentity.action;
  const body = appendActivityEntry(section, { time: metadata.timestamp, step: logStep, agent: normalized.agent, note: eventIdentity.note });
  const frontmatterSet: Record<string, string> = { current_step: step, assigned_to: normalized.agent };
  if (currentFact) frontmatterSet.completion_facts = JSON.stringify(replaceCompletionFact(parseCompletionFacts(frontmatter.completion_facts), currentFact));
  let frontmatterRemove: string[] | undefined;
  if (eventIdentity.phase === 'started' && artifactContext && ['analyze', 'plan', 'code', 'review-analysis', 'review-plan', 'review-code'].includes(eventIdentity.family)) {
    try {
      const inputs = artifactContext.inputs.map((input) => ({ name: input.name, sha256: sha256File(input.path) }));
      frontmatterSet.lifecycle_input_relations = JSON.stringify(inputs);
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot freeze lifecycle inputs: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
  }
  if (eventIdentity.phase === 'completed' && ['analyze', 'plan', 'code', 'review-analysis', 'review-plan', 'review-code'].includes(eventIdentity.family)) {
    frontmatterRemove = ['lifecycle_input_relations'];
  }
  if (eventIdentity.phase === 'started' && eventIdentity.family === 'code') {
    const planInput = artifactContext?.inputs.find((input) => input.family === 'plan' || input.family === 'analysis');
    if (!planInput) return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: 'code.started lifecycle input context is unavailable' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    try {
      frontmatterSet.code_input_artifact = planInput.name;
      frontmatterSet.code_input_sha256 = sha256File(planInput.path);
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot hash code.started plan input: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
  } else if (eventIdentity.phase === 'completed' && eventIdentity.family === 'code') {
    frontmatterRemove = [...(frontmatterRemove ?? []), 'code_input_artifact', 'code_input_sha256'];
  } else if (eventIdentity.phase === 'started' && eventIdentity.family.startsWith('review-')) {
    const expectedFamily = reviewInputFamily(eventIdentity.family);
    const input = artifactContext?.inputs.find((candidate) => candidate.family === expectedFamily);
    if (!input && eventIdentity.family !== 'review-code') {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `review.started ${expectedFamily} input context is unavailable` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
    if (input) {
      try {
        frontmatterSet.review_input_artifact = input.name;
        frontmatterSet.review_input_sha256 = sha256File(input.path);
      } catch (error) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot hash review.started input: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
      }
    }
  } else if (eventIdentity.phase === 'completed' && eventIdentity.family.startsWith('review-')) {
    frontmatterRemove = [...(frontmatterRemove ?? []), 'review_input_artifact', 'review_input_sha256'];
  }
  if (eventIdentity.phase === 'completed' && eventIdentity.family === 'review-code' && reviewContent !== null) {
    const reviewedCommit = approvedCleanReviewedCommit(
      reviewContent,
      normalized.verdict,
      resolved.repoRoot,
      typeof frontmatter.branch === 'string' ? frontmatter.branch : ''
    );
    if (reviewedCommit) frontmatterSet.last_reviewed_commit = reviewedCommit;
    else if (normalized.verdict === 'approved') frontmatterSet.last_reviewed_commit = '';
  }
  if (eventIdentity.phase === 'started' && normalized.implementationInput) frontmatterSet.last_reviewed_commit = '';
  const mutations: Parameters<typeof writeTask>[0]['mutations'][number][] = [
    { kind: 'frontmatter', set: frontmatterSet, remove: frontmatterRemove }
  ];
  if (completedArtifact) {
    const link = buildArtifactLinkSection(content, completedArtifact);
    mutations.push({ kind: 'section', aliases: link.aliases, heading: link.heading, body: link.body });
  }
  if (completionReceipts.length > 0) {
    try {
      const receiptSection = upsertArtifactReceipts(content, completionReceipts);
      mutations.push({ kind: 'section', aliases: receiptSection.aliases, heading: receiptSection.heading, body: receiptSection.body });
    } catch (error) {
      const message = error instanceof ArtifactReceiptError ? error.message : String(error);
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
  }
  if (completionInvalidation) mutations.push(completionInvalidation);
  if (completionRework) mutations.push(completionRework);
  if (eventIdentity.phase === 'completed' && normalized.implementationInput) {
    let implementationRows;
    try {
      implementationRows = consumeImplementationInput(
        parseImplementationInputs(content).rows,
        normalized.implementationInput,
        normalized.artifact!
      );
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
    mutations.push({
      kind: 'section', aliases: IMPLEMENTATION_INPUT_ALIASES,
      heading: findSectionHeading(content, [...IMPLEMENTATION_INPUT_ALIASES]),
      body: renderImplementationInputs(implementationRows)
    });
  }
  mutations.push({ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body });
  const sourceCompletion = eventIdentity.phase === 'completed'
    && ['analyze', 'plan', 'code'].includes(eventIdentity.family);
  const result = writeTask({ taskRef: normalized.taskRef, expectedState: 'active', dryRun: normalized.dryRun, mutations }, { ...options, invalidationContext: sourceCompletion ? 'source-completion' : 'standard', metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(normalized, result.error, { taskId: result.taskId, taskMdPath: result.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, timestamp: result.timestamp, agentInfraVersion: result.agentInfraVersion, operations: result.operations, artifactContext });
  if (!normalized.dryRun && orchestrationCompletion) {
    try {
      (options.commitOrchestrationCompletion ?? commitOrchestrationStageCompletion)(orchestrationCompletion);
    } catch (error) {
      return failed(normalized, {
        code: 'EVENT_ORCHESTRATION_COMMIT_FAILED',
        message: `task.md was written but orchestration completion could not be persisted; manual recovery is required: ${error instanceof Error ? error.message : String(error)}`
      }, {
        taskId: result.taskId,
        taskMdPath: result.taskMdPath,
        fromStep: currentStep,
        toStep: step,
        action: eventIdentity.action,
        phase: eventIdentity.phase,
        timestamp: result.timestamp,
        agentInfraVersion: result.agentInfraVersion,
        operations: result.operations,
        artifactContext
      });
    }
  }
  return {
    status: result.status, changed: result.changed, event: normalized.event,
    requestRef: normalized.taskRef, taskId: result.taskId, taskMdPath: result.taskMdPath,
    fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase,
    round: normalized.round ?? null, artifact: normalized.artifact ?? null,
    fixFor: normalized.fixFor ?? null, implementationInput: normalized.implementationInput ?? null,
    artifactContext, timestamp: result.timestamp,
    agentInfraVersion: result.agentInfraVersion, operations: result.operations, error: null
  };
}

function applyTaskEvent(request: TaskEventRequest, options: TaskEventOptions = {}): TaskEventResult {
  const invalid = validateTaskEventRequest(request);
  if (invalid) return failed(request, invalid);
  const parts = eventParts(request.event);
  if (options.lockAlreadyHeld) return applyTaskEventUnlocked(request, options);
  if (request.dryRun || !['started', 'completed'].includes(parts.phase)) {
    return applyTaskEventUnlocked(request, options);
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return applyTaskEventUnlocked(request, options);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      `task-event.${request.event}`,
      () => applyTaskEventUnlocked(request, { ...options, lockAlreadyHeld: true })
    );
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    return failed(request, {
      code: 'EVENT_TRANSITION_INVALID',
      message: `${error.code}: ${error.message}`
    }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  }
}

function successNoOp(
  request: TaskEventRequest, taskId: string, taskMdPath: string, currentStep: string,
  eventIdentity: ReturnType<typeof identity>, timestamp: string,
  frontmatter: Record<string, unknown>, artifactContext: ArtifactContextResult | null
): TaskEventResult {
  return {
    ...failed(request, { code: 'EVENT_LOG_CONFLICT', message: '' }), status: 'no-op', error: null,
    taskId, taskMdPath, fromStep: currentStep, toStep: currentStep,
    action: eventIdentity.action, phase: eventIdentity.phase, timestamp,
    agentInfraVersion: typeof frontmatter.agent_infra_version === 'string' ? frontmatter.agent_infra_version : null,
    artifactContext
  };
}

export { eventCatalog, validateTaskEventRequest, applyTaskEvent };
export type { TaskEventName, TaskEventRequest, TaskEventResult, TaskEventError, TaskEventErrorCode, TaskEventOptions, Verdict };
