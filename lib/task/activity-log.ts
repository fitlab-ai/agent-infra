import { scanVisibleMarkdown } from './markdown.ts';
import { artifactName, type ArtifactFamily } from './artifact-name.ts';
import { hasArtifactCompletionRecord, hasValidArtifactCompletion } from './completion-facts.ts';
const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}) — \*\*(.+?)\*\* by (.+?) — (.*)$/;
const STARTED_SUFFIX_RE = /\s*\[started\]\s*$/;
const ABORTED_SUFFIX_RE = /\s*\[aborted\]\s*$/;
const ATTEMPT_RE = /(?:^|;\s*)attempt=([A-Za-z0-9-]{8,64})(?:;|$)/;

type LogEntry = { time: string; step: string; agent: string; note: string };
type StepRow = { step: string; agent: string; started: string; done: string; note: string; attempt?: string };
type ActivityLogSection = { heading: string; body: string; entries: LogEntry[] };

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

function activityWarnings(content: string): { code: string; message: string }[] {
  const inspected = inspectActivityLog(content);
  if (!inspected.section) return [{ code: 'ACTIVITY_LOG_UNAVAILABLE', message: 'Activity Log is missing or ambiguous; repair the section to resume logging' }];
  if (inspected.invalidEntries.length) return [{ code: 'ACTIVITY_LOG_INVALID_ENTRIES', message: 'Activity Log contains malformed entries; repair the entries' }];
  return [];
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

function artifactRoundForStep(step: string): { family: ArtifactFamily; round: number } | null {
  const labels: Readonly<Record<string, ArtifactFamily>> = {
    'Analyze Task': 'analysis', 'Review Analysis': 'review-analysis', 'Plan Task': 'plan',
    'Review Plan': 'review-plan', 'Code Task': 'code', 'Review Code': 'review-code'
  };
  const match = /^(Analyze Task|Review Analysis|Plan Task|Review Plan|Code Task|Review Code) \(Round ([1-9]\d*)(?:, .*)?\)$/u.exec(step);
  const family = match && labels[match[1]!];
  return family && match ? { family, round: Number(match[2]) } : null;
}

function openLifecycleRows(content: string, taskDir: string, rows: StepRow[]): StepRow[] {
  return rows.filter((row) => {
    if (!row.started || row.done) return true;
    const identity = artifactRoundForStep(row.step);
    if (!identity) return true;
    const name = artifactName(identity.family, identity.round);
    const event = identity.family === 'analysis' ? 'analyze.completed' : `${identity.family}.completed`;
    if (!hasArtifactCompletionRecord(content, name, event)) return true;
    if (!hasValidArtifactCompletion(content, taskDir, name, event)) {
      throw new Error(`completion evidence for started ${identity.family} Round ${identity.round} is invalid`);
    }
    return false;
  });
}


export {
  activityAttempt,
  activityWarnings,
  appendActivityEntry,
  openLifecycleRows,
  inspectActivityLog,
  locateActivityLog,
  pairEntries,
  parseActivityLog,
  startedBackedRows
};
export type { ActivityLogSection, LogEntry, StepRow };
