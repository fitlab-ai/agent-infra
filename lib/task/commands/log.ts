import fs from 'node:fs';
import { classifyAgent } from '../../agent-clients/tokens.ts';
import { formatTable } from '../../table.ts';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';
import { isReviewStage, parseLedger, type LedgerRow, type ReviewStage } from '../ledger.ts';
import { parseActivityLog, pairEntries } from '../activity-log.ts';

const USAGE = `Usage: ai task log [<N | TASK-id> | --task <ref> | -t <ref>]

Renders a task's activity log as a per-step status table. A step's start and
completion are paired onto one row: STARTED holds the start time, DONE the
completion time (or '(in progress)' while still running).
  Omit <ref>   Resolve the unique active task for the current branch.
  <ref>   Bare numeric short id, or a full TASK-YYYYMMDD-HHMMSS id.

Columns: # (row) / STEP / AGENT / STARTED / DONE / NOTE
  A human-executed step shows AGENT as 'human' and, when it has no start marker,
  a '-' STARTED placeholder. Review-step NOTE also carries two human counts in
  the verdict list, right after blockers/major/minor: manual-validation
  and human-decision (current pending ledger stage total).
`;

const TABLE_HEADERS = ['#', 'STEP', 'AGENT', 'STARTED', 'DONE', 'NOTE'] as const;

// The activity-log H2 heading is language-dependent (zh template / en template).
// `- {time} — **{step}** by {agent} — {note}` ; the separator is an em-dash
// (U+2014). STEP/AGENT are non-greedy so a note that itself contains ' — ' or
// '→' is not mis-split; NOTE greedily takes the rest of the line.
// One rendered row = one step instance. `started`/`done` are timestamps; an empty
// `done` with a non-empty `started` means the step is still in flight, while an
// empty `started` is a historical done-only entry (no start marker was written).

// A start marker reuses the normal entry grammar and only suffixes its action
// with ` [started]`; the matching done entry carries the identical base action
// without the suffix. Pairing therefore keys on the base action (including any
// `(Round N)`), so every round and every repeated execution pairs on its own.
// Known AI tokens, long-name mapping, and loose rendering classification live
// in lib/agent-clients/tokens.ts (single source of truth shared with the
// write-side internal commands). Any other executor token (a human name,
// possibly CJK, or an unknown value) is rendered as human with a visible
// `(unknown)` marker.
const REVIEW_STAGE_PREFIXES: { prefix: string; stage: ReviewStage }[] = [
  { prefix: 'Review Analysis', stage: 'analysis' },
  { prefix: 'Review Plan', stage: 'plan' },
  { prefix: 'Review Code', stage: 'code' }
];

// Collapse a chronological entry list into per-step rows: a `[started]` marker
// opens a row, the next matching done entry fills it in place (FIFO per base
// action). Started-only rows stay in flight; done-only entries (legacy logs with
// no start marker) render as standalone rows. Result order = first-seen order,
// which is already ascending because `entries` is sorted ascending.
function countHumanDecisionsByStage(rows: LedgerRow[]): Map<ReviewStage, number> {
  const counts = new Map<ReviewStage, number>();
  for (const row of rows) {
    if (!isReviewStage(row.stage) || row.status !== 'needs-human-decision') continue;
    counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);
  }
  return counts;
}

function reviewStageForStep(step: string): ReviewStage | undefined {
  return REVIEW_STAGE_PREFIXES.find(({ prefix }) => step.startsWith(prefix))?.stage;
}

function splitArtifactSuffix(note: string): { verdict: string; suffix: string } {
  const arrow = note.indexOf(' → ');
  return arrow === -1 ? { verdict: note, suffix: '' } : { verdict: note.slice(0, arrow), suffix: note.slice(arrow) };
}

function fieldNumber(field: string, label: string): number | undefined {
  const trimmed = field.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) return undefined;
  if (trimmed.slice(0, colon).trim().toLowerCase() !== label) return undefined;
  const value = Number(trimmed.slice(colon + 1).trim());
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function humanValidationCount(note: string): number {
  const { verdict } = splitArtifactSuffix(note);
  for (const field of verdict.split(',')) {
    const value = fieldNumber(field, 'manual-validation');
    if (value !== undefined) return value;
  }
  return 0;
}

function isHumanCountField(field: string): boolean {
  return fieldNumber(field, 'manual-validation') !== undefined || fieldNumber(field, 'human-decision') !== undefined;
}

// A step is human-executed when its agent token is not a known AI token.
// Known long names (claude-code -> claude, gemini-cli -> gemini) classify as
// AI; empty or unknown tokens classify as non-AI (human).
export function isHumanAgent(agent: string): boolean {
  return classifyAgent(agent).status !== 'ai';
}

// Fold the two human counts into a review row's verdict NOTE: comma-joined, right
// after the blockers/major/minor list and before the ` → artifact` link, mirroring
// the review count line. Review done notes already carry `Manual-validation` as a
// source field, so build the final verdict field list once instead of cleaning a
// previously rendered string.
function foldHumanCounts(note: string, decisions: number, manualValidation: number): string {
  const { verdict, suffix } = splitArtifactSuffix(note);
  const fields = verdict
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '' && !isHumanCountField(field));
  const group = `Manual-validation: ${manualValidation}, Human-decision: ${decisions}`;
  return `${[...fields, group].join(', ')}${suffix}`;
}

function log(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  let scope;
  try { scope = parseTaskScope(args); } catch (error) {
    process.stderr.write(`ai task log: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; return;
  }
  if (scope.positionals.length > 1 || (scope.explicit && scope.positionals.length > 0)) {
    process.stderr.write('ai task log: task ref must be provided once\n'); process.exitCode = 1; return;
  }
  const resolved = resolveTaskContext(scope.taskRef ?? scope.positionals[0]);
  if (!resolved.ok) {
    process.stderr.write(`ai task log: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }
  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const { sectionFound, entries } = parseActivityLog(content);
  if (!sectionFound) {
    process.stderr.write(
      `ai task log: no activity log section ('## 活动日志' or '## Activity Log') found in task ${resolved.taskId}\n`
    );
    process.exitCode = 1;
    return;
  }
  if (entries.length === 0) {
    process.stderr.write(`ai task log: no activity log entries found in task ${resolved.taskId}\n`);
    process.exitCode = 1;
    return;
  }
  const steps = pairEntries(entries);
  const humanDecisionCounts = countHumanDecisionsByStage(parseLedger(content));
  const rows = steps.map((s, idx) => {
    const stage = reviewStageForStep(s.step);
    const note = stage
      ? foldHumanCounts(s.note, humanDecisionCounts.get(stage) ?? 0, humanValidationCount(s.note))
      : s.note;
    const { status, display } = classifyAgent(s.agent);
    const human = status !== 'ai';
    const agent = status === 'unknown' ? `${display} (unknown)` : display;
    const started = s.started || (human ? '-' : '');
    return [String(idx + 1), s.step, agent, started, s.done || (s.started ? '(in progress)' : ''), note];
  });
  for (const line of formatTable(TABLE_HEADERS, rows, { zebra: Boolean(process.stdout.isTTY) })) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`Total: ${steps.length} steps\n`);
}

export { log };
