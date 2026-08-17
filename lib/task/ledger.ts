// Shared parser for the task.md `## 审查分歧账本` (Review Disagreement Ledger).
// Single source of truth for ledger row parsing across `ai task` commands
// (log, decisions) — see the plan's D1 constraint "no third parser". The gate
// verification parsing consumes this module directly, so commands and gates
// share the same table parser.

// The ledger H2 heading is language-dependent (zh template / en template).
import { parseTable } from './sections.ts';

const LEDGER_HEADINGS = ['审查分歧账本', 'Review Disagreement Ledger'] as const;
const LEDGER_COLUMNS = ['id', 'stage', 'round', 'severity', 'status', 'evidence'] as const;

type LedgerRow = {
  id: string;
  stage: string;
  round: string;
  severity: string;
  status: string;
  evidence: string;
  /** Zero-based line within the normalized ledger section body. */
  sourceLine: number;
};

type ReviewStage = 'analysis' | 'plan' | 'code';
type ReviewSeverity = 'blocker' | 'major' | 'minor';

type LedgerValidationError = { code: string; message: string };
type LedgerStageStatus = {
  stage: ReviewStage;
  canAdvance: boolean;
  findingCounts: Record<ReviewSeverity, number>;
  unresolvedFindingCounts: Record<ReviewSeverity, number>;
  pendingHumanDecisions: number;
  unresolved: LedgerRow[];
  terminal: LedgerRow[];
};

// Terminal statuses the completion gates treat as resolved.
const LEDGER_TERMINAL = new Set(['confirmed', 'closed', 'human-decided']);
// Statuses that represent a decision row awaiting or carrying a human ruling.
const HUMAN_DECISION_STATUSES = new Set(['needs-human-decision', 'human-decided']);
const FINDING_STATUSES = new Set(['open', 'accepted', 'adjusted', 'refuted', 'cannot-judge', 'confirmed', 'needs-human-decision', 'closed', 'human-decided']);

function isReviewStage(stage: string): stage is ReviewStage {
  return stage === 'analysis' || stage === 'plan' || stage === 'code';
}

// Parse all rows of the disagreement ledger table. Skips the heading, the
// header row (`| id | ... |`) and the `|---|` separator; ignores non-`|` lines.
// Rows with fewer than 6 columns are skipped (mirrors the JS gate parser).
function parseLedger(content: string): LedgerRow[] {
  const table = parseTable(content, { sectionAliases: LEDGER_HEADINGS, columns: LEDGER_COLUMNS });
  return table?.rows.map(({ values, sourceLine }) => ({
    id: values.id!, stage: values.stage!, round: values.round!, severity: values.severity!,
    status: values.status!, evidence: values.evidence!, sourceLine
  })) ?? [];
}

function validateLedgerRows(rows: readonly LedgerRow[]): LedgerValidationError | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) return { code: 'LEDGER_DUPLICATE_ID', message: `duplicate ledger id '${row.id}'` };
    seen.add(row.id);
    if (/^PRC-[1-9]\d*$/.test(row.id)) {
      if (
        row.stage !== 'post-review-commit' ||
        row.round !== '-' ||
        row.severity !== '-' ||
        row.status !== 'human-decided' ||
        row.evidence === '' ||
        /[\r\n]/.test(row.evidence)
      ) {
        return { code: 'LEDGER_DOCUMENT_INVALID', message: `post-review exemption row '${row.id}' is invalid` };
      }
      continue;
    }
    if (row.stage === 'post-review-commit') {
      return { code: 'LEDGER_DOCUMENT_INVALID', message: `post-review exemption row '${row.id}' must use a PRC id` };
    }
    if (!/^(AN|PL|CD|HD)-[1-9]\d*$/.test(row.id)) return { code: 'LEDGER_ID_INVALID', message: `ledger id '${row.id}' is invalid` };
    if (!['analysis', 'plan', 'code', 'post-review-commit'].includes(row.stage)) return { code: 'LEDGER_STAGE_INVALID', message: `ledger stage '${row.stage}' is invalid` };
    if (!FINDING_STATUSES.has(row.status)) return { code: 'LEDGER_STATUS_INVALID', message: `ledger status '${row.status}' is invalid` };
    if (row.id.startsWith('AN-') && row.stage !== 'analysis' || row.id.startsWith('PL-') && row.stage !== 'plan' || row.id.startsWith('CD-') && row.stage !== 'code') {
      return { code: 'LEDGER_STAGE_INVALID', message: `ledger id '${row.id}' conflicts with stage '${row.stage}'` };
    }
    if (row.id.startsWith('HD-')) {
      if (row.round !== '-' || row.severity !== 'decision' || !HUMAN_DECISION_STATUSES.has(row.status)) return { code: 'LEDGER_DOCUMENT_INVALID', message: `decision row '${row.id}' is invalid` };
    } else if (!/^[1-9]\d*$/.test(row.round) || !['blocker', 'major', 'minor'].includes(row.severity)) {
      return { code: 'LEDGER_DOCUMENT_INVALID', message: `finding row '${row.id}' is invalid` };
    }
  }
  return null;
}

function summarizeLedgerStage(rows: readonly LedgerRow[], stage: ReviewStage): LedgerStageStatus {
  const scoped = rows.filter((row) => row.stage === stage);
  const unresolved = scoped.filter((row) => !LEDGER_TERMINAL.has(row.status));
  const terminal = scoped.filter((row) => LEDGER_TERMINAL.has(row.status));
  const findingCounts = { blocker: 0, major: 0, minor: 0 };
  const unresolvedFindingCounts = { blocker: 0, major: 0, minor: 0 };
  for (const row of scoped) {
    if (row.severity === 'blocker' || row.severity === 'major' || row.severity === 'minor') findingCounts[row.severity] += 1;
  }
  for (const row of unresolved) {
    if (row.severity === 'blocker' || row.severity === 'major' || row.severity === 'minor') unresolvedFindingCounts[row.severity] += 1;
  }
  return {
    stage,
    canAdvance: unresolved.length === 0,
    findingCounts,
    unresolvedFindingCounts,
    pendingHumanDecisions: unresolved.filter((row) => row.status === 'needs-human-decision').length,
    unresolved,
    terminal
  };
}

// Allocate the next globally-unique human-decision id. Scans every `HD-<n>`
// already present in the ledger (across all stages) and returns `HD-{max+1}`,
// or `HD-1` when none exist. Global monotonic allocation prevents id collisions
// across the analysis / plan / code stages (plan PL-2).
function nextHdId(rows: readonly LedgerRow[]): string {
  let max = 0;
  for (const row of rows) {
    const m = /^HD-(\d+)$/.exec(row.id);
    if (!m) continue;
    const n = Number.parseInt(m[1]!, 10);
    if (n > max) max = n;
  }
  return `HD-${max + 1}`;
}

export { LEDGER_HEADINGS, LEDGER_COLUMNS, parseLedger, nextHdId, isReviewStage, validateLedgerRows, summarizeLedgerStage, LEDGER_TERMINAL, HUMAN_DECISION_STATUSES };
export type { LedgerRow, ReviewStage, ReviewSeverity, LedgerValidationError, LedgerStageStatus };
