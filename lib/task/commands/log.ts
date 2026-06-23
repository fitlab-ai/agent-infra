import fs from 'node:fs';
import { formatTable } from '../../table.ts';
import { resolveTaskRef } from '../resolve-ref.ts';

const USAGE = `Usage: ai task log <N | #N | TASK-id>

Renders a task's activity log as a per-step status table. A step's start and
completion are paired onto one row: STARTED holds the start time, DONE the
completion time (or '(in progress)' while still running).
  <ref>   Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.

Columns: # (row) / STEP / AGENT / STARTED / DONE / NOTE
  A human-executed step shows AGENT as 'human' and, when it has no start marker,
  a '-' STARTED placeholder. Review-step NOTE also carries two human counts in
  the verdict list, right after blockers/major/minor: manual-verify (env-blocked)
  and human-decision (current ledger stage total).
`;

const TABLE_HEADERS = ['#', 'STEP', 'AGENT', 'STARTED', 'DONE', 'NOTE'] as const;

// The activity-log H2 heading is language-dependent (zh template / en template).
const HEADING_RE = /^##\s+(活动日志|Activity Log)\s*$/;
const LEDGER_HEADING_RE = /^##\s+(审查分歧账本|Review Disagreement Ledger)\s*$/;
const NEXT_H2_RE = /^##\s/;
// `- {time} — **{step}** by {agent} — {note}` ; the separator is an em-dash
// (U+2014). STEP/AGENT are non-greedy so a note that itself contains ' — ' or
// '→' is not mis-split; NOTE greedily takes the rest of the line.
const ENTRY_RE =
  /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) — \*\*(.+?)\*\* by (.+?) — (.*)$/;

type LogEntry = { time: string; step: string; agent: string; note: string };
type ReviewStage = 'analysis' | 'plan' | 'code';
type LedgerRow = { stage: string; status: string };

// One rendered row = one step instance. `started`/`done` are timestamps; an empty
// `done` with a non-empty `started` means the step is still in flight, while an
// empty `started` is a historical done-only entry (no start marker was written).
type StepRow = { step: string; agent: string; started: string; done: string; note: string };

// A start marker reuses the normal entry grammar and only suffixes its action
// with ` [started]`; the matching done entry carries the identical base action
// without the suffix. Pairing therefore keys on the base action (including any
// `(Round N)`), so every round and every repeated execution pairs on its own.
const STARTED_SUFFIX_RE = /\s*\[started\]\s*$/;
// Short agent tokens that actually appear in activity logs for AI executors
// (workflow recommended_agents claude/codex/gemini/cursor + enabled TUI opencode;
// note these differ from the `.airc.json` long names claude-code/gemini-cli).
// Any other executor token (a human name, possibly CJK) is treated as human.
const KNOWN_AI_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode', 'cursor']);
const HUMAN_DECISION_STATUSES = new Set(['needs-human-decision', 'human-decided']);
const ENV_BLOCKED_RE = /\(\+\s*(\d+)\s+env-blocked\)/i;
// Same match plus any leading whitespace, so folding the count into the verdict
// text drops the redundant `(+ n env-blocked)` fragment without leaving a gap.
const ENV_BLOCKED_STRIP_RE = /\s*\(\+\s*\d+\s+env-blocked\)/i;
const REVIEW_STAGE_PREFIXES: { prefix: string; stage: ReviewStage }[] = [
  { prefix: 'Review Analysis', stage: 'analysis' },
  { prefix: 'Review Plan', stage: 'plan' },
  { prefix: 'Review Code', stage: 'code' }
];

function parseActivityLog(content: string): { sectionFound: boolean; entries: LogEntry[] } {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !HEADING_RE.test(lines[i]!)) i += 1;
  if (i >= lines.length) return { sectionFound: false, entries: [] };
  const parsed: { entry: LogEntry; epoch: number; order: number }[] = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (NEXT_H2_RE.test(lines[j]!)) break;
    const m = ENTRY_RE.exec(lines[j]!);
    if (!m) continue; // skip blank / non-entry / malformed lines
    parsed.push({
      entry: { time: m[1]!, step: m[2]!, agent: m[3]!, note: m[4]! },
      epoch: Date.parse(m[1]!.replace(' ', 'T')),
      order: parsed.length
    });
  }
  // Ascending by time; stable tie-break on original order for equal timestamps.
  parsed.sort((a, b) => a.epoch - b.epoch || a.order - b.order);
  return { sectionFound: true, entries: parsed.map((p) => p.entry) };
}

