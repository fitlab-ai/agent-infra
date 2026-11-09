import { parseTable } from './sections.ts';

const WORKFLOW_WARNING_HEADINGS = ['工作流告警', 'Workflow Warnings'];
const WORKFLOW_WARNING_STATUSES = new Set(['open', 'resolved', 'ignored']);
const WORKFLOW_WARNING_SEVERITIES = new Set(['IMPORTANT', 'ACTION_REQUIRED']);
const WORKFLOW_WARNING_COLUMNS = ['id', 'time', 'step', 'severity', 'code', 'status', 'target', 'message', 'action', 'resolved_at', 'resolution'] as const;
const WARNING_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?$/;

type WorkflowWarning = {
  id: string;
  time: string;
  step: string;
  severity: string;
  code: string;
  status: string;
  target: string;
  message: string;
  action: string;
  resolvedAt: string;
  resolution: string;
};

type WorkflowWarningValidationError = { code: string; message: string };

function invalidWorkflowWarning(message: string, code = 'WARNING_DOCUMENT_INVALID'): WorkflowWarningValidationError {
  return { code, message };
}

function appendWorkflowWarningIdentityErrors(warning: WorkflowWarning, errors: WorkflowWarningValidationError[]): void {
  const { id, time } = warning;
  if (!/^WW-[1-9]\d*$/.test(id)) errors.push(invalidWorkflowWarning(`${id || '(empty id)'}: invalid id`, 'WARNING_ID_INVALID'));
  if (!WARNING_TIME_PATTERN.test(time)) errors.push(invalidWorkflowWarning(`${id}: invalid time '${time}'`));
}

function appendWorkflowWarningRequiredFieldErrors(warning: WorkflowWarning, errors: WorkflowWarningValidationError[]): void {
  for (const field of ['step', 'code', 'target', 'message'] as const) {
    if (!warning[field].trim()) errors.push(invalidWorkflowWarning(`${warning.id}: ${field} is required`));
  }
}

function appendWorkflowWarningLifecycleErrors(warning: WorkflowWarning, errors: WorkflowWarningValidationError[]): void {
  const { id, severity, status, action, resolvedAt, resolution } = warning;
  if (!WORKFLOW_WARNING_SEVERITIES.has(severity)) errors.push(invalidWorkflowWarning(`${id}: illegal severity '${severity}'`));
  if (!WORKFLOW_WARNING_STATUSES.has(status)) errors.push(invalidWorkflowWarning(`${id}: illegal status '${status}'`));
  if (status === 'open' && !action.trim()) errors.push(invalidWorkflowWarning(`${id}: open warning requires action`));
  if ((status === 'resolved' || status === 'ignored') && (!resolvedAt.trim() || !resolution.trim())) {
    errors.push(invalidWorkflowWarning(`${id}: ${status} warning requires resolved_at and resolution`));
  }
}

function collectWorkflowWarningErrors(warnings: WorkflowWarning[]): WorkflowWarningValidationError[] {
  const errors: WorkflowWarningValidationError[] = [];
  for (const warning of warnings) {
    appendWorkflowWarningIdentityErrors(warning, errors);
    appendWorkflowWarningRequiredFieldErrors(warning, errors);
    appendWorkflowWarningLifecycleErrors(warning, errors);
  }
  return errors;
}

/** Parses warning structure and lifecycle fields using one contract for all readers. */
function parseWorkflowWarnings(content: string): WorkflowWarning[] {
  const table = parseTable(content, { sectionAliases: WORKFLOW_WARNING_HEADINGS, columns: WORKFLOW_WARNING_COLUMNS });
  const warnings = table?.rows.map(({ values }) => ({
    id: values.id!, time: values.time!, step: values.step!, severity: values.severity!,
    code: values.code!, status: values.status!, target: values.target!, message: values.message!,
    action: values.action!, resolvedAt: values.resolved_at!, resolution: values.resolution!
  })) ?? [];
  const errors = collectWorkflowWarningErrors(warnings);
  if (errors.length) throw Object.assign(new Error(errors.map((error) => error.message).join('; ')), { code: errors[0]!.code });
  return warnings;
}

function getOpenWorkflowWarnings(content: string): WorkflowWarning[] {
  return parseWorkflowWarnings(content).filter((warning) => warning.status === 'open');
}

function formatWorkflowWarningSummary(warnings: readonly WorkflowWarning[]): string[] {
  return warnings.map((warning) => {
    const target = warning.target ? ` ${warning.target}` : '';
    const action = warning.action ? ` - ${warning.action}` : '';
    return `${warning.id} [${warning.severity}] ${warning.code}${target}${action}`;
  });
}

export {
  WORKFLOW_WARNING_HEADINGS,
  WORKFLOW_WARNING_STATUSES,
  WORKFLOW_WARNING_SEVERITIES,
  WORKFLOW_WARNING_COLUMNS,
  parseWorkflowWarnings,
  getOpenWorkflowWarnings,
  formatWorkflowWarningSummary
};
export type { WorkflowWarning };
