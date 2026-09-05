import fs from 'node:fs';
import path from 'node:path';

import { appendActivityEntry, locateActivityLog, pairEntries, startedBackedRows } from './activity-log.ts';
import {
  buildArtifactLinkSection,
  artifactName,
  inspectArtifactDirectory,
  parseReviewedInputReference,
  parseCodePlanInputReference,
  parseArtifactName,
  resolveArtifactContext,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import type { ArtifactContextResult, ArtifactErrorCode, ArtifactFamily, ArtifactIdentity } from './artifact-lifecycle.ts';
import { ArtifactReceiptError, parseArtifactReceipts, sha256File, upsertArtifactReceipt } from './artifact-receipts.ts';
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
import { resolveTaskRef } from './resolve-ref.ts';
import { findSectionHeading } from './sections.ts';
import { validateLifecycleExecution } from './lifecycle-execution.ts';
import { commitOrchestrationStageCompletion } from './orchestration.ts';
import type { OrchestrationStageCompletion } from './orchestration.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskOperationSummary, TaskWriteErrorCode, TaskWriteOptions } from './write.ts';
import { allowsManualOverride } from './guard-override.ts';
import {
  LOCAL_ARTIFACT_REQUIRED_PATTERNS,
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  consumeLocalArtifactFinalizationIntent,
  readLocalArtifactFinalizationIntent,
  validateLocalArtifact
} from './local-artifact-finalization.ts';
import type { LocalArtifactFamily, LocalArtifactFinalizationIntent } from './local-artifact-finalization.ts';
import { loadVerificationConfig } from './verification-config.ts';
import { buildLifecycleFacts, canStart } from './capabilities.ts';
import type { ExplicitTrigger, LifecycleAction, TriggerInitiator, TriggerReason } from './capabilities.ts';
import { createInvalidationOperation, invalidationMutation, parseInvalidationDocument, targetIdFor, upsertInvalidation } from './invalidation.ts';
import type { InvalidationTargetKind } from './invalidation.ts';
import { consumeReworkIntents, parseReworkIntentDocument, reworkIntentMutation, supersedeReworkIntents } from './rework-intent.ts';
import { ARTIFACT_FAMILIES, expectedQualificationRelations, parseQualificationAudit, parseTaskQualification, upstreamArtifactDigest, validateQualificationAudit } from './qualification-audit.ts';
import type { QualificationAudit, UpstreamRelation } from './qualification-audit.ts';

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
  | ArtifactErrorCode | TaskWriteErrorCode;
type TaskEventRequest = {
  taskRef: string; event: TaskEventName | string; agent: string; dryRun?: boolean; orchestrated?: boolean;
  overrideTicket?: string; overrideTarget?: string; overrideScope?: string;
  initiator?: TriggerInitiator; requestId?: string; reasonCode?: TriggerReason;
  sourceFinding?: string; sourceArtifact?: string; sourceSha256?: string;
  round?: number; question?: number; artifact?: string; fixFor?: string; implementationInput?: string;
  artifactSha256?: string; semanticDigest?: string;
  verdict?: Verdict; blockers?: number; major?: number; minor?: number;
  manualValidation?: number; filesModified?: number; testsPassed?: number;
  summaryResult?: string;
};
type TaskEventError = { code: TaskEventErrorCode; message: string };
type TaskEventOptions = TaskWriteOptions & {
  commitOrchestrationCompletion?: (plan: OrchestrationStageCompletion) => void;
  lockAlreadyHeld?: boolean;
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

const BASE_FIELDS = new Set(['taskRef', 'event', 'agent', 'dryRun', 'overrideTicket', 'overrideTarget', 'overrideScope', 'initiator', 'requestId', 'reasonCode', 'sourceFinding', 'sourceArtifact', 'sourceSha256']);
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
  'manual-validation.started': { optional: ['round'] },
  'manual-validation.completed': { required: ['artifact', 'summaryResult'], optional: ['round'] },
  'validation-run.started': { optional: ['round'] },
  'validation-run.completed': { required: ['artifact'], optional: ['round'] }
};

function localArtifactValidationConfig(repoRoot: string, family: LocalArtifactFamily) {
  const fallback = {
    requiredSections: LOCAL_ARTIFACT_REQUIRED_SECTIONS[family],
    requiredPatterns: LOCAL_ARTIFACT_REQUIRED_PATTERNS
  };
  const skillName = family === 'analysis' ? 'analyze-task' : family === 'plan' ? 'plan-task' : 'code-task';
  try {
    const artifact = loadVerificationConfig(repoRoot, skillName).checks.artifact;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return fallback;
    const sections = artifact.required_sections;
    const patterns = artifact.required_patterns;
    return {
      requiredSections: Array.isArray(sections)
        ? sections.filter((value): value is string => typeof value === 'string')
        : fallback.requiredSections,
      requiredPatterns: Array.isArray(patterns)
        ? patterns.filter((value): value is string => typeof value === 'string')
        : fallback.requiredPatterns
    };
  } catch {
    return fallback;
  }
}

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
  if (request.fixFor && !/^review-code(?:-r(?:[2-9]|[1-9]\d+))?\.md$/.test(request.fixFor)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor must reference a canonical review-code artifact' };
  if (request.implementationInput && !/^II-[1-9]\d*$/.test(request.implementationInput)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'implementationInput must be a canonical II-N id' };
  if (request.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(request.artifactSha256)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'artifactSha256 must be a 64-character hexadecimal digest' };
  if (request.semanticDigest !== undefined && !/^[0-9a-f]{64}$/i.test(request.semanticDigest)) return { code: 'EVENT_PAYLOAD_INVALID', message: 'semanticDigest must be a 64-character hexadecimal digest' };
  if (request.fixFor && request.implementationInput) return { code: 'EVENT_PAYLOAD_INVALID', message: 'fixFor and implementationInput are mutually exclusive' };
  if (request.summaryResult !== undefined && (!request.summaryResult.trim() || /[\r\n]/.test(request.summaryResult))) return { code: 'EVENT_PAYLOAD_INVALID', message: 'summaryResult must be a non-empty single line' };
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
      note: phase === 'started' ? 'started' : `Manual validation passed → ${request.artifact}; ${request.summaryResult}`,
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
  const context = resolveArtifactContext(request.taskRef, FAMILY[family].artifact, { repoRoot });
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

function relationForStartedInput(family: EventFamily, input: ArtifactIdentity): UpstreamRelation['relation'] {
  if (family.startsWith('review-')) {
    return input.family === reviewInputFamily(family) ? 'reviewed-input' : 'approval-context';
  }
  const consumer = family === 'analyze' ? 'analysis' : family;
  if ((consumer === 'plan' && input.family === 'analysis') || (consumer === 'code' && input.family === 'plan')) return 'required-input';
  return 'review-context';
}

function qualificationRelationsForStarted(family: EventFamily, inputs: readonly ArtifactIdentity[]): UpstreamRelation[] {
  return inputs.map((input) => ({
    upstreamFamily: input.family as UpstreamRelation['upstreamFamily'],
    upstreamArtifact: input.name,
    upstreamRound: input.round,
    upstreamSha256: sha256File(input.path),
    relation: relationForStartedInput(family, input)
  }));
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

function invalidationMutationForCompletion(
  content: string,
  taskDir: string,
  family: EventFamily,
  artifact: ArtifactIdentity,
  timestamp: string
): { mutation: ReturnType<typeof invalidationMutation> | null } | { error: string } {
  if (!['analyze', 'plan', 'code'].includes(family)) return { mutation: null };
  const parsed = parseInvalidationDocument(content);
  if (!parsed.ok) return { error: parsed.message };
  const downstream: Record<'analyze' | 'plan' | 'code', readonly string[]> = {
    analyze: ['review-analysis', 'plan', 'review-plan', 'code', 'review-code'],
    plan: ['review-plan', 'code', 'review-code'],
    code: ['review-code']
  };
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
  const taskQualification = parseTaskQualification(content);
  if (!taskQualification.ok) return { error: taskQualification.message };
  const nodeMap = new Map(inventory.map((node) => [`${node.family}/${node.name}`, node]));
  const audits = new Map<string, QualificationAudit>();
  let taskInputChanged = false;
  let graphUsable = taskQualification.qualification.present;
  if (graphUsable) {
    for (const node of inventory) {
      const artifactContent = fs.readFileSync(path.join(taskDir, node.name), 'utf8');
      const parsedAudit = parseQualificationAudit(artifactContent);
      if (!parsedAudit.ok || !parsedAudit.audit.present || !parsedAudit.audit.snapshot) { graphUsable = false; break; }
      audits.set(`${node.family}/${node.name}`, parsedAudit.audit);
      if (parsedAudit.audit.snapshot.taskInputDigest !== taskQualification.qualification.taskInputDigest) taskInputChanged = true;
      if (parsedAudit.audit.snapshot.nonConstraintInputDigest !== taskQualification.qualification.nonConstraintInputDigest) {
        graphUsable = false;
        break;
      }
      if (parsedAudit.audit.snapshot.upstreamArtifactDigest !== upstreamArtifactDigest(parsedAudit.audit.upstreamRelations)) {
        graphUsable = false;
        break;
      }
      for (const relation of parsedAudit.audit.upstreamRelations) {
        const upstream = nodeMap.get(`${relation.upstreamFamily}/${relation.upstreamArtifact}`);
        if (!upstream || upstream.round !== relation.upstreamRound || upstream.sha256 !== relation.upstreamSha256) { graphUsable = false; break; }
      }
      if (!graphUsable) break;
    }
  }
  const selected = new Set<string>();
  if (graphUsable) {
    const changedConstraints = new Set<string>();
    for (const audit of audits.values()) {
      for (const dependency of audit.constraintDependencies) {
        const current = taskQualification.qualification.constraints.find((row) => row.constraintId === dependency.constraintId);
        if (!current || current.digest !== dependency.constraintDigest) changedConstraints.add(dependency.constraintId);
      }
    }
    const currentCandidates = new Map(taskQualification.qualification.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const candidateSnapshotMatches = [...audits.values()].every((audit) => audit.candidateQualifications.length === currentCandidates.size && audit.candidateQualifications.every((row) => {
      const current = currentCandidates.get(row.candidateId);
      return Boolean(current && current.status === row.status && current.impact === row.impact
        && current.evidence === row.evidence && current.constraintIds.join(',') === row.constraintIds.join(','));
    }));
    // A task-input digest also covers candidates. A narrowed invalidation graph
    // is safe only when the old audit rows show that the candidate projection
    // stayed unchanged and the change is explained by at least one constraint.
    if (taskInputChanged && (changedConstraints.size === 0 || !candidateSnapshotMatches)) graphUsable = false;
    for (const node of inventory) {
      const audit = audits.get(`${node.family}/${node.name}`)!;
      if (audit.constraintDependencies.some((dependency) => changedConstraints.has(dependency.constraintId))) selected.add(`${node.family}/${node.name}`);
      if (audit.upstreamRelations.some((relation) => relation.upstreamFamily === sourceArtifactFamily)) selected.add(`${node.family}/${node.name}`);
    }
    // Relation rows point from a consumer to its actual upstream artifact. Walk
    // that reverse edge so review-only seeds and multi-hop consumers receive the
    // same derived targets as ordinary executor seeds.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of inventory) {
        const key = `${node.family}/${node.name}`;
        const audit = audits.get(key)!;
        if (audit.upstreamRelations.some((relation) => selected.has(`${relation.upstreamFamily}/${relation.upstreamArtifact}`)) && !selected.has(key)) {
          selected.add(key);
          changed = true;
        }
      }
    }
    // A relation cycle cannot establish a safe downstream closure.
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      const cycle = audits.get(key)?.upstreamRelations.some((relation) => hasCycle(`${relation.upstreamFamily}/${relation.upstreamArtifact}`)) ?? false;
      visiting.delete(key); visited.add(key);
      return cycle;
    };
    if ([...nodeMap.keys()].some(hasCycle)) graphUsable = false;
  }
  const reasonCode = graphUsable ? 'qualification-changed' : 'upstream-replaced';
  const targetNodes = (graphUsable
    ? inventory.filter((node) => selected.has(`${node.family}/${node.name}`))
    : inventory.filter((node) => downstream[sourceFamily].includes(node.family)))
    .filter((node) => !(node.family === FAMILY[family].artifact && node.name === artifact.name));
  const targets = targetNodes.flatMap((node) => {
    const shapes: Array<{ targetKind: InvalidationTargetKind; targetFamily: string; targetArtifact: string; targetRound: number; targetSha256: string }> = [
      { targetKind: 'artifact', targetFamily: node.family, targetArtifact: node.name, targetRound: node.round, targetSha256: node.sha256 }
    ];
    const receipt = receipts.find((candidate) => candidate.output === node.name);
    if (receipt) shapes.push({ targetKind: 'receipt', targetFamily: node.family, targetArtifact: node.name, targetRound: node.round, targetSha256: receipt.inputSha256 });
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
    next = consumeReworkIntents(next, family === 'analyze' ? 'analysis' : family, hashes, timestamp).intents;
  }
  if (family === 'review-analysis' || family === 'review-plan' || family === 'review-code') {
    next = supersedeReworkIntents(next, artifact.name, hash, timestamp).intents;
  }
  return { mutation: JSON.stringify(next) === JSON.stringify(parsed.intents) ? null : reworkIntentMutation(content, next) };
}

function buildCompletionReceipt(
  taskDir: string,
  family: EventFamily,
  artifact: ArtifactIdentity,
  completedAt: string,
  frontmatter: Record<string, unknown>
): { ok: true; receipt: ArtifactReceipt } | { ok: false; message: string } | null {
  if (family === 'code') {
    let content: string;
    try { content = fs.readFileSync(artifact.path, 'utf8'); }
    catch (error) { return { ok: false, message: `cannot read ${artifact.name}: ${String(error)}` }; }
    const input = parseCodePlanInputReference(content);
    if (!input) return { ok: false, message: `${artifact.name} does not reference a canonical plan artifact` };
    const startedInput = typeof frontmatter.code_input_artifact === 'string' ? frontmatter.code_input_artifact : '';
    const startedSha256 = typeof frontmatter.code_input_sha256 === 'string' ? frontmatter.code_input_sha256 : '';
    if (!startedInput || !startedSha256) return { ok: false, message: 'code.started plan input context is missing' };
    if (input.name !== startedInput) return { ok: false, message: `${artifact.name} plan input '${input.name}' does not match code.started input '${startedInput}'` };
    const plan = inspectArtifactDirectory(taskDir, 'plan');
    if (plan.status !== 'ready' || !plan.latest || plan.latest.name !== input.name) {
      return { ok: false, message: `code input '${input.name}' is not the latest plan artifact` };
    }
    try {
      const inputSha256 = sha256File(plan.latest.path);
      if (inputSha256 !== startedSha256) return { ok: false, message: `code input ${input.name} changed after code.started` };
      return {
        ok: true,
        receipt: {
          event: 'code.completed', output: artifact.name, input: input.name,
          inputSha256, completedAt
        }
      };
    } catch (error) {
      return { ok: false, message: `cannot hash code input plan: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!family.startsWith('review-')) return null;
  const expectedFamily = reviewInputFamily(family);
  let content: string;
  try { content = fs.readFileSync(artifact.path, 'utf8'); }
  catch (error) { return { ok: false, message: `cannot read ${artifact.name}: ${String(error)}` }; }
  const input = parseReviewedInputReference(content, expectedFamily);
  if (!input) return { ok: false, message: `${artifact.name} does not reference a canonical ${expectedFamily} artifact` };
  const startedInput = typeof frontmatter.review_input_artifact === 'string' ? frontmatter.review_input_artifact : '';
  const startedSha256 = typeof frontmatter.review_input_sha256 === 'string' ? frontmatter.review_input_sha256 : '';
  if (!startedInput || !startedSha256) return { ok: false, message: 'review started input context is missing' };
  if (input.name !== startedInput) return { ok: false, message: `${artifact.name} input '${input.name}' does not match review.started input '${startedInput}'` };
  const current = inspectArtifactDirectory(taskDir, expectedFamily);
  if (current.status !== 'ready' || !current.latest || current.latest.name !== input.name) {
    return { ok: false, message: `review input '${input.name}' is not the latest ${expectedFamily} artifact` };
  }
  const event = family === 'review-analysis'
    ? 'review-analysis.completed' as const
    : family === 'review-plan' ? 'review-plan.completed' as const : 'review-code.completed' as const;
  try {
    const stat = fs.lstatSync(current.latest.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('review input is not a regular file');
    const inputSha256 = sha256File(current.latest.path);
    if (inputSha256 !== startedSha256) return { ok: false, message: `review input ${input.name} changed after review.started` };
    return {
      ok: true,
      receipt: {
        event, output: artifact.name, input: input.name,
        inputSha256, completedAt
      }
    };
  } catch (error) {
    return { ok: false, message: `cannot hash review input ${input.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function applyTaskEventUnlocked(request: TaskEventRequest, options: TaskEventOptions = {}): TaskEventResult {
  const invalid = validateTaskEventRequest(request);
  if (invalid) return failed(request, invalid);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(request, { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
  const stateOverride = allowsManualOverride(options.manualOverride, 'task-event', 'TASK_STATE_MISMATCH');
  if (resolved.state !== 'active' && !stateOverride) return failed(request, { code: 'TASK_STATE_MISMATCH', message: `task ${resolved.taskId} is ${resolved.state}, expected active` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return failed(request, { code: 'TASK_READ_FAILED', message: String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  let frontmatter;
  try { frontmatter = parseTypedTaskFrontmatter(content); }
  catch (error) { return failed(request, { code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath }); }
  const section = locateActivityLog(content);
  if (!section) return failed(request, { code: 'EVENT_LOG_MISSING', message: 'task has no unique Activity Log section' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  const rows = startedBackedRows(pairEntries(section.entries));
  let normalized = request;
  let artifactContext: ArtifactContextResult | null = null;
  const initialParts = eventParts(request.event);
  if (initialParts.phase === 'started') {
    const openIdentity = openStartedIdentity(rows, initialParts.family);
    if (openIdentity && 'conflict' in openIdentity) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'artifact family has more than one open started event' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    if (openIdentity) {
      if (openIdentity.row.agent !== request.agent) return failed(request, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.round !== undefined && request.round !== openIdentity.round) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `round ${request.round} conflicts with open round ${openIdentity.round}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.fixFor !== undefined && request.fixFor !== openIdentity.fixFor) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `fixFor '${request.fixFor}' conflicts with open event` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      if (request.implementationInput !== openIdentity.implementationInput) return failed(request, { code: 'EVENT_ARTIFACT_CONFLICT', message: `implementationInput '${request.implementationInput ?? ''}' conflicts with open event` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
      normalized = { ...request, round: openIdentity.round, artifact: artifactName(FAMILY[initialParts.family].artifact, openIdentity.round), fixFor: openIdentity.fixFor, implementationInput: openIdentity.implementationInput };
      return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '', identity(normalized), openIdentity.row.started, frontmatter, null);
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
  const currentStep = typeof frontmatter.current_step === 'string' ? frontmatter.current_step : '';
  const matchingRows = rows.filter((item) => item.step === eventIdentity.action);
  const manual = eventIdentity.family === 'manual-validation';
  if (!manual && matchingRows.length > 1) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'event identity appears more than once' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
  const openRows = matchingRows.filter((item) => item.started && !item.done);
  const completedRows = matchingRows.filter((item) => item.done);
  const row = manual ? openRows.at(-1) : matchingRows[0];
  let completedArtifact: ArtifactIdentity | null = null;
  let localFinalizationIntent: LocalArtifactFinalizationIntent | null = null;
  if (eventIdentity.phase === 'started' && row) {
    if (row.agent !== normalized.agent) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'open started event has a different agent' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
    return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, row.started, frontmatter, artifactContext);
  }
  if (eventIdentity.phase === 'started' && !manual && completedRows.length > 0) return failed(normalized, { code: 'EVENT_ALREADY_COMPLETED', message: 'event identity is already completed' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath });
  const done = completedRows.find((item) => item.note === eventIdentity.note);
  if (eventIdentity.phase === 'completed' && done) return successNoOp(normalized, resolved.taskId, resolved.taskMdPath, currentStep, eventIdentity, done.done, frontmatter, artifactContext);
  if (eventIdentity.phase === 'completed' && completedRows.length > 0 && openRows.length === 0) return failed(normalized, { code: 'EVENT_LOG_CONFLICT', message: 'event identity is already completed with a different payload' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  if (eventIdentity.phase === 'completed' && !row?.started && !allowsManualOverride(options.manualOverride, 'task-event', 'EVENT_START_MISSING')) return failed(normalized, { code: 'EVENT_START_MISSING', message: 'completion requires one open matching started event' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
  if (eventIdentity.phase === 'completed') {
    const validated = validateCompletedArtifact(resolved.taskDir, FAMILY[eventIdentity.family].artifact, normalized.artifact!, normalized.round);
    if (!validated.ok) return failed(normalized, validated.error, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    completedArtifact = validated.artifact;
    if (eventIdentity.family.startsWith('review-')) {
      let reviewContent: string;
      try { reviewContent = fs.readFileSync(completedArtifact.path, 'utf8'); }
      catch (error) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot read qualification audit from ${completedArtifact.name}: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      const expected = expectedQualificationRelations(content, eventIdentity.family as 'review-analysis' | 'review-plan' | 'review-code');
      if (!expected.ok) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `${expected.code}: ${expected.message}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      const qualification = validateQualificationAudit(content, reviewContent, {
        family: eventIdentity.family as 'review-analysis' | 'review-plan' | 'review-code',
        artifact: completedArtifact.name,
        expectedUpstreamRelations: expected.relations
      });
      if (!qualification.ok) {
        return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `${qualification.code}: ${qualification.message}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
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
      const validationConfig = localArtifactValidationConfig(resolved.repoRoot, localFamily);
      const local = validateLocalArtifact(artifactContent, {
        family: localFamily,
        requiredSections: validationConfig.requiredSections,
        requiredPatterns: validationConfig.requiredPatterns,
        taskContent: content,
        artifact: completedArtifact.name
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
      try {
        localFinalizationIntent = readLocalArtifactFinalizationIntent(
          resolved.repoRoot, resolved.taskId, localFamily, completedArtifact.name
        );
      } catch (error) {
        return failed(normalized, {
          code: 'EVENT_ARTIFACT_CONFLICT',
          message: `cannot read local finalizer provenance for ${completedArtifact.name}: ${error instanceof Error ? error.message : String(error)}`
        }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      if (!localFinalizationIntent || !['passed', 'consumed'].includes(localFinalizationIntent.state)) {
        return failed(normalized, {
          code: 'EVENT_ARTIFACT_CONFLICT',
          message: `local finalizer provenance is missing or incomplete for ${completedArtifact.name}`
        }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
      }
      if (localFinalizationIntent.artifactSha256 !== actualSha256 || localFinalizationIntent.semanticDigest !== local.semanticDigest) {
        return failed(normalized, {
          code: 'EVENT_ARTIFACT_CONFLICT',
          message: `local finalizer provenance does not match ${completedArtifact.name}`
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
    const capabilityOverride = capability.reasonCode === 'TASK_NOT_ACTIVE'
      ? stateOverride
      : allowsManualOverride(options.manualOverride, 'task-event', 'EVENT_TRANSITION_INVALID');
    if (!capability.allowed && !capabilityOverride) {
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
  if (eventIdentity.phase === 'completed' && eventIdentity.family !== 'manual-validation' && eventIdentity.family !== 'validation-run') {
    const orchestrationStage = eventIdentity.family === 'analyze' ? 'analysis' : eventIdentity.family;
    const execution = validateLifecycleExecution(normalized.taskRef, {
      mode: normalized.orchestrated ? 'orchestrated' : 'standalone',
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
  let completionReceipt: ArtifactReceipt | null = null;
  let completionInvalidation: ReturnType<typeof invalidationMutation> | null = null;
  let completionRework: ReturnType<typeof reworkIntentMutation> | null = null;
  if (eventIdentity.phase === 'completed' && completedArtifact) {
    const receipt = buildCompletionReceipt(resolved.taskDir, eventIdentity.family, completedArtifact, metadata.timestamp, frontmatter);
    if (receipt && !receipt.ok) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: receipt.message }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: currentStep, action: eventIdentity.action, phase: eventIdentity.phase });
    }
    completionReceipt = receipt?.receipt ?? null;
    try {
      const invalidation = invalidationMutationForCompletion(content, resolved.taskDir, eventIdentity.family, completedArtifact, metadata.timestamp);
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
  let frontmatterRemove: string[] | undefined;
  if (eventIdentity.phase === 'started' && artifactContext) {
    try {
      frontmatterSet.qualification_input_relations = JSON.stringify(qualificationRelationsForStarted(eventIdentity.family, artifactContext.inputs));
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot capture qualification input relations: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
  }
  if (eventIdentity.phase === 'started' && eventIdentity.family === 'code') {
    const planInput = artifactContext?.inputs.find((input) => input.family === 'plan');
    if (!planInput) return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: 'code.started plan input context is unavailable' }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    try {
      frontmatterSet.code_input_artifact = planInput.name;
      frontmatterSet.code_input_sha256 = sha256File(planInput.path);
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot hash code.started plan input: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
  } else if (eventIdentity.phase === 'completed' && eventIdentity.family === 'code') {
    frontmatterRemove = ['code_input_artifact', 'code_input_sha256'];
  } else if (eventIdentity.phase === 'started' && eventIdentity.family.startsWith('review-')) {
    const expectedFamily = reviewInputFamily(eventIdentity.family);
    const input = artifactContext?.inputs.find((candidate) => candidate.family === expectedFamily);
    if (!input) return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `review.started ${expectedFamily} input context is unavailable` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    try {
      frontmatterSet.review_input_artifact = input.name;
      frontmatterSet.review_input_sha256 = sha256File(input.path);
    } catch (error) {
      return failed(normalized, { code: 'EVENT_ARTIFACT_CONFLICT', message: `cannot hash review.started input: ${error instanceof Error ? error.message : String(error)}` }, { taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, fromStep: currentStep, toStep: step, action: eventIdentity.action, phase: eventIdentity.phase, artifactContext });
    }
  } else if (eventIdentity.phase === 'completed' && eventIdentity.family.startsWith('review-')) {
    frontmatterRemove = ['review_input_artifact', 'review_input_sha256'];
  }
  if (eventIdentity.phase === 'completed') frontmatterRemove = [...(frontmatterRemove ?? []), 'qualification_input_relations'];
  if (eventIdentity.phase === 'started' && normalized.implementationInput) frontmatterSet.last_reviewed_commit = '';
  const mutations: Parameters<typeof writeTask>[0]['mutations'][number][] = [
    { kind: 'frontmatter', set: frontmatterSet, remove: frontmatterRemove }
  ];
  if (completedArtifact) {
    const link = buildArtifactLinkSection(content, completedArtifact);
    mutations.push({ kind: 'section', aliases: link.aliases, heading: link.heading, body: link.body });
  }
  if (completionReceipt) {
    try {
      const receiptSection = upsertArtifactReceipt(content, completionReceipt);
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
  if (!normalized.dryRun && localFinalizationIntent && completedArtifact && localFinalizationIntent.state === 'passed') {
    try {
      localFinalizationIntent = consumeLocalArtifactFinalizationIntent(resolved.repoRoot, localFinalizationIntent);
    } catch (error) {
      return failed(normalized, {
        code: 'EVENT_ARTIFACT_CONFLICT',
        message: `local finalizer provenance could not be consumed before task write for ${completedArtifact.name}: ${error instanceof Error ? error.message : String(error)}`
      }, {
        taskId: resolved.taskId,
        taskMdPath: resolved.taskMdPath,
        fromStep: currentStep,
        toStep: step,
        action: eventIdentity.action,
        phase: eventIdentity.phase,
        artifactContext
      });
    }
  }
  const sourceCompletion = eventIdentity.phase === 'completed'
    && ['analyze', 'plan', 'code'].includes(eventIdentity.family);
  const result = writeTask({ taskRef: normalized.taskRef, expectedState: stateOverride ? resolved.state : 'active', dryRun: normalized.dryRun, mutations }, { ...options, invalidationContext: sourceCompletion ? 'source-completion' : 'standard', metadataProvider: () => metadata });
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
  if (request.dryRun || parts.phase !== 'completed' || parts.family === 'manual-validation') {
    return applyTaskEventUnlocked(request, options);
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return applyTaskEventUnlocked(request, options);
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      `task-event.${request.event}`,
      () => applyTaskEventUnlocked(request, options)
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
