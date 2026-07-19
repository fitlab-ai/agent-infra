// Shared parser for the task.md `## 审查分歧账本` (Review Disagreement Ledger).
// Single source of truth for ledger row parsing across `ai task` commands
// (log, decisions) — see the plan's D1 constraint "no third parser". The gate
// parser in `.agents/scripts/validate-artifact.js` is a separate concern and
// must be kept semantically in sync by hand (noted in review-handshake.md).

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

// Terminal statuses the completion gates treat as resolved.
const LEDGER_TERMINAL = new Set(['confirmed', 'closed', 'human-decided']);
// Statuses that represent a decision row awaiting or carrying a human ruling.
const HUMAN_DECISION_STATUSES = new Set(['needs-human-decision', 'human-decided']);

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

export { LEDGER_HEADINGS, LEDGER_COLUMNS, parseLedger, nextHdId, isReviewStage, LEDGER_TERMINAL, HUMAN_DECISION_STATUSES };
export type { LedgerRow, ReviewStage };
