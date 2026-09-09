import { scanVisibleMarkdown } from './markdown.ts';
const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) — \*\*(.+?)\*\* by (.+?) — (.*)$/;
const STARTED_SUFFIX_RE = /\s*\[started\]\s*$/;
const ABORTED_SUFFIX_RE = /\s*\[aborted\]\s*$/;
const ATTEMPT_RE = /(?:^|;\s*)attempt=([A-Za-z0-9-]{8,64})(?:;|$)/;
const COMMIT_STARTED_RE = /^started; attempt=([A-Za-z0-9-]{8,64}); baseline=([a-f0-9]{40,64}); agent=([a-z-]+)$/;
const LIFECYCLE_STEP_RE = /^(?:Complete Manual Validation|(?:Analyze Task|Review Analysis|Plan Task|Review Plan|Code Task|Review Code|Run Manual Validation) \(Round [1-9]\d*(?:(?:, fix for review-code(?:-r[2-9]|-r[1-9]\d+)?\.md)|(?:, decision II-[1-9]\d*))?\))$/;

type LogEntry = { time: string; step: string; agent: string; note: string };
type StepRow = { step: string; agent: string; started: string; done: string; note: string; attempt?: string };
type ActivityLogSection = { heading: string; body: string; entries: LogEntry[] };
type CommitAttempt = Readonly<{ attempt: string; baseline: string; agent: string }>;

function parseActivityLog(content: string): { sectionFound: boolean; entries: LogEntry[] } {
  const section = locateActivityLog(content);
  return section ? { sectionFound: true, entries: section.entries } : { sectionFound: false, entries: [] };
}

/** Returns source-order entries and malformed bullets without applying display or gate policy. */
function inspectActivityLog(content: string): { section: ActivityLogSection | null; invalidEntries: string[] } {
  const scanned = scanVisibleMarkdown(content);
  const headings = scanned.headings.filter((heading) => heading.level === 2);
  const matches = headings.filter((heading) => heading.text === '活动日志' || heading.text === 'Activity Log');
  if (matches.length !== 1) return { section: null, invalidEntries: [] };
  const heading = matches[0]!;
  const end = headings.find((candidate) => candidate.start > heading.start)?.start ?? content.length;
  const entries: LogEntry[] = [];
  const invalidEntries: string[] = [];
  for (const line of scanned.lines) {
    if (line.start <= heading.end || line.start >= end) continue;
    const text = line.text.trimStart();
    const match = ENTRY_RE.exec(text);
    if (match) entries.push({ time: match[1]!, step: match[2]!, agent: match[3]!, note: match[4]! });
    else if (text.startsWith('- ')) invalidEntries.push(text);
  }
  const body = content.slice(heading.end + 1, end).replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
  return { section: { heading: heading.text, body, entries }, invalidEntries };
}

function locateActivityLog(content: string): ActivityLogSection | null {
  const { section } = inspectActivityLog(content);
  if (!section) return null;
  section.entries.sort((left, right) => Date.parse(left.time.replace(' ', 'T')) - Date.parse(right.time.replace(' ', 'T')));
  return section;
}

function appendActivityEntry(section: ActivityLogSection, entry: LogEntry): string {
  const line = `- ${entry.time} — **${entry.step}** by ${entry.agent} — ${entry.note}`;
  return section.body ? `${section.body}\n${line}` : line;
}

function activityAttempt(note: string): string | null {
  return ATTEMPT_RE.exec(note)?.[1] ?? null;
}

function parseCommitAttemptStarted(note: string): CommitAttempt | null {
  const match = COMMIT_STARTED_RE.exec(note);
  return match ? { attempt: match[1]!, baseline: match[2]!, agent: match[3]! } : null;
}

function commitAttemptStartedNote(attempt: CommitAttempt): string {
  return `started; attempt=${attempt.attempt}; baseline=${attempt.baseline}; agent=${attempt.agent}`;
}

function pairEntries(entries: LogEntry[]): StepRow[] {
  const rows: StepRow[] = [];
  const open = new Map<string, StepRow[]>();
  for (const entry of entries) {
    const started = STARTED_SUFFIX_RE.test(entry.step);
    const aborted = ABORTED_SUFFIX_RE.test(entry.step);
    const base = entry.step.replace(STARTED_SUFFIX_RE, '').replace(ABORTED_SUFFIX_RE, '');
    if (started) {
      const attempt = activityAttempt(entry.note);
      const row: StepRow = {
        step: base, agent: entry.agent, started: entry.time, done: '', note: entry.note,
        ...(attempt ? { attempt } : {})
      };
      rows.push(row);
      const queue = open.get(base) ?? [];
      queue.push(row);
      open.set(base, queue);
    } else {
      const queue = open.get(base) ?? [];
      const terminalAttempt = aborted ? activityAttempt(entry.note) : null;
      const pendingIndex = terminalAttempt === null
        ? 0
        : queue.findIndex((row) => row.attempt === terminalAttempt);
      const pending = pendingIndex >= 0 ? queue.splice(pendingIndex, 1)[0] : undefined;
      if (pending) Object.assign(pending, { done: entry.time, agent: entry.agent, note: entry.note });
      else rows.push({
        step: aborted ? entry.step : base,
        agent: entry.agent, started: '', done: entry.time, note: entry.note,
        ...(terminalAttempt ? { attempt: terminalAttempt } : {})
      });
    }
  }
  return rows;
}

function startedBackedRows(rows: StepRow[]): StepRow[] {
  return rows.filter((row) => row.started !== '');
}

function hasOpenLifecycleExecution(content: string): boolean {
  const section = locateActivityLog(content);
  if (!section) return false;
  return pairEntries(section.entries).some((row) => row.done === '' && LIFECYCLE_STEP_RE.test(row.step));
}

export {
  activityAttempt,
  appendActivityEntry,
  hasOpenLifecycleExecution,
  commitAttemptStartedNote,
  inspectActivityLog,
  locateActivityLog,
  pairEntries,
  parseActivityLog,
  parseCommitAttemptStarted,
  startedBackedRows
};
export type { ActivityLogSection, CommitAttempt, LogEntry, StepRow };
