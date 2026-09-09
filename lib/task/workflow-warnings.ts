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

/** Parses warning structure and lifecycle fields using one contract for all readers. */
function parseWorkflowWarnings(content: string): WorkflowWarning[] {
  const table = parseTable(content, { sectionAliases: WORKFLOW_WARNING_HEADINGS, columns: WORKFLOW_WARNING_COLUMNS });
  const warnings = table?.rows.map(({ values }) => ({
    id: values.id!, time: values.time!, step: values.step!, severity: values.severity!,
    code: values.code!, status: values.status!, target: values.target!, message: values.message!,
    action: values.action!, resolvedAt: values.resolved_at!, resolution: values.resolution!
  })) ?? [];
  const errors: { code: string; message: string }[] = [];
  const invalid = (message: string, code = 'WARNING_DOCUMENT_INVALID') => errors.push({ code, message });
  for (const warning of warnings) {
    const { id, time, severity, status, action, resolvedAt, resolution } = warning;
    if (!/^WW-[1-9]\d*$/.test(id)) invalid(`${id || '(empty id)'}: invalid id`, 'WARNING_ID_INVALID');
    if (!WARNING_TIME_PATTERN.test(time)) invalid(`${id}: invalid time '${time}'`);
    for (const field of ['step', 'code', 'target', 'message'] as const) {
      if (!warning[field].trim()) invalid(`${id}: ${field} is required`);
    }
    if (!WORKFLOW_WARNING_SEVERITIES.has(severity)) invalid(`${id}: illegal severity '${severity}'`);
    if (!WORKFLOW_WARNING_STATUSES.has(status)) invalid(`${id}: illegal status '${status}'`);
    if (status === 'open' && !action.trim()) invalid(`${id}: open warning requires action`);
    if ((status === 'resolved' || status === 'ignored') && (!resolvedAt.trim() || !resolution.trim())) {
      invalid(`${id}: ${status} warning requires resolved_at and resolution`);
    }
  }
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
