import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { activityWarnings, appendActivityEntry, locateActivityLog } from './activity-log.ts';
import { CONFIRMATION_COLUMNS, CONFIRMATION_HEADINGS, constraintDigest, parseQualificationConfirmations, parseTaskQualification } from './qualification-audit.ts';
import type { QualificationConfirmation } from './qualification-audit.ts';
import { findSectionHeading } from './sections.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskOperationSummary, TaskWriteOptions } from './write.ts';

type QualificationConfirmationRequest = {
  taskRef: string;
  constraintId: string;
  expectedDigest: string;
  rationale: string;
  operation?: 'confirm' | 'supersede' | 'revoke';
  dryRun?: boolean;
};
type QualificationConfirmationResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  taskId: string | null;
  qcrId: string | null;
  requestId: string | null;
  operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
  warnings?: readonly { code: string; message: string }[];
};

function failed(code: string, message: string, taskId: string | null = null): QualificationConfirmationResult {
  return { status: 'failed', changed: false, taskId, qcrId: null, requestId: null, operations: [], error: { code, message } };
}

function nextQcrId(content: string): string {
  let max = 0;
  for (const match of content.matchAll(/^\|\s*(QCR-(\d+))\s*\|/gm)) max = Math.max(max, Number(match[2]));
  return `QCR-${max + 1}`;
}

function requestIdFor(taskId: string, constraintId: string, expectedDigest: string, rationale: string, timestamp: string): string {
  const hash = createHash('sha256').update(JSON.stringify([taskId, constraintId, expectedDigest, rationale, timestamp])).digest('hex');
  return `QCR-REQUEST-${hash.slice(0, 20)}`;
}

