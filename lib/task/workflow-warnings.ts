import { extractSection } from './sections.ts';

const WORKFLOW_WARNING_HEADINGS = ['工作流告警', 'Workflow Warnings'];
const WORKFLOW_WARNING_STATUSES = new Set(['open', 'resolved', 'ignored']);
const WORKFLOW_WARNING_SEVERITIES = new Set(['IMPORTANT', 'ACTION_REQUIRED']);

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

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (!value.startsWith('|')) return [];
  value = value.replace(/^\|/, '').replace(/\|$/, '');

  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '|' && !isEscapedAt(value, index)) {
      cells.push(unescapeTableCell(cell.trim()));
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(unescapeTableCell(cell.trim()));
  return cells;
}

function unescapeTableCell(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    const next = value[index + 1];
    if (char === '\\' && (next === '\\' || next === '|')) {
      output += next;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Parses well-formed workflow warning rows. Malformed rows are intentionally
 * ignored here; validate-artifact is responsible for reporting structure errors.
 */
function parseWorkflowWarnings(content: string): WorkflowWarning[] {
  const section = extractSection(content, WORKFLOW_WARNING_HEADINGS);
  if (!section) return [];

  const rows: WorkflowWarning[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    const cells = splitTableRow(rawLine);
    if (cells.length === 0) continue;
    if ((cells[0] ?? '').toLowerCase() === 'id') continue;
    if (isSeparatorRow(cells)) continue;
    if (cells.length < 11) continue;

    rows.push({
      id: cells[0] ?? '',
      time: cells[1] ?? '',
      step: cells[2] ?? '',
      severity: cells[3] ?? '',
      code: cells[4] ?? '',
      status: cells[5] ?? '',
      target: cells[6] ?? '',
      message: cells[7] ?? '',
      action: cells[8] ?? '',
      resolvedAt: cells[9] ?? '',
      resolution: cells[10] ?? ''
    });
  }
  return rows;
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
  parseWorkflowWarnings,
  getOpenWorkflowWarnings,
  formatWorkflowWarningSummary
};
export type { WorkflowWarning };
