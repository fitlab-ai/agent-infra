import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalJsonBytes,
  createObjectStore,
  publishSnapshot,
  publishSnapshotV2,
  sha256,
  verifySnapshot
} from '../../../lib/process-data/store.ts';
import { readAppliedOverlays, repairSnapshot } from '../../../lib/process-data/repair.ts';
import { onPlatforms } from '../../helpers.ts';

function publishBoundaryBase(root: string) {
  return publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [], endpoints: [], excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental', operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
  });
}

function publishBoundaryDelta(root: string, parentSnapshotId: string, options: {
  snapshotKind?: 'base' | 'delta';
  reconciliation?: 'incremental' | 'full';
  queryAfter: string | null;
  requestedSince?: string;
  queryMode?: 'strict-since' | 'full-enumeration';
  endpointQueryMode?: 'strict-since' | 'full-enumeration';
  pageQueryMode?: 'strict-since' | 'full-enumeration';
  objectQueryMode?: 'strict-since' | 'full-enumeration';
}) {
  const store = createObjectStore(root);
  const pageBytes = Buffer.from('[]');
  const page = store.put(pageBytes);
  const queryMode = options.queryMode ?? 'strict-since';
  const endpointQueryMode = options.endpointQueryMode ?? queryMode;
  const pageQueryMode = options.pageQueryMode ?? queryMode;
  const objectQueryMode = options.objectQueryMode ?? queryMode;
  const endpoint = {
    endpoint: 'repos/acme/demo/issues', requestCount: 1, dataPageCount: 0, itemCount: 0, termination: 'short-page' as const, queryMode: endpointQueryMode,
    pages: [{ index: 1, itemCount: 0, canonicalSha256: page.sha256, queryMode: pageQueryMode, ...(options.requestedSince !== undefined ? { requestedSince: options.requestedSince } : {}), responseDate: '2026-08-20T00:00:02.000Z' }]
  };
  return publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:02.000Z', observedTo: '2026-08-20T00:00:03.000Z',
    objects: [{ sourceKind: 'github-rest', sourceIdentity: 'repos/acme/demo/issues#page=1', role: 'page-evidence', endpoint: endpoint.endpoint, page: 1, queryMode: objectQueryMode, ...(options.requestedSince !== undefined ? { requestedSince: options.requestedSince } : {}), responseDate: '2026-08-20T00:00:02.000Z', sha256: page.sha256, bytes: pageBytes.length }],
    endpoints: [endpoint], excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: options.snapshotKind ?? 'delta', parentSnapshotId, checkpointBefore: parentSnapshotId,
    watermark: '2026-08-20T00:00:03.000Z', window: { fromInclusive: '2026-08-20T00:00:01.000Z', queryAfter: options.queryAfter, toExclusive: '2026-08-20T00:00:03.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:02.000Z', responseDates: ['2026-08-20T00:00:02.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: options.reconciliation ?? 'incremental', operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
  });
}

test('canonical JSON sorts object keys recursively and preserves array order', () => {
  const left = canonicalJsonBytes({ b: 1, a: { z: '值', y: [2, 1] } });
  const right = canonicalJsonBytes({ a: { y: [2, 1], z: '值' }, b: 1 });
  assert.deepEqual(left, right);
  assert.equal(left.toString('utf8'), '{"a":{"y":[2,1],"z":"值"},"b":1}');
  assert.notDeepEqual(left, canonicalJsonBytes({ a: { y: [1, 2], z: '值' }, b: 1 }));
  assert.throws(() => canonicalJsonBytes({ value: undefined } as never), /JSON value/);
});

test('CAS is idempotent and snapshot verification detects tampering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-'));
  const store = createObjectStore(root);
  const first = store.put(Buffer.from('evidence'));
  const second = store.put(Buffer.from('evidence'));
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const published = publishSnapshot(root, {
    scope: 'local',
    repository: 'example/repo',
    observedFrom: '2026-01-01T00:00:00.000Z',
    observedTo: '2026-01-01T00:00:01.000Z',
    objects: [{ sourceKind: 'local-file', sourceIdentity: 'task.md', sha256: first.sha256, bytes: 8 }],
    endpoints: [],
    excerptsEnabled: true,
    records: [{ recordId: 'record-1', kind: 'artifact', sourceIdentity: 'task.md', sourceSha256: first.sha256 }],
    quality: [],
    repairs: []
  });
  const verified = verifySnapshot(root, published.snapshotId);
  assert.equal(verified.ok, true);
  assert.equal(verified.manifest?.excerptsEnabled, true);
  assert.deepEqual(verified.manifest?.dispositionCounts, { included: 1, 'excluded-sensitive': 0, unavailable: 0 });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(published.path, 'manifest.json'), 0o644);
    fs.chmodSync(published.path, 0o755);
    const unsafe = verifySnapshot(root, published.snapshotId);
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.errors.join('\n'), /permission/);
    fs.chmodSync(published.path, 0o700);
    fs.chmodSync(path.join(published.path, 'manifest.json'), 0o600);
  }
  fs.writeFileSync(first.path, 'tampered');
  const invalid = verifySnapshot(root, published.snapshotId);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /hash mismatch/);
});

