import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { appendActivityEntry, locateActivityLog } from './activity-log.ts';
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

function applyQualificationConfirmation(request: QualificationConfirmationRequest, options: TaskWriteOptions = {}): QualificationConfirmationResult {
  if (!request || typeof request !== 'object' || !request.taskRef || !/^C-[1-9]\d*$/.test(request.constraintId) || !/^[a-f0-9]{64}$/i.test(request.expectedDigest) || !request.rationale?.trim() || /[\r\n]/.test(request.rationale)) {
    return failed('QUALIFICATION_CONFIRMATION_INVALID', 'taskRef, constraintId, expectedDigest, and a single-line rationale are required');
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') return failed('TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return failed('TASK_READ_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  const parsed = parseTaskQualification(content);
  if (!parsed.ok) return failed(parsed.code, parsed.message, resolved.taskId);
  if (!parsed.qualification.present) return failed('QUALIFICATION_TASK_CONTRACT_MISSING', 'task qualification contract is missing', resolved.taskId);
  const constraint = parsed.qualification.constraints.find((row) => row.constraintId === request.constraintId);
  if (!constraint) return failed('QUALIFICATION_CONSTRAINT_UNKNOWN', `unknown constraint '${request.constraintId}'`, resolved.taskId);
  const operation = request.operation ?? 'confirm';
  const existing = parseQualificationConfirmations(content);
  if (!existing.ok) return failed(existing.code, existing.message, resolved.taskId);
  const previous = existing.confirmations.find((row) => row.qcrId === constraint.approvalEvidence);
  if (operation === 'confirm' && constraint.status === 'confirmed') {
    if (previous?.constraintId === constraint.constraintId && previous.approvedDigest === constraint.digest && previous.rationale === request.rationale.trim()) {
      return { status: 'no-op', changed: false, taskId: resolved.taskId, qcrId: previous.qcrId, requestId: previous.requestId, operations: [], error: null };
    }
    return failed('QUALIFICATION_CONFIRMATION_CONFLICT', `constraint '${request.constraintId}' is already confirmed with different evidence`, resolved.taskId);
  }
  const transitionStatus = operation === 'supersede' ? 'superseded' : 'open';
  if (operation !== 'confirm' && constraint.status === transitionStatus && !constraint.approvalEvidence) {
    return { status: 'no-op', changed: false, taskId: resolved.taskId, qcrId: null, requestId: null, operations: [], error: null };
  }
  if (operation !== 'confirm' && constraint.status !== 'confirmed') return failed('QUALIFICATION_CONFIRMATION_REQUIRED', `constraint '${request.constraintId}' is not confirmed`, resolved.taskId);
  if (parsed.qualification.constraintDigest !== request.expectedDigest) return failed('QUALIFICATION_DIGEST_CONFLICT', 'constraint digest changed before human confirmation', resolved.taskId);
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed('METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  const qcrId = operation === 'confirm' ? nextQcrId(content) : null;
  const requestId = operation === 'confirm' ? requestIdFor(resolved.taskId, request.constraintId, request.expectedDigest, request.rationale.trim(), metadata.timestamp) : null;
  const confirmedConstraint = qcrId ? {
    constraintId: constraint.constraintId, statement: constraint.statement, status: 'confirmed' as const,
    authority: 'human-declared', source: constraint.source, evidence: constraint.evidence,
    derivedFrom: constraint.derivedFrom, approvalEvidence: qcrId
  } : null;
  const confirmation = confirmedConstraint && qcrId && requestId ? {
    qcrId, constraintId: request.constraintId, actor: 'human-declared' as const, entrypoint: 'task-qualification' as const,
    requestId, approvedDigest: constraintDigest(confirmedConstraint), confirmedAt: metadata.timestamp, rationale: request.rationale.trim()
  } : null;
  const confirmations = confirmation ? [...existing.confirmations, confirmation] : existing.confirmations;
  const activity = locateActivityLog(content);
  if (!activity) return failed('QUALIFICATION_ACTIVITY_MISSING', 'task has no unique Activity Log section', resolved.taskId);
  const mutations: Parameters<typeof writeTask>[0]['mutations'][number][] = [
    {
      kind: 'table-row', action: 'upsert', sectionAliases: ['约束', 'Constraints'], columns: ['constraint_id', 'statement', 'status', 'authority', 'source', 'evidence', 'derived_from', 'approval_evidence'], keyColumn: 'constraint_id', key: constraint.constraintId,
      values: { statement: constraint.statement, status: operation === 'confirm' ? 'confirmed' : transitionStatus, authority: operation === 'confirm' ? 'human-declared' : constraint.authority, source: constraint.source, evidence: constraint.evidence, derived_from: constraint.derivedFrom.join(','), approval_evidence: qcrId ?? '' }
    },
    ...(operation === 'confirm' ? [{ kind: 'section' as const, aliases: CONFIRMATION_HEADINGS, heading: findSectionHeading(content, [...CONFIRMATION_HEADINGS]), body: renderConfirmations(confirmations) }] : []),
    { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: activity.heading, body: appendActivityEntry(activity, { time: metadata.timestamp, step: 'Qualification Confirmation', agent: 'human', note: operation === 'confirm' ? `${request.constraintId} confirmed → ${qcrId}` : `${request.constraintId} ${operation}d` }) }
  ];
  const result = writeTask({ taskRef: resolved.taskId, expectedState: 'active', mutations, dryRun: request.dryRun }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state }, metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(result.error.code, result.error.message, result.taskId);
  return { status: result.status, changed: result.changed, taskId: result.taskId, qcrId, requestId, operations: result.operations, error: null };
}

export { applyQualificationConfirmation };
export type { QualificationConfirmationRequest, QualificationConfirmationResult };
