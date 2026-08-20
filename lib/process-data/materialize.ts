import fs from 'node:fs';
import path from 'node:path';

import { findSnapshot, verifySnapshot } from './store.ts';
import type { NormalizedRecord, SnapshotManifestV2 } from './types.ts';

type MaterializeOptions = { asOf?: string };
type MaterializeResult = { snapshotId: string; records: NormalizedRecord[]; manifest: SnapshotManifestV2 | null };

function readRecords(snapshotPath: string, schema: 'normalized/v1' | 'normalized/v2'): NormalizedRecord[] {
  const file = path.join(snapshotPath, 'normalized.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    const value = JSON.parse(line) as { schema?: string } & NormalizedRecord;
    if (value.schema !== schema) return [];
    const { schema: _schema, ...record } = value;
    return [record];
  });
}

function materializeSnapshot(root: string, snapshotId: string, options: MaterializeOptions = {}): MaterializeResult {
  const target = options.asOf ? new Date(options.asOf) : null;
  if (target && !Number.isFinite(target.getTime())) throw new Error('as-of must be an ISO timestamp');
  const chain: Array<{ id: string; path: string; manifest: SnapshotManifestV2 }> = [];
  let currentId: string | null = snapshotId;
  let repository: string | null = null;
  while (currentId) {
    const currentPath = findSnapshot(root, currentId);
    if (!currentPath) throw new Error(`snapshot not found: ${currentId}`);
    const verified = verifySnapshot(root, currentId);
    if (!verified.ok || !verified.manifest) throw new Error(`snapshot is not verified: ${currentId}`);
    if (verified.manifest.schema !== 'raw-manifest/v2') {
      if (chain.length > 0) throw new Error('v1 and v2 snapshots cannot share a lineage');
      return { snapshotId, records: readRecords(currentPath, 'normalized/v1'), manifest: null };
    }
    const manifest = verified.manifest;
    if (repository && manifest.repository !== repository) throw new Error('snapshot lineage repository mismatch');
    repository = manifest.repository;
    chain.push({ id: currentId, path: currentPath, manifest });
    currentId = manifest.parentSnapshotId;
  }
  if (chain.length === 0) throw new Error('snapshot lineage is empty');
  const chronological = [...chain].reverse();
  for (let index = 1; index < chronological.length; index += 1) {
    if (new Date(chronological[index - 1]!.manifest.watermark).getTime() >= new Date(chronological[index]!.manifest.watermark).getTime()) {
      throw new Error('snapshot watermark is not monotonic');
    }
  }
  const view = new Map<string, NormalizedRecord>();
  let appliedManifest: SnapshotManifestV2 | null = null;
  for (const entry of chronological) {
    if (target && new Date(entry.manifest.watermark).getTime() > target.getTime()) continue;
    appliedManifest = entry.manifest;
    for (const record of readRecords(entry.path, 'normalized/v2')) {
      const identity = record.resourceIdentity ?? record.sourceIdentity;
      switch (record.operation) {
        case 'tombstone':
          view.delete(identity);
          break;
        case 'unavailable':
          view.set(identity, record);
          break;
        default:
          view.set(identity, { ...record, operation: undefined });
          break;
      }
    }
  }
  if (target && !appliedManifest) throw new Error('no verified snapshot is available at the requested as-of time');
  return {
    snapshotId,
    records: [...view.values()].sort((left, right) => left.recordId.localeCompare(right.recordId)),
    manifest: appliedManifest
  };
}

function materializeJson(root: string, snapshotId: string, options: MaterializeOptions = {}): string {
  const result = materializeSnapshot(root, snapshotId, options);
  return result.records.map((record) => JSON.stringify({ schema: 'normalized/v2', ...record })).join('\n') + (result.records.length ? '\n' : '');
}

export { materializeJson, materializeSnapshot };
export type { MaterializeOptions, MaterializeResult };
