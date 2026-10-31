import { sha256 } from './store.ts';

import type { CapturedObject, JsonValue, NormalizedKind, NormalizedRecord } from './types.ts';

const TASK_ID_RE = /TASK-\d{8}-\d{6}/;

function recordId(kind: NormalizedKind, identity: string, suffix = ''): string {
  return `${kind}:${sha256(`${identity}\0${suffix}`).slice(0, 24)}`;
}

function normalizeResources(objects: CapturedObject[]): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];
  for (const object of objects) {
    if (object.role !== 'resource') continue;
    const identity = object.resourceIdentity ?? object.sourceIdentity;
    let data: JsonValue;
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

export { normalizeResources };
