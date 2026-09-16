import { createHash } from 'node:crypto';

import { locateActivityLog } from '../task/activity-log.ts';
import type { LogEntry } from '../task/activity-log.ts';

const METADATA_PREFIX = '<!-- activity-recovery:v1:';
const METADATA_SUFFIX = ' -->';

type ActivityRecoveryRecord = {
  version: 1;
  taskId: string;
  artifact?: string;
  entries: LogEntry[];
  sha256: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function baseStep(step: string): string {
  return step.replace(/\s*\[(?:started|aborted)\]\s*$/, '');
}

function entriesForArtifact(taskContent: string, artifact: string): LogEntry[] {
  const log = locateActivityLog(taskContent);
  if (!log) return [];
  const selected = new Set<number>();
  for (let index = 0; index < log.entries.length; index += 1) {
    const entry = log.entries[index]!;
    if (!entry.note.includes(`→ ${artifact}`)) continue;
    selected.add(index);
    const step = baseStep(entry.step);
    let startedAt = index;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const candidate = log.entries[prior]!;
      if (baseStep(candidate.step) !== step) continue;
      if (/\[started\]\s*$/.test(candidate.step)) {
        selected.add(prior);
        startedAt = prior;
      }
      break;
    }
    if (/^code(?:-r\d+)?\.md$/.test(artifact)) {
      for (let between = startedAt + 1; between < index; between += 1) {
        if (baseStep(log.entries[between]!.step) === 'Commit') selected.add(between);
      }
    }
  }
  return log.entries.filter((_entry, index) => selected.has(index));
}

function recordForEntries(taskId: string, entries: readonly LogEntry[], artifact?: string): ActivityRecoveryRecord | null {
  if (entries.length === 0) return null;
  const base = { version: 1 as const, taskId, ...(artifact ? { artifact } : {}), entries: [...entries] };
  return { ...base, sha256: sha256(base) };
}

function recordForArtifact(taskId: string, taskContent: string, artifact: string): ActivityRecoveryRecord | null {
  return recordForEntries(taskId, entriesForArtifact(taskContent, artifact), artifact);
}

function entriesForTask(taskContent: string): LogEntry[] {
  const log = locateActivityLog(taskContent);
  if (!log) return [];
  const linked = new Set(entriesForArtifactNames(log.entries));
  return log.entries.filter((entry, index) => !linked.has(index)
    && !['Create PR', 'Complete Task', 'Cancel Task'].includes(baseStep(entry.step)));
}

function entriesForSummary(taskContent: string): LogEntry[] {
  const log = locateActivityLog(taskContent);
  return log?.entries.filter((entry) => ['Create PR', 'Complete Task'].includes(baseStep(entry.step))) ?? [];
}

function entriesForCancel(taskContent: string): LogEntry[] {
  const log = locateActivityLog(taskContent);
  return log?.entries.filter((entry) => baseStep(entry.step) === 'Cancel Task') ?? [];
}

function recordForTask(taskId: string, taskContent: string): ActivityRecoveryRecord | null {
  return recordForEntries(taskId, entriesForTask(taskContent));
}

function recordForSummary(taskId: string, taskContent: string): ActivityRecoveryRecord | null {
  return recordForEntries(taskId, entriesForSummary(taskContent));
}

function recordForCancel(taskId: string, taskContent: string): ActivityRecoveryRecord | null {
  return recordForEntries(taskId, entriesForCancel(taskContent));
}

function entriesForArtifactNames(entries: readonly LogEntry[]): number[] {
  const selected = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const artifact = /→ ([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:\s|$)/.exec(entry.note)?.[1];
    if (!artifact) continue;
    selected.add(index);
    const step = baseStep(entry.step);
    let startedAt = index;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      const candidate = entries[prior]!;
      if (baseStep(candidate.step) !== step) continue;
      if (/\[started\]\s*$/.test(candidate.step)) {
        selected.add(prior);
        startedAt = prior;
      }
      break;
    }
    if (/^code(?:-r\d+)?\.md$/.test(artifact)) {
      for (let between = startedAt + 1; between < index; between += 1) {
        if (baseStep(entries[between]!.step) === 'Commit') selected.add(between);
      }
    }
  }
  return [...selected];
}

function renderActivityRecoveryMetadata(record: ActivityRecoveryRecord | null): string {
  if (!record) return '';
  const encoded = Buffer.from(canonicalJson(record), 'utf8').toString('base64url');
  const first = record.entries[0]!;
  const last = record.entries.at(-1)!;
  return [
    '<details><summary>恢复元数据</summary>',
    '',
    `- 动作：${baseStep(last.step)}`,
    `- 记录：${record.entries.length} 条（${first.time} 至 ${last.time}）`,
    ...(record.artifact ? [`- 产物：${record.artifact}`] : []),
    `- 校验：\`${record.sha256}\``,
    '',
    `${METADATA_PREFIX}${encoded}${METADATA_SUFFIX}`,
    '</details>',
    ''
  ].join('\n');
}

function parseActivityRecoveryMetadata(body: string): ActivityRecoveryRecord | null {
  const match = body.match(/<!-- activity-recovery:v1:([A-Za-z0-9_-]+) -->/);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')); }
  catch { throw new Error('RECOVERY_EVIDENCE_MISSING: activity metadata is not valid'); }
  if (!value || typeof value !== 'object') throw new Error('RECOVERY_EVIDENCE_MISSING: activity metadata is invalid');
  const record = value as Partial<ActivityRecoveryRecord>;
  if (record.version !== 1 || typeof record.taskId !== 'string' || (record.artifact !== undefined && typeof record.artifact !== 'string')
    || !Array.isArray(record.entries) || typeof record.sha256 !== 'string') {
    throw new Error('RECOVERY_EVIDENCE_MISSING: activity metadata shape is invalid');
  }
  if (record.entries.some((entry) => !entry || typeof entry.time !== 'string' || typeof entry.step !== 'string' || typeof entry.agent !== 'string' || typeof entry.note !== 'string')) {
    throw new Error('RECOVERY_EVIDENCE_MISSING: activity metadata entries are invalid');
  }
  const base = { version: 1 as const, taskId: record.taskId, ...(record.artifact ? { artifact: record.artifact } : {}), entries: record.entries as LogEntry[] };
  if (sha256(base) !== record.sha256) throw new Error('RECOVERY_EVIDENCE_MISSING: activity metadata checksum does not match');
  return { ...base, sha256: record.sha256 };
}

export {
  entriesForArtifact,
  entriesForCancel,
  entriesForSummary,
  entriesForTask,
  parseActivityRecoveryMetadata,
  recordForArtifact,
  recordForCancel,
  recordForEntries,
  recordForSummary,
  recordForTask,
  renderActivityRecoveryMetadata
};
export type { ActivityRecoveryRecord };
