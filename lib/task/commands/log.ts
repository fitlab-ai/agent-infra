import fs from 'node:fs';
import { formatTable } from '../../table.ts';
import { resolveTaskRef } from '../resolve-ref.ts';

const USAGE = `Usage: ai task log <N | #N | TASK-id>

Renders a task's activity log as a chronological timeline table.
  <ref>   Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.

Columns: # (timeline position) / TIME / STEP / AGENT / NOTE
`;

const TABLE_HEADERS = ['#', 'TIME', 'STEP', 'AGENT', 'NOTE'] as const;

// The activity-log H2 heading is language-dependent (zh template / en template).
const HEADING_RE = /^##\s+(活动日志|Activity Log)\s*$/;
const NEXT_H2_RE = /^##\s/;
// `- {time} — **{step}** by {agent} — {note}` ; the separator is an em-dash
// (U+2014). STEP/AGENT are non-greedy so a note that itself contains ' — ' or
// '→' is not mis-split; NOTE greedily takes the rest of the line.
const ENTRY_RE =
  /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) — \*\*(.+?)\*\* by (.+?) — (.*)$/;

type LogEntry = { time: string; step: string; agent: string; note: string };

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
  const rows = entries.map((e, idx) => [String(idx + 1), e.time, e.step, e.agent, e.note]);
  for (const line of formatTable(TABLE_HEADERS, rows, { zebra: Boolean(process.stdout.isTTY) })) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`Total: ${entries.length} entries\n`);
}

export { log, parseActivityLog };
