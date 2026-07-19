import fs from 'node:fs';

import { resolveTaskRef } from './resolve-ref.ts';
import {
  WORKFLOW_WARNING_COLUMNS,
  WORKFLOW_WARNING_HEADINGS,
  WORKFLOW_WARNING_SEVERITIES,
  WORKFLOW_WARNING_STATUSES,
  parseWorkflowWarnings
} from './workflow-warnings.ts';
import type { WorkflowWarning } from './workflow-warnings.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';

type WarningSeverity = 'IMPORTANT' | 'ACTION_REQUIRED';
type WarningStatus = 'open' | 'resolved' | 'ignored';
type WorkflowWarningIntent =
  | { kind: 'add'; taskRef: string; step: string; severity: WarningSeverity; code: string; target: string; message: string; action: string; dryRun?: boolean }
  | { kind: 'set-status'; taskRef: string; id: string; status: 'resolved' | 'ignored'; resolution: string; dryRun?: boolean }
  | { kind: 'list'; taskRef: string; status?: WarningStatus };

type WorkflowWarningIntentResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed'; changed: boolean;
  intent: WorkflowWarningIntent['kind']; taskId: string | null; entityId: string | null;
  before: WorkflowWarning | null; after: WorkflowWarning | null;
  warnings: readonly WorkflowWarning[]; operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
};

function failed(intent: WorkflowWarningIntent, code: string, message: string, taskId: string | null = null, entityId: string | null = null): WorkflowWarningIntentResult {
  return { status: 'failed', changed: false, intent: intent.kind, taskId, entityId, before: null, after: null, warnings: [], operations: [], error: { code, message } };
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function nextWarningId(rows: readonly WorkflowWarning[]): string {
  let max = 0;
  for (const row of rows) {
    const match = /^WW-(\d+)$/.exec(row.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `WW-${max + 1}`;
}

function validateRows(rows: readonly WorkflowWarning[]): { code: string; message: string } | null {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!/^WW-[1-9]\d*$/.test(row.id)) return { code: 'WARNING_ID_INVALID', message: `warning id '${row.id}' is invalid` };
    if (ids.has(row.id)) return { code: 'WARNING_DUPLICATE_ID', message: `duplicate warning id '${row.id}'` };
    ids.add(row.id);
    if (!WORKFLOW_WARNING_SEVERITIES.has(row.severity) || !WORKFLOW_WARNING_STATUSES.has(row.status)) return { code: 'WARNING_DOCUMENT_INVALID', message: `warning '${row.id}' has invalid severity or status` };
  }
  return null;
}

function sectionMutation(content: string): TaskMutation[] {
  if (/^##\s+(工作流告警|Workflow Warnings)\s*$/m.test(content)) return [];
  const english = /^##\s+Activity Log\s*$/m.test(content);
  return [{
    kind: 'section', aliases: WORKFLOW_WARNING_HEADINGS, heading: english ? 'Workflow Warnings' : '工作流告警',
    body: `| ${WORKFLOW_WARNING_COLUMNS.join(' | ')} |\n|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|`
  }];
}

function rowMutation(row: WorkflowWarning): TaskMutation {
  return {
    kind: 'table-row', action: 'upsert', sectionAliases: WORKFLOW_WARNING_HEADINGS,
    columns: WORKFLOW_WARNING_COLUMNS, keyColumn: 'id', key: row.id,
    values: {
      time: row.time, step: row.step, severity: row.severity, code: row.code, status: row.status,
      target: row.target, message: row.message, action: row.action,
      resolved_at: row.resolvedAt, resolution: row.resolution
    }
  };
}

function applyWorkflowWarningIntent(intent: WorkflowWarningIntent, options: TaskWriteOptions = {}): WorkflowWarningIntentResult {
  const resolved = resolveTaskRef(intent.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(intent, resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') return failed(intent, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  let content: string;
  let rows: WorkflowWarning[];
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    rows = parseWorkflowWarnings(content);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'WARNING_DOCUMENT_INVALID';
    return failed(intent, code, error instanceof Error ? error.message : String(error), resolved.taskId);
  }
  const invalid = validateRows(rows);
  if (invalid) return failed(intent, invalid.code, invalid.message, resolved.taskId);
  if (intent.kind === 'list') {
    if (intent.status && !WORKFLOW_WARNING_STATUSES.has(intent.status)) return failed(intent, 'WARNING_PAYLOAD_INVALID', 'warning status is invalid', resolved.taskId);
    const warnings = rows.filter((row) => !intent.status || row.status === intent.status);
    return { status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: null, before: null, after: null, warnings, operations: [], error: null };
  }

  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed(intent, 'METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  let before: WorkflowWarning | null;
  let after: WorkflowWarning;
  if (intent.kind === 'add') {
    const step = oneLine(intent.step); const code = oneLine(intent.code); const target = oneLine(intent.target);
    const message = oneLine(intent.message); const action = oneLine(intent.action);
    if (!step || !code || !target || !message || !action || !WORKFLOW_WARNING_SEVERITIES.has(intent.severity)) {
      return failed(intent, 'WARNING_PAYLOAD_INVALID', 'warning add payload is invalid', resolved.taskId);
    }
    before = rows.find((row) => row.status === 'open' && row.step === step && row.code === code && row.target === target) ?? null;
    after = before
      ? { ...before, severity: intent.severity, message, action }
      : { id: nextWarningId(rows), time: metadata.timestamp, step, severity: intent.severity, code, status: 'open', target, message, action, resolvedAt: '', resolution: '' };
  } else {
    if (!/^WW-[1-9]\d*$/.test(intent.id) || !['resolved', 'ignored'].includes(intent.status) || !oneLine(intent.resolution)) {
      return failed(intent, 'WARNING_PAYLOAD_INVALID', 'warning status payload is invalid', resolved.taskId, intent.id);
    }
    before = rows.find((row) => row.id === intent.id) ?? null;
    if (!before) return failed(intent, 'WARNING_NOT_FOUND', `warning '${intent.id}' was not found`, resolved.taskId, intent.id);
    const resolution = oneLine(intent.resolution);
    if (before.status === intent.status && before.resolution === resolution) after = { ...before };
    else if (before.status !== 'open') return failed(intent, 'WARNING_TRANSITION_INVALID', `warning '${intent.id}' cannot transition from ${before.status}`, resolved.taskId, intent.id);
    else after = { ...before, status: intent.status, resolvedAt: metadata.timestamp, resolution };
  }

  const writeResult = writeTask({
    taskRef: intent.taskRef, expectedState: 'active', mutations: [...sectionMutation(content), rowMutation(after)], dryRun: intent.dryRun
  }, {
    ...options,
    taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state },
    metadataProvider: () => metadata
  });
  if (writeResult.status === 'failed') return failed(intent, writeResult.error.code, writeResult.error.message, writeResult.taskId, after.id);
  return {
    status: writeResult.status, changed: writeResult.changed, intent: intent.kind, taskId: writeResult.taskId,
    entityId: after.id, before, after, warnings: [], operations: writeResult.operations, error: null
  };
}

export { applyWorkflowWarningIntent };
export type { WarningSeverity, WarningStatus, WorkflowWarningIntent, WorkflowWarningIntentResult };