function renderConfirmations(rows: readonly QualificationConfirmation[]): string {
  return [
    `| ${CONFIRMATION_COLUMNS.join(' | ')} |`,
    `| ${CONFIRMATION_COLUMNS.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => [row.qcrId, row.constraintId, row.actor, row.entrypoint, row.requestId, row.approvedDigest, row.confirmedAt, row.rationale]
      .map((value) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' '))
      .join(' | ')).map((line) => `| ${line} |`)
  ].join('\n');
}

type ConfirmationQualification = Extract<ReturnType<typeof parseTaskQualification>, { ok: true }>['qualification'];
type ConfirmationTaskLocation = Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;
type ConfirmationRows = Extract<ReturnType<typeof parseQualificationConfirmations>, { ok: true }>['confirmations'];
type ConfirmationContext = {
  resolved: ConfirmationTaskLocation;
  content: string;
  qualification: ConfirmationQualification;
  constraint: ConfirmationQualification['constraints'][number];
  confirmations: ConfirmationRows;
  operation: NonNullable<QualificationConfirmationRequest['operation']>;
};
type ConfirmationLoad = { ok: true; context: ConfirmationContext } | { ok: false; result: QualificationConfirmationResult };
type ConfirmationMutation = Parameters<typeof writeTask>[0]['mutations'][number];
type ConfirmationWrite = {
  ok: true;
  metadata: ReturnType<typeof captureTaskWriteMetadata>;
  qcrId: string | null;
  requestId: string | null;
  mutations: ConfirmationMutation[];
} | { ok: false; result: QualificationConfirmationResult };

function validConfirmationRequest(request: QualificationConfirmationRequest): boolean {
  return Boolean(request && typeof request === 'object' && request.taskRef && /^C-[1-9]\d*$/.test(request.constraintId)
    && /^[a-f0-9]{64}$/i.test(request.expectedDigest) && request.rationale?.trim() && !/[\r\n]/.test(request.rationale));
}

function loadConfirmationContext(request: QualificationConfirmationRequest, options: TaskWriteOptions): ConfirmationLoad {
  if (!validConfirmationRequest(request)) {
    return { ok: false, result: failed('QUALIFICATION_CONFIRMATION_INVALID', 'taskRef, constraintId, expectedDigest, and a single-line rationale are required') };
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { ok: false, result: failed(resolved.code, resolved.message, resolved.taskId) };
  if (resolved.state !== 'active') {
    return { ok: false, result: failed('TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId) };
  }
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) {
    return { ok: false, result: failed('TASK_READ_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId) };
  }
  const parsed = parseTaskQualification(content);
  if (!parsed.ok) return { ok: false, result: failed(parsed.code, parsed.message, resolved.taskId) };
  if (!parsed.qualification.present) {
    return { ok: false, result: failed('QUALIFICATION_TASK_CONTRACT_MISSING', 'task qualification contract is missing', resolved.taskId) };
  }
  const constraint = parsed.qualification.constraints.find((row) => row.constraintId === request.constraintId);
  if (!constraint) return { ok: false, result: failed('QUALIFICATION_CONSTRAINT_UNKNOWN', `unknown constraint '${request.constraintId}'`, resolved.taskId) };
  const operation = request.operation ?? 'confirm';
  const existing = parseQualificationConfirmations(content);
  if (!existing.ok) return { ok: false, result: failed(existing.code, existing.message, resolved.taskId) };
  return {
    ok: true,
    context: { resolved, content, qualification: parsed.qualification, constraint, confirmations: existing.confirmations, operation }
  };
}

function confirmationStateResult(request: QualificationConfirmationRequest, context: ConfirmationContext): QualificationConfirmationResult | null {
  const { constraint, confirmations, operation, qualification, resolved, content } = context;
  const previous = confirmations.find((row) => row.qcrId === constraint.approvalEvidence);
  if (operation === 'confirm' && constraint.status === 'confirmed') {
    if (previous?.constraintId === constraint.constraintId && previous.approvedDigest === constraint.digest && previous.rationale === request.rationale.trim()) {
      return { status: 'no-op', changed: false, taskId: resolved.taskId, qcrId: previous.qcrId, requestId: previous.requestId, operations: [], error: null, warnings: activityWarnings(content) };
    }
    return failed('QUALIFICATION_CONFIRMATION_CONFLICT', `constraint '${request.constraintId}' is already confirmed with different evidence`, resolved.taskId);
  }
  const transitionStatus = operation === 'supersede' ? 'superseded' : 'open';
  if (operation !== 'confirm' && constraint.status === transitionStatus && !constraint.approvalEvidence) {
    return { status: 'no-op', changed: false, taskId: resolved.taskId, qcrId: null, requestId: null, operations: [], error: null, warnings: activityWarnings(content) };
  }
  if (operation !== 'confirm' && constraint.status !== 'confirmed') return failed('QUALIFICATION_CONFIRMATION_REQUIRED', `constraint '${request.constraintId}' is not confirmed`, resolved.taskId);
  if (qualification.constraintDigest !== request.expectedDigest) return failed('QUALIFICATION_DIGEST_CONFLICT', 'constraint digest changed before human confirmation', resolved.taskId);
  return null;
}

type ConfirmationRecord = { qcrId: string | null; requestId: string | null; confirmation: QualificationConfirmation | null };

function createConfirmationRecord(request: QualificationConfirmationRequest, context: ConfirmationContext, metadata: ReturnType<typeof captureTaskWriteMetadata>): ConfirmationRecord {
  const { resolved, content, constraint, operation } = context;
  if (operation !== 'confirm') return { qcrId: null, requestId: null, confirmation: null };
  const qcrId = nextQcrId(content);
  const requestId = requestIdFor(resolved.taskId, request.constraintId, request.expectedDigest, request.rationale.trim(), metadata.timestamp);
  const confirmedConstraint = {
    constraintId: constraint.constraintId, statement: constraint.statement, status: 'confirmed' as const,
    authority: 'human-declared', source: constraint.source, evidence: constraint.evidence,
    derivedFrom: constraint.derivedFrom, approvalEvidence: qcrId
  };
  const confirmation = {
    qcrId, constraintId: request.constraintId, actor: 'human-declared' as const, entrypoint: 'task-qualification' as const,
    requestId, approvedDigest: constraintDigest(confirmedConstraint), confirmedAt: metadata.timestamp, rationale: request.rationale.trim()
  };
  return { qcrId, requestId, confirmation };
}

function confirmationConstraintMutation(context: ConfirmationContext, record: ConfirmationRecord): ConfirmationMutation {
  const { constraint, operation } = context;
  const transitionStatus = operation === 'supersede' ? 'superseded' : 'open';
  return {
    kind: 'table-row', action: 'upsert', sectionAliases: ['约束', 'Constraints'], columns: ['constraint_id', 'statement', 'status', 'authority', 'source', 'evidence', 'derived_from', 'approval_evidence'], keyColumn: 'constraint_id', key: constraint.constraintId,
    values: { statement: constraint.statement, status: operation === 'confirm' ? 'confirmed' : transitionStatus, authority: operation === 'confirm' ? 'human-declared' : constraint.authority, source: constraint.source, evidence: constraint.evidence, derived_from: constraint.derivedFrom.join(','), approval_evidence: record.qcrId ?? '' }
  };
}

function confirmationSectionMutations(request: QualificationConfirmationRequest, context: ConfirmationContext, metadata: ReturnType<typeof captureTaskWriteMetadata>, record: ConfirmationRecord): ConfirmationMutation[] {
  const { content, operation } = context;
  const confirmations = record.confirmation ? [...context.confirmations, record.confirmation] : context.confirmations;
  const mutations: ConfirmationMutation[] = [];
  if (operation === 'confirm') {
    mutations.push({ kind: 'section', aliases: CONFIRMATION_HEADINGS, heading: findSectionHeading(content, [...CONFIRMATION_HEADINGS]), body: renderConfirmations(confirmations) });
  }
  const activity = locateActivityLog(content);
  if (activity) {
    mutations.push({ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: activity.heading, body: appendActivityEntry(activity, { time: metadata.timestamp, step: 'Qualification Confirmation', agent: 'human', note: operation === 'confirm' ? `${request.constraintId} confirmed → ${record.qcrId}` : `${request.constraintId} ${operation}d` }) });
  }
  return mutations;
}

function prepareConfirmationWrite(request: QualificationConfirmationRequest, context: ConfirmationContext, options: TaskWriteOptions): ConfirmationWrite {
  const { resolved } = context;
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) {
    return { ok: false, result: failed('METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId) };
  }
  const record = createConfirmationRecord(request, context, metadata);
  const mutations = [confirmationConstraintMutation(context, record), ...confirmationSectionMutations(request, context, metadata, record)];
  return { ok: true, metadata, qcrId: record.qcrId, requestId: record.requestId, mutations };
}

function applyQualificationConfirmation(request: QualificationConfirmationRequest, options: TaskWriteOptions = {}): QualificationConfirmationResult {
  const loaded = loadConfirmationContext(request, options);
  if (!loaded.ok) return loaded.result;
  const { context } = loaded;
  const stateResult = confirmationStateResult(request, context);
  if (stateResult) return stateResult;
  const prepared = prepareConfirmationWrite(request, context, options);
  if (!prepared.ok) return prepared.result;
  const { resolved, content } = context;
  const { metadata, qcrId, requestId, mutations } = prepared;
  const result = writeTask({ taskRef: resolved.taskId, expectedState: 'active', mutations, dryRun: request.dryRun }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state }, metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(result.error.code, result.error.message, result.taskId);
  return { status: result.status, changed: result.changed, taskId: result.taskId, qcrId, requestId, operations: result.operations, error: null, warnings: activityWarnings(content) };
}

export { applyQualificationConfirmation };
export type { QualificationConfirmationRequest, QualificationConfirmationResult };
