const HEADING_RE = /^##\s+(活动日志|Activity Log)\s*$/;
const NEXT_H2_RE = /^##\s/;
const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) — \*\*(.+?)\*\* by (.+?) — (.*)$/;
const STARTED_SUFFIX_RE = /\s*\[started\]\s*$/;

type LogEntry = { time: string; step: string; agent: string; note: string };
type StepRow = { step: string; agent: string; started: string; done: string; note: string };
type ActivityLogSection = { heading: string; body: string; entries: LogEntry[] };

function parseActivityLog(content: string): { sectionFound: boolean; entries: LogEntry[] } {
  const section = locateActivityLog(content);
  return section ? { sectionFound: true, entries: section.entries } : { sectionFound: false, entries: [] };
}

function locateActivityLog(content: string): ActivityLogSection | null {
  const lines = content.split('\n');
  const headings = lines.map((line, index) => HEADING_RE.test(line) ? index : -1).filter((index) => index >= 0);
  if (headings.length !== 1) return null;
  const i = headings[0]!;
  let end = lines.length;
  for (let j = i + 1; j < lines.length; j += 1) {
    if (NEXT_H2_RE.test(lines[j]!)) { end = j; break; }
  }
  const bodyLines = lines.slice(i + 1, end);
  const parsed: { entry: LogEntry; epoch: number; order: number }[] = [];
  for (const line of bodyLines) {
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    parsed.push({ entry: { time: m[1]!, step: m[2]!, agent: m[3]!, note: m[4]! }, epoch: Date.parse(m[1]!.replace(' ', 'T')), order: parsed.length });
  }
  parsed.sort((a, b) => a.epoch - b.epoch || a.order - b.order);
  return { heading: HEADING_RE.exec(lines[i]!)![1]!, body: bodyLines.join('\n').replace(/^\n+|\n+$/g, ''), entries: parsed.map((item) => item.entry) };
}

function appendActivityEntry(section: ActivityLogSection, entry: LogEntry): string {
  const line = `- ${entry.time} — **${entry.step}** by ${entry.agent} — ${entry.note}`;
  return section.body ? `${section.body}\n${line}` : line;
}

function pairEntries(entries: LogEntry[]): StepRow[] {
  const rows: StepRow[] = [];
  const open = new Map<string, StepRow[]>();
  for (const entry of entries) {
    const started = STARTED_SUFFIX_RE.test(entry.step);
    const base = entry.step.replace(STARTED_SUFFIX_RE, '');
    if (started) {
      const row = { step: base, agent: entry.agent, started: entry.time, done: '', note: entry.note };
      rows.push(row);
      const queue = open.get(base) ?? [];
      queue.push(row);
      open.set(base, queue);
    } else {
      const pending = open.get(base)?.shift();
      if (pending) Object.assign(pending, { done: entry.time, agent: entry.agent, note: entry.note });
      else rows.push({ step: base, agent: entry.agent, started: '', done: entry.time, note: entry.note });
    }
  }
  return rows;
}

export { parseActivityLog, locateActivityLog, appendActivityEntry, pairEntries };
export type { LogEntry, StepRow, ActivityLogSection };