// Collapse a chronological entry list into per-step rows: a `[started]` marker
// opens a row, the next matching done entry fills it in place (FIFO per base
// action). Started-only rows stay in flight; done-only entries (legacy logs with
// no start marker) render as standalone rows. Result order = first-seen order,
// which is already ascending because `entries` is sorted ascending.
function pairEntries(entries: LogEntry[]): StepRow[] {
  const rows: StepRow[] = [];
  const open = new Map<string, StepRow[]>();
  for (const e of entries) {
    const isStarted = STARTED_SUFFIX_RE.test(e.step);
    const base = e.step.replace(STARTED_SUFFIX_RE, '');
    if (isStarted) {
      const row: StepRow = { step: base, agent: e.agent, started: e.time, done: '', note: e.note };
      rows.push(row);
      const queue = open.get(base);
      if (queue) queue.push(row);
      else open.set(base, [row]);
    } else {
      const pending = open.get(base)?.shift();
      if (pending) {
        // Done fills the open row; the done entry carries the meaningful note.
        pending.done = e.time;
        pending.agent = e.agent;
        pending.note = e.note;
      } else {
        rows.push({ step: base, agent: e.agent, started: '', done: e.time, note: e.note });
      }
    }
  }
  return rows;
}

function parseReviewLedger(content: string): LedgerRow[] {
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
    if (cells.length < 6 || cells[0] === 'id' || /^-+$/.test(cells[0] ?? '')) continue;
    rows.push({ stage: cells[1]!, status: cells[4]! });
  }
  return rows;
}

function countHumanDecisionsByStage(rows: LedgerRow[]): Map<ReviewStage, number> {
  const counts = new Map<ReviewStage, number>();
  for (const row of rows) {
    if (!isReviewStage(row.stage) || !HUMAN_DECISION_STATUSES.has(row.status)) continue;
    counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);
  }
  return counts;
}

function isReviewStage(stage: string): stage is ReviewStage {
  return stage === 'analysis' || stage === 'plan' || stage === 'code';
}

function reviewStageForStep(step: string): ReviewStage | undefined {
  return REVIEW_STAGE_PREFIXES.find(({ prefix }) => step.startsWith(prefix))?.stage;
}

function humanValidationCount(note: string): number {
  const match = ENV_BLOCKED_RE.exec(note);
  return match ? Number(match[1]) : 0;
}

// A step is human-executed when its agent token is not a known AI token. Take
// the first whitespace-delimited token and drop any trailing parenthetical
// annotation (e.g. `张三 (executed on host)` -> `张三`) before the lookup.
function isHumanAgent(agent: string): boolean {
  const token = agent.trim().split(/\s+/)[0]?.replace(/\(.*$/, '') ?? '';
  return token !== '' && !KNOWN_AI_AGENTS.has(token);
}

// Fold the two human counts into a review row's verdict NOTE: comma-joined, right
// after the blockers/major/minor list and before the ` → artifact` link, mirroring
// the review count line. The raw `(+ n env-blocked)` fragment is dropped so the
// env-blocked number is not shown twice (it becomes the manual-verify count).
function foldHumanCounts(note: string, decisions: number, envBlocked: number): string {
  const base = note.replace(ENV_BLOCKED_STRIP_RE, '');
  const group = `Manual-verify: ${envBlocked}, Human-decision: ${decisions}`;
  const arrow = base.indexOf(' → ');
  return arrow === -1 ? `${base}, ${group}` : `${base.slice(0, arrow)}, ${group}${base.slice(arrow)}`;
}

function log(args: string[] = []): void {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    if (args.length === 0) process.exitCode = 1;
    return;
  }
  const resolved = resolveTaskRef(args[0]!);
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
  const humanDecisionCounts = countHumanDecisionsByStage(parseReviewLedger(content));
  const rows = steps.map((s, idx) => {
    const stage = reviewStageForStep(s.step);
    const note = stage
      ? foldHumanCounts(s.note, humanDecisionCounts.get(stage) ?? 0, humanValidationCount(s.note))
      : s.note;
    const human = isHumanAgent(s.agent);
    const agent = human ? 'human' : s.agent;
    const started = s.started || (human ? '-' : '');
    return [String(idx + 1), s.step, agent, started, s.done || (s.started ? '(in progress)' : ''), note];
  });
  for (const line of formatTable(TABLE_HEADERS, rows, { zebra: Boolean(process.stdout.isTTY) })) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`Total: ${steps.length} steps\n`);
}

export { log, parseActivityLog, pairEntries, isHumanAgent };