test('snapshot verification rejects an unknown manifest schema instead of treating it as v1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-unknown-schema-'));
  const published = publishSnapshot(root, {
    scope: 'local', repository: 'example/repo', observedFrom: '2026-01-01T00:00:00.000Z', observedTo: '2026-01-01T00:00:01.000Z',
    objects: [], endpoints: [], excerptsEnabled: false, records: [], quality: [], repairs: []
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const { manifestSha256: _oldDigest, ...partial } = manifest;
  const unknown = { ...partial, schema: 'raw-manifest/v999' };
  fs.writeFileSync(path.join(published.path, 'manifest.json'), `${JSON.stringify({ ...unknown, manifestSha256: sha256(canonicalJsonBytes(unknown)) })}\n`);
  const verified = verifySnapshot(root, published.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /unsupported manifest schema/);
});

test('v2 verification rejects an endpoint page without its page-evidence CAS object', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-page-'));
  const published = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [],
    endpoints: [{
      endpoint: 'repos/acme/demo/issues', requestCount: 1, dataPageCount: 0, itemCount: 0, termination: 'short-page', queryMode: 'full-enumeration',
      pages: [{ index: 1, itemCount: 0, canonicalSha256: 'f'.repeat(64), queryMode: 'full-enumeration', responseDate: '2026-08-20T00:00:00.000Z' }]
    }],
    excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental',
    operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  const verified = verifySnapshot(root, published.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /page evidence CAS reference/);
});

test('v2 verification requires strict-since query boundary proof on incremental deltas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-query-proof-'));
  const base = publishBoundaryBase(root);
  const delta = publishBoundaryDelta(root, base.snapshotId, { queryAfter: null });
  const verified = verifySnapshot(root, delta.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /strict-since|queryAfter|requestedSince/);
});

test('v2 verification rejects strict-since on full reconciliation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-query-mode-'));
  const base = publishBoundaryBase(root);
  const queryAfter = '2026-08-20T00:00:00.000Z';
  const delta = publishBoundaryDelta(root, base.snapshotId, {
    queryAfter,
    requestedSince: queryAfter,
    reconciliation: 'full'
  });
  const verified = verifySnapshot(root, delta.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /strict-since|full reconciliation/);
});

test('v2 verification rejects a strict-since endpoint with mismatched requestedSince', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-query-mismatch-'));
  const base = publishBoundaryBase(root);
  const delta = publishBoundaryDelta(root, base.snapshotId, {
    queryAfter: '2026-08-20T00:00:00.000Z',
    requestedSince: '2026-08-20T00:00:02.000Z'
  });
  const verified = verifySnapshot(root, delta.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /since proof|query proof|requestedSince/);
});

test('v2 verification rejects an unknown query mode at the endpoint level', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-query-mode-endpoint-unknown-'));
  const base = publishBoundaryBase(root);
  const delta = publishBoundaryDelta(root, base.snapshotId, {
    queryAfter: null,
    queryMode: 'full-enumeration',
    endpointQueryMode: 'future-mode' as never
  });
  const verified = verifySnapshot(root, delta.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /endpoint query mode is invalid/);
});

test('v2 verification rejects an unknown query mode at the page level', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-query-mode-page-unknown-'));
  const base = publishBoundaryBase(root);
  const delta = publishBoundaryDelta(root, base.snapshotId, {
    queryAfter: null,
    queryMode: 'full-enumeration',
    pageQueryMode: 'future-mode' as never
  });
  const verified = verifySnapshot(root, delta.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /page query mode is invalid/);
});

test('v2 verification rejects an unknown query mode at the page-evidence object level', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-query-mode-object-unknown-'));
  const base = publishBoundaryBase(root);
  const delta = publishBoundaryDelta(root, base.snapshotId, {
    queryAfter: null,
    queryMode: 'full-enumeration',
    objectQueryMode: 'future-mode' as never
  });
  const verified = verifySnapshot(root, delta.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /page evidence query mode is invalid/);
});

