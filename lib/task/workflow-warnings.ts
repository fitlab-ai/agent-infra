import { parseTable } from './sections.ts';

const WORKFLOW_WARNING_HEADINGS = ['工作流告警', 'Workflow Warnings'];
const WORKFLOW_WARNING_STATUSES = new Set(['open', 'resolved', 'ignored']);
const WORKFLOW_WARNING_SEVERITIES = new Set(['IMPORTANT', 'ACTION_REQUIRED']);
const WORKFLOW_WARNING_COLUMNS = ['id', 'time', 'step', 'severity', 'code', 'status', 'target', 'message', 'action', 'resolved_at', 'resolution'] as const;

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

/** Parses workflow warning rows and fails closed on malformed table structure. */
function parseWorkflowWarnings(content: string): WorkflowWarning[] {
  const table = parseTable(content, { sectionAliases: WORKFLOW_WARNING_HEADINGS, columns: WORKFLOW_WARNING_COLUMNS });
  return table?.rows.map(({ values }) => ({
    id: values.id!, time: values.time!, step: values.step!, severity: values.severity!,
    code: values.code!, status: values.status!, target: values.target!, message: values.message!,
    action: values.action!, resolvedAt: values.resolved_at!, resolution: values.resolution!
  })) ?? [];
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
