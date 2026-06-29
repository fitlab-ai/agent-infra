// Shared parser for the task.md `## 审查分歧账本` (Review Disagreement Ledger).
// Single source of truth for ledger row parsing across `ai task` commands
// (log, decisions) — see the plan's D1 constraint "no third parser". The gate
// parser in `.agents/scripts/validate-artifact.js` is a separate concern and
// must be kept semantically in sync by hand (noted in review-handshake.md).

// The ledger H2 heading is language-dependent (zh template / en template).
const LEDGER_HEADING_RE = /^##\s+(审查分歧账本|Review Disagreement Ledger)\s*$/;
const NEXT_H2_RE = /^##\s/;

type LedgerRow = {
  id: string;
  stage: string;
  round: string;
  severity: string;
  status: string;
  evidence: string;
};

// Terminal statuses the completion gates treat as resolved.
const LEDGER_TERMINAL = new Set(['confirmed', 'closed', 'human-decided']);
// Statuses that represent an executor-raised human-decision row (pending or done).
const HUMAN_DECISION_STATUSES = new Set(['needs-human-decision', 'human-decided']);

// Parse all rows of the disagreement ledger table. Skips the heading, the
// header row (`| id | ... |`) and the `|---|` separator; ignores non-`|` lines.
// Rows with fewer than 6 columns are skipped (mirrors the JS gate parser).
function parseLedger(content: string): LedgerRow[] {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !LEDGER_HEADING_RE.test(lines[i]!)) i += 1;
  if (i >= lines.length) return [];

  const rows: LedgerRow[] = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (NEXT_H2_RE.test(lines[j]!)) break;
    const line = lines[j]!.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 6) continue;
    if (cells[0] === 'id' || /^-+$/.test(cells[0] ?? '')) continue;
    rows.push({
      id: cells[0]!,
      stage: cells[1]!,
      round: cells[2]!,
      severity: cells[3]!,
      status: cells[4]!,
      evidence: cells[5]!
    });
  }
  return rows;
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

export { parseLedger, nextHdId, LEDGER_TERMINAL, HUMAN_DECISION_STATUSES };
export type { LedgerRow };
