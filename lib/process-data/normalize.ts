import { sha256 } from './store.ts';

import type { CapturedObject, JsonValue, NormalizedKind, NormalizedRecord } from './types.ts';

const TASK_ID_RE = /TASK-\d{8}-\d{6}/;
const ACTIVITY_RE = /^- (\d{4}-\d{2}-\d{2} [^ ]+) — \*\*(.+?)\*\* by ([^ ]+) — (.+)$/gm;
const LEDGER_RE = /^\|\s*((?:AN|PL|CD)-\d+)\s*\|\s*(analysis|plan|code)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm;
const RULING_RE = /^###\s+(HDR-\d+)\s*$([\s\S]*?)(?=^###\s+|^##\s+|(?![\s\S]))/gm;
const CONFLICT_STATUSES = new Set(['open', 'accepted', 'adjusted', 'refuted', 'cannot-judge', 'needs-human-decision']);

function recordId(kind: NormalizedKind, identity: string, suffix = ''): string {
  return `${kind}:${sha256(`${identity}\0${suffix}`).slice(0, 24)}`;
}

function canonicalActor(raw: string): string | null {
  const lowered = raw.toLowerCase();
  const aliases: Record<string, string> = {
    'claude-code': 'claude',
    'antigravity-cli': 'antigravity',
    'gemini-cli': 'gemini',
    gemini: 'gemini'
  };
  if (['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'human'].includes(lowered)) return lowered;
  return aliases[lowered] ?? null;
}

function nextOccurrence(occurrences: Map<string, number>, identity: string): string {
  const occurrence = (occurrences.get(identity) ?? 0) + 1;
  occurrences.set(identity, occurrence);
  return occurrence === 1 ? '' : `occurrence=${occurrence}`;
}

function normalizePlatformPage(object: CapturedObject): NormalizedRecord[] {
  if (!object.content) return [];
  try {
    const page = JSON.parse(object.content) as unknown;
    if (!Array.isArray(page)) return [];
    return page.map((entry, index) => {
      const value = entry as Record<string, unknown>;
      const identity = String(value.id ?? value.node_id ?? value.sha ?? value.number ?? `${object.sourceIdentity}:${index}`);
      const platformIdentity = /\/issues\?/.test(object.sourceIdentity) && typeof value.number === 'number'
        ? `issue:${value.number}`
        : /\/pulls\?/.test(object.sourceIdentity) && typeof value.number === 'number'
          ? `pr:${value.number}`
          : /\/issues\/\d+\/comments/.test(object.sourceIdentity)
            ? `issue-comment:${identity}`
            : /\/pulls\/\d+\/reviews/.test(object.sourceIdentity)
              ? `review:${identity}`
              : /\/pulls\/\d+\/commits/.test(object.sourceIdentity)
                ? `commit:${identity}`
                : `platform:${identity}`;
      const binding = typeof value.body === 'string' ? value.body.match(TASK_ID_RE)?.[0] : undefined;
      return {
        recordId: recordId('platform-resource', object.sourceIdentity, identity),
        kind: 'platform-resource',
        sourceIdentity: platformIdentity,
        sourceSha256: object.sha256,
        ...(binding ? { binding } : {}),
        data: entry as JsonValue
      };
    });
  } catch {
    return [];
  }
}

function normalizeObjects(objects: CapturedObject[]): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];
  for (const object of objects) {
    if (object.disposition?.state && object.disposition.state !== 'included') {
      records.push({
        recordId: recordId('missing', object.sourceIdentity),
        kind: 'missing',
        sourceIdentity: object.sourceIdentity,
        sourceSha256: object.sha256,
        data: object.disposition.state === 'excluded-sensitive'
          ? { reason: 'privacy-excluded', ruleId: object.disposition.ruleId }
          : { reason: object.disposition.reason }
      });
      continue;
    }
    if (object.sourceKind === 'github-rest') {
      records.push(...normalizePlatformPage(object));
      continue;
    }
    if (object.sourceKind === 'operational-report') {
      records.push({
        recordId: recordId('operational-report', object.sourceIdentity),
        kind: 'operational-report',
        sourceIdentity: object.sourceIdentity,
        sourceSha256: object.sha256
      });
      continue;
    }
    if (object.sourceKind === 'structured-telemetry') {
      let data: JsonValue = { availability: 'unknown' };
      try {
        data = JSON.parse(object.content ?? '{}') as JsonValue;
      } catch {
        data = { availability: 'unavailable', reason: 'invalid receipt JSON' };
      }
      records.push({
        recordId: recordId('telemetry', object.sourceIdentity),
        kind: 'telemetry',
        sourceIdentity: object.sourceIdentity,
        sourceSha256: object.sha256,
        data
      });
      continue;
    }

    const taskId = object.sourceIdentity.match(TASK_ID_RE)?.[0];
    if (/\/task\.md$/.test(object.sourceIdentity) && taskId) {
      const activityOccurrences = new Map<string, number>();
      const findingOccurrences = new Map<string, number>();
      const issueNumber = object.content?.match(/^issue_number:\s*(\d+)$/m)?.[1];
      const agentInfraVersion = object.content?.match(/^agent_infra_version:\s*(\S+)$/m)?.[1];
      records.push({
        recordId: recordId('task', taskId),
        kind: 'task',
        sourceIdentity: taskId,
        sourceSha256: object.sha256,
        ...(issueNumber ? { binding: `issue:${issueNumber}` } : {}),
        data: {
          agentInfraVersion: agentInfraVersion
            ? { state: 'known', value: agentInfraVersion }
            : { state: 'unknown', reason: 'legacy-task-missing-agent-infra-version' }
        }
      });
      for (const match of object.content?.matchAll(ACTIVITY_RE) ?? []) {
        const rawActor = match[3]!;
        const identity = `${match[1]}:${match[2]}`;
        const occurrence = nextOccurrence(activityOccurrences, identity);
        records.push({
          recordId: recordId('lifecycle-event', taskId, occurrence ? `${identity}\0${occurrence}` : identity),
          kind: 'lifecycle-event',
          sourceIdentity: `${taskId}#activity=${match[1]}`,
          sourceSha256: object.sha256,
          data: {
            timestamp: match[1]!,
            action: match[2]!,
            actorRaw: rawActor,
            actorCanonical: canonicalActor(rawActor),
            note: match[4]!
          }
        });
      }
      for (const match of object.content?.matchAll(LEDGER_RE) ?? []) {
        const findingId = match[1]!.trim();
        const stage = match[2]!.trim();
        const round = match[3]!.trim();
        const severity = match[4]!.trim();
        const status = match[5]!.trim();
        const evidence = match[6]!.trim();
        const identity = `${taskId}#finding=${findingId}`;
        const occurrence = nextOccurrence(findingOccurrences, identity);
        const data = { findingId, stage, round, severity, status, evidence };
        records.push({
          recordId: recordId('review-finding', identity, occurrence),
          kind: 'review-finding',
          sourceIdentity: identity,
          sourceSha256: object.sha256,
          binding: taskId,
          data
        });
        if (status && CONFLICT_STATUSES.has(status)) {
          records.push({
            recordId: recordId('conflict', identity, occurrence),
            kind: 'conflict',
            sourceIdentity: `${identity}#status=${status}`,
            sourceSha256: object.sha256,
            binding: taskId,
            data
          });
        }
      }
      for (const match of object.content?.matchAll(RULING_RE) ?? []) {
        const rulingId = match[1]!;
        const identity = `${taskId}#ruling=${rulingId}`;
        records.push({
          recordId: recordId('human-ruling', identity),
          kind: 'human-ruling',
          sourceIdentity: identity,
          sourceSha256: object.sha256,
          binding: taskId,
          data: { rulingId, evidence: match[2]!.trim() }
        });
      }
      continue;
    }
    records.push({
      recordId: recordId('artifact', object.sourceIdentity),
      kind: 'artifact',
      sourceIdentity: object.sourceIdentity,
      sourceSha256: object.sha256,
      ...(taskId ? { binding: taskId } : {})
    });
  }
  return records.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function normalizeResources(objects: CapturedObject[]): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];
  for (const object of objects) {
    if (object.role !== 'resource') continue;
    const identity = object.resourceIdentity ?? object.sourceIdentity;
    let data: JsonValue = { availability: 'unknown' };
    try { data = JSON.parse(object.content ?? '{}') as JsonValue; } catch { data = { availability: 'unavailable', reason: 'invalid resource JSON' }; }
    const binding = typeof data === 'object' && data !== null && !Array.isArray(data) && typeof data.body === 'string'
      ? data.body.match(TASK_ID_RE)?.[0]
      : undefined;
    records.push({
      recordId: recordId('platform-resource', identity),
      kind: 'platform-resource',
      sourceIdentity: identity,
      resourceIdentity: identity,
      sourceSha256: object.sha256,
      ...(binding ? { binding } : {}),
      ...(object.eventTime ? { observedAt: { state: 'known', value: object.eventTime } } : {}),
      ...(object.parentIdentity ? { parentIdentity: object.parentIdentity } : {}),
      ...(object.pageSha256 ? {
        evidence: [{ resourceIdentity: identity, resourceSha256: object.sha256, pageSha256: object.pageSha256 }]
      } : {}),
      data
    });
  }
  return records.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

export { normalizeObjects, normalizeResources };