test('v2 verification requires evidence for every upsert resource', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-resource-evidence-'));
  const store = createObjectStore(root);
  const bytes = Buffer.from('{"number":1}');
  const object = store.put(bytes);
  const published = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [{ sourceKind: 'github-rest', sourceIdentity: 'issue:1', resourceIdentity: 'issue:1', role: 'resource', sha256: object.sha256, bytes: bytes.length }],
    endpoints: [], excerptsEnabled: false,
    records: [{ recordId: 'r1', kind: 'platform-resource', sourceIdentity: 'issue:1', resourceIdentity: 'issue:1', sourceSha256: object.sha256, operation: 'upsert', data: { number: 1 } }],
    quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental',
    operations: { upsert: 1, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  const verified = verifySnapshot(root, published.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /resource evidence/);
});

test('v2 verification recursively verifies every snapshot ancestor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-v2-ancestor-'));
  const base = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [], endpoints: [], excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental', operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  fs.appendFileSync(path.join(base.path, 'normalized.jsonl'), '{"schema":"normalized/v2","recordId":"corrupt"}\n');
  const child = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:02.000Z', observedTo: '2026-08-20T00:00:03.000Z',
    objects: [], endpoints: [], excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: 'delta', parentSnapshotId: base.snapshotId, checkpointBefore: base.snapshotId,
    watermark: '2026-08-20T00:00:03.000Z', window: { fromInclusive: '2026-08-20T00:00:01.000Z', queryAfter: '2026-08-20T00:00:00.000Z', toExclusive: '2026-08-20T00:00:03.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:02.000Z', responseDates: ['2026-08-20T00:00:02.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental', operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  const verified = verifySnapshot(root, child.snapshotId);
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join('\n'), /ancestor|normalized record count/);
});

test('snapshot publication uses file and directory fsync barriers', onPlatforms('linux', 'darwin'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-store-fsync-'));
  const originalFsync = fs.fsyncSync;
  const originalOpen = fs.openSync;
  let calls = 0;
  const opened = new Map<number, string>();
  const fsyncedDirectories: string[] = [];
  fs.openSync = ((...args: any[]) => {
    const fd = (originalOpen as (...values: any[]) => number)(...args);
    if (typeof args[0] === 'string') opened.set(fd, args[0]);
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => {
    calls += 1;
    const target = opened.get(fd);
    if (target) fsyncedDirectories.push(target);
    return originalFsync(fd);
  }) as typeof fs.fsyncSync;
  try {
    publishSnapshotV2(root, {
      scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
      objects: [], endpoints: [], excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
      watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
      observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
      coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental', operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
    });
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }
  assert.ok(calls >= 6, `expected publication fsync barriers, got ${calls}`);
  const snapshots = path.join(root, 'snapshots');
  const year = path.join(snapshots, '2026');
  const month = path.join(year, '08');
  const day = path.join(month, '20');
  const order = [root, snapshots, year, month, day].map((directory) => fsyncedDirectories.indexOf(directory));
  assert.ok(order.every((index) => index >= 0), `expected recursive directory barriers, got ${fsyncedDirectories.join(', ')}`);
  assert.ok(order.every((index, position) => position === 0 || index > order[position - 1]!));
});

test('repair application is append-only and idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-repair-'));
  const localSha = 'b'.repeat(64);
  const remoteSha = 'c'.repeat(64);
  const published = publishSnapshot(root, {
    scope: 'local',
    repository: 'example/repo',
    observedFrom: '2026-01-01T00:00:00.000Z',
    observedTo: '2026-01-01T00:00:01.000Z',
    objects: [],
    endpoints: [],
    excerptsEnabled: false,
    records: [
      { recordId: 'local', kind: 'task', sourceIdentity: 'TASK-1', sourceSha256: localSha },
      { recordId: 'remote', kind: 'platform-resource', sourceIdentity: 'issue:1', sourceSha256: remoteSha }
    ],
    quality: [],
    repairs: [{
      repairId: 'repair:one',
      operation: 'link',
      sourceRecordId: 'local',
      targetRecordId: 'remote',
      preconditionSha256: sha256(`${localSha}:${remoteSha}`)
    }]
  });
  const dryRun = repairSnapshot(root, published.snapshotId, false);
  assert.equal(dryRun.applied, false);
  assert.equal(readAppliedOverlays(root, published.snapshotId), '');
  const first = repairSnapshot(root, published.snapshotId, true);
  const second = repairSnapshot(root, published.snapshotId, true);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(first.repairId, second.repairId);
  assert.match(readAppliedOverlays(root, published.snapshotId), /normalized-overlay\/v1/);
});
