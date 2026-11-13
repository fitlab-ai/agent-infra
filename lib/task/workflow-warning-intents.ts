import fs from 'node:fs';
import path from 'node:path';

import { resolveTaskRef } from './resolve-ref.ts';
import { parseTaskFrontmatter } from './frontmatter.ts';
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
import { retryHintForWarning, type OperationWarning } from './operation-outcome.ts';

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

type FinalizationWarningProjectionResult = Readonly<{
  status: 'applied' | 'no-op' | 'failed';
  changed: boolean;
  error: { code: string; message: string } | null;
}>;

type ActiveWarningContext = {
  resolved: Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;
  content: string;
  rows: WorkflowWarning[];
};

type ActiveWarningContextResult =
  | { context: ActiveWarningContext; failure: null }
  | { context: null; failure: WorkflowWarningIntentResult };

type WarningChangeResult =
  | { before: WorkflowWarning | null; after: WorkflowWarning; failure: null }
  | { before: null; after: null; failure: WorkflowWarningIntentResult };

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

function sectionMutation(content: string): TaskMutation[] {
  if (/^##\s+(工作流告警|Workflow Warnings)\s*$/m.test(content)) return [];
  const english = /^##\s+Activity Log\s*$/m.test(content);
  return [{
    kind: 'section', aliases: WORKFLOW_WARNING_HEADINGS, heading: english ? 'Workflow Warnings' : '工作流告警',
    body: `| ${WORKFLOW_WARNING_COLUMNS.join(' | ')} |\n|----|------|------|----------|------|--------|---------|--------|-------------|------------|------------|`
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

function readActiveWarningContext(intent: WorkflowWarningIntent, options: TaskWriteOptions): ActiveWarningContextResult {
  const resolved = resolveTaskRef(intent.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { context: null, failure: failed(intent, resolved.code, resolved.message, resolved.taskId) };
  if (resolved.state !== 'active') {
    return { context: null, failure: failed(intent, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId) };
  }
  try {
    const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    const rows = parseWorkflowWarnings(content);
    return { context: { resolved, content, rows }, failure: null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'WARNING_DOCUMENT_INVALID';
    return { context: null, failure: failed(intent, code, error instanceof Error ? error.message : String(error), resolved.taskId) };
  }
}

function prepareWarningAdd(
  intent: Extract<WorkflowWarningIntent, { kind: 'add' }>,
  rows: readonly WorkflowWarning[],
  metadata: ReturnType<typeof captureTaskWriteMetadata>
): WarningChangeResult {
  const step = oneLine(intent.step); const code = oneLine(intent.code); const target = oneLine(intent.target);
  const message = oneLine(intent.message); const action = oneLine(intent.action);
  if (!step || !code || !target || !message || !action || !WORKFLOW_WARNING_SEVERITIES.has(intent.severity)) {
    return { before: null, after: null, failure: failed(intent, 'WARNING_PAYLOAD_INVALID', 'warning add payload is invalid') };
  }
  const before = rows.find((row) => row.status === 'open' && row.step === step && row.code === code && row.target === target) ?? null;
  const after: WorkflowWarning = before
    ? { ...before, severity: intent.severity, message, action }
    : { id: nextWarningId(rows), time: metadata.timestamp, step, severity: intent.severity, code, status: 'open', target, message, action, resolvedAt: '', resolution: '' };
  return { before, after, failure: null };
}

function prepareWarningStatus(
  intent: Extract<WorkflowWarningIntent, { kind: 'set-status' }>,
  rows: readonly WorkflowWarning[],
  metadata: ReturnType<typeof captureTaskWriteMetadata>
): WarningChangeResult {
  if (!/^WW-[1-9]\d*$/.test(intent.id) || !['resolved', 'ignored'].includes(intent.status) || !oneLine(intent.resolution)) {
    return { before: null, after: null, failure: failed(intent, 'WARNING_PAYLOAD_INVALID', 'warning status payload is invalid', null, intent.id) };
  }
  const before = rows.find((row) => row.id === intent.id) ?? null;
  if (!before) return { before: null, after: null, failure: failed(intent, 'WARNING_NOT_FOUND', `warning '${intent.id}' was not found`, null, intent.id) };
  const resolution = oneLine(intent.resolution);
  if (before.status === intent.status && before.resolution === resolution) return { before, after: { ...before }, failure: null };
  if (before.status !== 'open') {
    return { before: null, after: null, failure: failed(intent, 'WARNING_TRANSITION_INVALID', `warning '${intent.id}' cannot transition from ${before.status}`, null, intent.id) };
  }
  return { before, after: { ...before, status: intent.status, resolvedAt: metadata.timestamp, resolution }, failure: null };
}

function isPreparedFinalizationTask(resolved: ActiveWarningContext['resolved']): boolean {
  if (resolved.state === 'completed') return true;
  if (resolved.state !== 'active') return false;
  try {
    const taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
    if (parseTaskFrontmatter(taskContent).status === 'completed') return true;
    const lifecycle = JSON.parse(fs.readFileSync(path.join(resolved.taskDir, '.task-lifecycle.json'), 'utf8')) as Record<string, unknown>;
    return lifecycle.taskId === resolved.taskId && lifecycle.intent === 'complete';
  } catch {
    return false;
  }
}

function finalizationResolution(
  warning: OperationWarning & { status: 'open' | 'resolved' },
  resolution: 'passed' | 'superseded' | undefined
): string {
  if (warning.status !== 'resolved') return '';
  return resolution === 'superseded'
    ? 'Superseded by a later verification observation'
    : 'Resolved by a successful finalization retry';
}

function projectWarningRow(
  rows: readonly WorkflowWarning[],
  existing: WorkflowWarning | undefined,
  warning: OperationWarning & { status: 'open' | 'resolved'; resolvedAt: string | null },
  metadata: ReturnType<typeof captureTaskWriteMetadata>,
  resolution: 'passed' | 'superseded' | undefined
): WorkflowWarning {
  const rowResolution = finalizationResolution(warning, resolution);
  if (existing) {
    const resolvedAt = warning.resolvedAt || (warning.status === 'resolved' ? metadata.timestamp : '');
    return {
      ...existing, severity: warning.severity, status: warning.status, message: warning.message,
      action: retryHintForWarning(warning), resolvedAt, resolution: rowResolution
    };
  }
  return {
    id: nextWarningId(rows), time: metadata.timestamp, step: warning.step,
    severity: warning.severity, code: warning.code, status: warning.status,
    target: warning.target, message: warning.message, action: retryHintForWarning(warning),
    resolvedAt: warning.resolvedAt || '', resolution: rowResolution
  };
}

function applyWorkflowWarningIntent(intent: WorkflowWarningIntent, options: TaskWriteOptions = {}): WorkflowWarningIntentResult {
  const loaded = readActiveWarningContext(intent, options);
  if (loaded.failure) return loaded.failure;
  const { resolved, content, rows } = loaded.context;
  if (intent.kind === 'list') {
    if (intent.status && !WORKFLOW_WARNING_STATUSES.has(intent.status)) return failed(intent, 'WARNING_PAYLOAD_INVALID', 'warning status is invalid', resolved.taskId);
    const warnings = rows.filter((row) => !intent.status || row.status === intent.status);
    return { status: 'no-op', changed: false, intent: intent.kind, taskId: resolved.taskId, entityId: null, before: null, after: null, warnings, operations: [], error: null };
  }

  let metadata;
  try { metadata = (options.metadataProvider ?? captureTaskWriteMetadata)(); }
  catch (error) { return failed(intent, 'METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId); }
  const change = intent.kind === 'add'
    ? prepareWarningAdd(intent, rows, metadata)
    : prepareWarningStatus(intent, rows, metadata);
  if (change.failure) return { ...change.failure, taskId: resolved.taskId };

  const writeResult = writeTask({
    taskRef: intent.taskRef, expectedState: 'active', mutations: [...sectionMutation(content), rowMutation(change.after)], dryRun: intent.dryRun
  }, {
    ...options,
    taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state },
    metadataProvider: () => metadata
  });
  if (writeResult.status === 'failed') return failed(intent, writeResult.error.code, writeResult.error.message, writeResult.taskId, change.after.id);
  return {
    status: writeResult.status, changed: writeResult.changed, intent: intent.kind, taskId: writeResult.taskId,
    entityId: change.after.id, before: change.before, after: change.after,
    warnings: [], operations: writeResult.operations, error: null
  };
}

function projectFinalizationWarning(
  taskRef: string,
  warning: OperationWarning & { status: 'open' | 'resolved'; resolvedAt: string | null },
  options: TaskWriteOptions & { resolution?: 'passed' | 'superseded' } = {}
): FinalizationWarningProjectionResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } };
  if (!isPreparedFinalizationTask(resolved)) {
    return { status: 'failed', changed: false, error: { code: 'TASK_STATE_MISMATCH', message: `task ${resolved.taskId} is ${resolved.state}, expected a prepared or completed task` } };
  }
  let content: string;
  let rows: WorkflowWarning[];
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    rows = parseWorkflowWarnings(content);
  } catch (error) {
    return { status: 'failed', changed: false, error: { code: 'WARNING_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) } };
  }
  const metadata = (options.metadataProvider ?? captureTaskWriteMetadata)();
  const existing = rows.find((row) => row.step === warning.step && row.code === warning.code && row.target === warning.target);
  const after = projectWarningRow(rows, existing, warning, metadata, options.resolution);
  if (existing && JSON.stringify(existing) === JSON.stringify(after)) return { status: 'no-op', changed: false, error: null };
  const written = writeTask({
    taskRef: resolved.taskId,
    expectedState: resolved.state,
    mutations: [...sectionMutation(content), rowMutation(after)]
  }, {
    ...options,
    taskLocation: { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskMdPath: resolved.taskMdPath, state: resolved.state },
    metadataProvider: () => metadata
  });
  if (written.status === 'failed') return { status: 'failed', changed: false, error: { code: written.error.code, message: written.error.message } };
  return { status: written.status === 'applied' ? 'applied' : 'no-op', changed: written.changed, error: null };
}

export { applyWorkflowWarningIntent, projectFinalizationWarning };
export type { FinalizationWarningProjectionResult, WarningSeverity, WarningStatus, WorkflowWarningIntent, WorkflowWarningIntentResult };
