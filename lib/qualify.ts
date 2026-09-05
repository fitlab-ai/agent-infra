import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { appendActivityEntry, locateActivityLog } from './task/activity-log.ts';
import { CONFIRMATION_COLUMNS, CONFIRMATION_HEADINGS, parseQualificationConfirmations, parseTaskQualification } from './task/qualification-audit.ts';
import type { QualificationConfirmation } from './task/qualification-audit.ts';
import { findSectionHeading } from './task/sections.ts';
import { resolveTaskRef } from './task/resolve-ref.ts';
import { captureTaskWriteMetadata, writeTask } from './task/write.ts';
import type { TaskOperationSummary, TaskWriteOptions } from './task/write.ts';

type QualificationConfirmationRequest = {
  taskRef: string;
  constraintId: string;
  expectedDigest: string;
  rationale: string;
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
  const existing = parseQualificationConfirmations(content);
  if (!existing.ok) return failed(existing.code, existing.message, resolved.taskId);
  const previous = existing.confirmations.find((row) => row.constraintId === request.constraintId);
  if (constraint.status === 'confirmed') {
    if (previous?.approvedDigest === request.expectedDigest && previous.rationale === request.rationale) {
      return { status: 'no-op', changed: false, taskId: resolved.taskId, qcrId: previous.qcrId, requestId: previous.requestId, operations: [], error: null };
    }
    return failed('QUALIFICATION_CONFIRMATION_CONFLICT', `constraint '${request.constraintId}' is already confirmed with different evidence`, resolved.taskId);
  }
  if (parsed.qualification.constraintDigest !== request.expectedDigest) return failed('QUALIFICATION_DIGEST_CONFLICT', 'constraint digest changed before human confirmation', resolved.taskId);
  if (previous) return failed('QUALIFICATION_CONFIRMATION_CONFLICT', `constraint '${request.constraintId}' already has a confirmation record`, resolved.taskId);
  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed('METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  const qcrId = nextQcrId(content);
  const requestId = requestIdFor(resolved.taskId, request.constraintId, request.expectedDigest, request.rationale.trim(), metadata.timestamp);
  const confirmation = {
    qcrId, constraintId: request.constraintId, actor: 'human-declared' as const, entrypoint: 'ai qualify' as const,
    requestId, approvedDigest: request.expectedDigest, confirmedAt: metadata.timestamp, rationale: request.rationale.trim()
  };
  const confirmations = [...existing.confirmations, confirmation];
  const activity = locateActivityLog(content);
  if (!activity) return failed('QUALIFICATION_ACTIVITY_MISSING', 'task has no unique Activity Log section', resolved.taskId);
  const mutations: Parameters<typeof writeTask>[0]['mutations'][number][] = [
    {
      kind: 'table-row', action: 'upsert', sectionAliases: ['约束', 'Constraints'], columns: ['constraint_id', 'statement', 'status', 'authority', 'source', 'evidence', 'derived_from', 'approval_evidence'], keyColumn: 'constraint_id', key: constraint.constraintId,
      values: { statement: constraint.statement, status: 'confirmed', authority: 'human-declared', source: constraint.source, evidence: constraint.evidence, derived_from: constraint.derivedFrom.join(','), approval_evidence: qcrId }
    },
    { kind: 'section', aliases: CONFIRMATION_HEADINGS, heading: findSectionHeading(content, [...CONFIRMATION_HEADINGS]), body: renderConfirmations(confirmations) },
    { kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: activity.heading, body: appendActivityEntry(activity, { time: metadata.timestamp, step: 'Qualification Confirmation', agent: 'human', note: `${request.constraintId} confirmed → ${qcrId}` }) }
  ];
  const result = writeTask({ taskRef: resolved.taskId, expectedState: 'active', mutations, dryRun: request.dryRun }, { ...options, taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state }, metadataProvider: () => metadata });
  if (result.status === 'failed') return failed(result.error.code, result.error.message, result.taskId);
  return { status: result.status, changed: result.changed, taskId: result.taskId, qcrId, requestId, operations: result.operations, error: null };
}

export async function qualify(args: string[], options: TaskWriteOptions = {}): Promise<number> {
  let taskRef: string | undefined;
  let constraintId: string | undefined;
  let expectedDigest: string | undefined;
  let dryRun = false;
  const rationale: string[] = [];
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--task' || arg === '-t') taskRef = args[++index];
      else if (arg === '--constraint' || arg === '--constraint-id' || arg === '--id') constraintId = args[++index];
      else if (arg === '--digest' || arg === '--constraint-digest') expectedDigest = args[++index];
      else if (arg === '--dry-run') dryRun = true;
      else if (arg === '--help' || arg === '-h') { process.stdout.write('Usage: ai qualify [--task <ref>] --constraint <C-N> --digest <sha256> <rationale>\n'); return 0; }
      else rationale.push(arg);
    }
    if (!taskRef || !constraintId || !expectedDigest || rationale.length === 0) throw new Error('Usage: ai qualify [--task <ref>] --constraint <C-N> --digest <sha256> <rationale>');
    const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
    if (!resolved.ok) throw new Error(resolved.message);
    const { withTaskExecutionLock } = await import('./task/task-execution-lock.ts');
    const result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-qualification.confirm', () => applyQualificationConfirmation({ taskRef: resolved.taskId, constraintId: constraintId!, expectedDigest: expectedDigest!, rationale: rationale.join(' '), dryRun }, options));
    if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function cmdQualify(args: string[]): Promise<void> {
  process.exitCode = await qualify(args);
}

export { applyQualificationConfirmation };
export type { QualificationConfirmationRequest, QualificationConfirmationResult };
