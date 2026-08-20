import { sha256 } from './store.ts';

import type { NormalizedRecord, QualityFinding, RepairAction, SnapshotManifest, SnapshotOperations } from './types.ts';

function reconcileRecords(
  records: NormalizedRecord[],
  scope: SnapshotManifest['scope']
): { findings: QualityFinding[]; repairs: RepairAction[] } {
  const findings: QualityFinding[] = [];
  const repairs: RepairAction[] = [];
  const findingKeys = new Set<string>();
  const addFinding = (
    category: QualityFinding['category'],
    severity: QualityFinding['severity'],
    identities: string[],
    repairable: boolean,
    reason: string
  ) => {
    const sortedIdentities = [...identities].sort();
    const key = `${category}:${sortedIdentities.join('\0')}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push({
      findingId: `quality:${sha256(key).slice(0, 20)}`,
      category,
      severity,
      identities: sortedIdentities,
      repairable,
      reason
    });
  };
  const byIdentity = new Map<string, NormalizedRecord[]>();
  for (const record of records) {
    const group = byIdentity.get(record.sourceIdentity) ?? [];
    group.push(record);
    byIdentity.set(record.sourceIdentity, group);
    if (
      record.kind === 'missing' &&
      record.data !== null &&
      typeof record.data === 'object' &&
      !Array.isArray(record.data) &&
      record.data.reason === 'privacy-excluded'
    ) {
      addFinding('privacy-excluded', 'warning', [record.sourceIdentity], false, 'Sensitive content was excluded by policy');
    } else if (record.kind === 'missing') {
      addFinding('unrecoverable', 'info', [record.sourceIdentity], false, 'Source body is unavailable under the capture policy');
    }
  }

  for (const [identity, group] of byIdentity) {
    if (group.length < 2) continue;
    addFinding('duplicate-identity', 'error', group.map((record) => record.recordId), false, 'Multiple records claim the same stable identity');
    if (group.some((record) => record.kind === 'platform-resource') && new Set(group.map((record) => record.sourceSha256)).size > 1) {
      addFinding('mutable-remote', 'warning', group.map((record) => record.recordId), false, `Remote identity changed content: ${identity}`);
    }
  }

  const tasks = records.filter((record) => record.kind === 'task');
  const resources = records.filter((record) => record.kind === 'platform-resource');
  const taskByIdentity = new Map(tasks.map((task) => [task.sourceIdentity, task]));

  for (const task of tasks) {
    const data = task.data && typeof task.data === 'object' && !Array.isArray(task.data) ? task.data : null;
    const version = data?.agentInfraVersion;
    if (!version || typeof version !== 'object' || Array.isArray(version) || version.state !== 'known') {
      addFinding('schema-difference', 'info', [task.recordId], false, 'Task uses a legacy schema without a known agent_infra_version');
    }
    if (scope !== 'all' || !task.binding) continue;
    const identityCandidates = resources.filter((record) => record.sourceIdentity === task.binding);
    if (identityCandidates.length === 0) {
      addFinding('missing-remote', 'error', [task.recordId, task.binding], false, 'Task binding has no captured platform resource');
    }
    if (identityCandidates.length > 1) {
      addFinding('binding-conflict', 'error', [task.recordId, ...identityCandidates.map((record) => record.recordId)], false, 'Multiple platform resources bind to one task');
    }
    for (const remote of identityCandidates) {
      if (remote.binding && remote.binding !== task.sourceIdentity) {
        addFinding('content-mismatch', 'warning', [task.recordId, remote.recordId], false, 'Local and remote binding identities disagree');
      }
    }
    const candidates = identityCandidates.filter((record) => record.binding === task.sourceIdentity);
    if (candidates.length === 1 && (byIdentity.get(candidates[0]!.sourceIdentity)?.length ?? 0) === 1) {
      const target = candidates[0]!;
      repairs.push({
        repairId: `repair:${sha256(`${task.recordId}:${target.recordId}`).slice(0, 20)}`,
        operation: 'link',
        sourceRecordId: task.recordId,
        targetRecordId: target.recordId,
        preconditionSha256: sha256(`${task.sourceSha256}:${target.sourceSha256}`)
      });
    }
  }

  for (const resource of scope === 'all' ? resources : []) {
    if (resource.binding?.startsWith('TASK-') && !taskByIdentity.has(resource.binding)) {
      addFinding('missing-local', 'error', [resource.recordId, resource.binding], false, 'Platform resource binds to a task that is not captured locally');
    }
    const localClaims = tasks.filter((task) => task.binding === resource.sourceIdentity);
    if (localClaims.length > 1 || (resource.binding && localClaims.length > 0 && !localClaims.some((task) => task.sourceIdentity === resource.binding))) {
      addFinding('binding-conflict', 'error', [resource.recordId, ...localClaims.map((task) => task.recordId)], false, 'Local and remote records claim incompatible bindings');
    }
  }

  return {
    findings: findings.sort((left, right) => left.findingId.localeCompare(right.findingId)),
    repairs: repairs.sort((left, right) => left.repairId.localeCompare(right.repairId))
  };
}

type ResourceReconcileOptions = {
  parent?: NormalizedRecord[];
  full: boolean;
  deferred?: Iterable<string>;
  unavailable?: Iterable<string>;
};

function reconcileResourceRecords(
  current: NormalizedRecord[],
  options: ResourceReconcileOptions
): { records: NormalizedRecord[]; operations: SnapshotOperations } {
  const parent = new Map((options.parent ?? []).filter((record) => record.resourceIdentity).map((record) => [record.resourceIdentity!, record]));
  const currentMap = new Map(current.filter((record) => record.resourceIdentity).map((record) => [record.resourceIdentity!, record]));
  const deferred = new Set(options.deferred ?? []);
  const unavailable = new Set(options.unavailable ?? []);
  const records: NormalizedRecord[] = [];
  const operations: SnapshotOperations = { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 };
  for (const record of currentMap.values()) {
    const identity = record.resourceIdentity!;
    const previous = parent.get(identity);
    if (!previous) {
      records.push({ ...record, operation: 'upsert' });
      operations.upsert += 1;
    } else if (previous.sourceSha256 !== record.sourceSha256) {
      records.push({ ...record, operation: 'supersede' });
      operations.supersede += 1;
    }
  }
  if (options.full) {
    for (const [identity, previous] of parent) {
      if (currentMap.has(identity) || deferred.has(identity) || unavailable.has(identity)
        || (previous.parentIdentity && deferred.has(previous.parentIdentity))
        || (previous.parentIdentity && unavailable.has(previous.parentIdentity))) continue;
      records.push({
        recordId: previous.recordId,
        kind: 'platform-resource',
        sourceIdentity: identity,
        resourceIdentity: identity,
        sourceSha256: previous.sourceSha256,
        operation: 'tombstone',
        data: { availability: 'tombstone', previousSha256: previous.sourceSha256 }
      });
      operations.tombstone += 1;
    }
  }
  for (const identity of unavailable) {
    if (!parent.has(identity) && !currentMap.has(identity)) continue;
    const previous = parent.get(identity) ?? currentMap.get(identity)!;
    records.push({
      recordId: previous.recordId,
      kind: 'platform-resource',
      sourceIdentity: identity,
      resourceIdentity: identity,
      sourceSha256: previous.sourceSha256,
      operation: 'unavailable',
      data: { availability: 'unavailable', reason: 'source-unavailable' }
    });
    operations.unavailable += 1;
  }
  return { records: records.sort((left, right) => left.recordId.localeCompare(right.recordId)), operations };
}

export { reconcileRecords, reconcileResourceRecords };
