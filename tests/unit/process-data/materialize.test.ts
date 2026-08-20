import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { materializeJson, materializeSnapshot } from '../../../lib/process-data/materialize.ts';
import { createObjectStore, publishSnapshotV2, verifySnapshot } from '../../../lib/process-data/store.ts';

function snapshotInput(root: string, content: string, identity: string) {
  const store = createObjectStore(root);
  const bytes = Buffer.from(content);
  const object = store.put(bytes);
  const pageBytes = Buffer.from(`[${content}]`);
  const page = store.put(pageBytes);
  const endpoint = {
    endpoint: 'repos/acme/demo/issues', requestCount: 1, dataPageCount: 1, itemCount: 1, termination: 'short-page' as const, queryMode: 'full-enumeration' as const,
    pages: [{ index: 1, itemCount: 1, canonicalSha256: page.sha256, queryMode: 'full-enumeration' as const, responseDate: '2026-08-20T00:00:02.000Z' }]
  };
  return {
    object: { sourceKind: 'github-rest' as const, sourceIdentity: identity, resourceIdentity: identity, role: 'resource' as const, sha256: object.sha256, bytes: bytes.length },
    pageObject: { sourceKind: 'github-rest' as const, sourceIdentity: `${identity}#page=1`, role: 'page-evidence' as const, endpoint: endpoint.endpoint, page: 1, queryMode: 'full-enumeration' as const, responseDate: '2026-08-20T00:00:02.000Z', sha256: page.sha256, bytes: pageBytes.length },
    endpoint,
    sha256: object.sha256,
    pageSha256: page.sha256
  };
}

test('materialize follows one verified v2 lineage and supports as-of observation views', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-materialize-'));
  const baseObject = snapshotInput(root, '{"number":1}', 'issue:1');
  const base = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [baseObject.object, baseObject.pageObject], endpoints: [baseObject.endpoint], excerptsEnabled: false,
    records: [{ recordId: 'r1', kind: 'platform-resource', sourceIdentity: 'issue:1', resourceIdentity: 'issue:1', sourceSha256: baseObject.sha256, operation: 'upsert', evidence: [{ resourceIdentity: 'issue:1', resourceSha256: baseObject.sha256, pageSha256: baseObject.pageSha256 }], data: { number: 1 } }],
    quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental',
    operations: { upsert: 1, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  assert.equal(verifySnapshot(root, base.snapshotId).ok, true);
  const deltaObject = snapshotInput(root, '{"number":2}', 'issue:1');
  const delta = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:02.000Z', observedTo: '2026-08-20T00:00:03.000Z',
    objects: [deltaObject.object, deltaObject.pageObject], endpoints: [deltaObject.endpoint], excerptsEnabled: false,
    records: [{ recordId: 'r1', kind: 'platform-resource', sourceIdentity: 'issue:1', resourceIdentity: 'issue:1', sourceSha256: deltaObject.sha256, operation: 'supersede', evidence: [{ resourceIdentity: 'issue:1', resourceSha256: deltaObject.sha256, pageSha256: deltaObject.pageSha256 }], data: { number: 2 } }],
    quality: [], repairs: [], snapshotKind: 'delta', parentSnapshotId: base.snapshotId, checkpointBefore: base.snapshotId,
    watermark: '2026-08-20T00:00:03.000Z', window: { fromInclusive: '2026-08-20T00:00:01.000Z', queryAfter: null, toExclusive: '2026-08-20T00:00:03.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:02.000Z', responseDates: ['2026-08-20T00:00:02.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental',
    operations: { upsert: 0, supersede: 1, tombstone: 0, unavailable: 0 }
  });
  assert.equal(verifySnapshot(root, delta.snapshotId).ok, true);
  assert.deepEqual(materializeSnapshot(root, delta.snapshotId).records[0]!.data, { number: 2 });
  assert.deepEqual(materializeSnapshot(root, delta.snapshotId, { asOf: '2026-08-20T00:00:02.000Z' }).records[0]!.data, { number: 1 });
  assert.match(materializeJson(root, delta.snapshotId), /"number":2/);
});

test('materialize keeps unchanged ancestors when as-of is later than the head', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-materialize-late-asof-'));
  const baseObject = snapshotInput(root, '{"number":1}', 'issue:1');
  const base = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [baseObject.object, baseObject.pageObject], endpoints: [baseObject.endpoint], excerptsEnabled: false,
    records: [{ recordId: 'r1', kind: 'platform-resource', sourceIdentity: 'issue:1', resourceIdentity: 'issue:1', sourceSha256: baseObject.sha256, operation: 'upsert', evidence: [{ resourceIdentity: 'issue:1', resourceSha256: baseObject.sha256, pageSha256: baseObject.pageSha256 }], data: { number: 1 } }],
    quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental',
    operations: { upsert: 1, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  const deltaObject = snapshotInput(root, '{"number":2}', 'issue:2');
  const delta = publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:02.000Z', observedTo: '2026-08-20T00:00:03.000Z',
    objects: [deltaObject.object, deltaObject.pageObject], endpoints: [deltaObject.endpoint], excerptsEnabled: false,
    records: [{ recordId: 'r2', kind: 'platform-resource', sourceIdentity: 'issue:2', resourceIdentity: 'issue:2', sourceSha256: deltaObject.sha256, operation: 'upsert', evidence: [{ resourceIdentity: 'issue:2', resourceSha256: deltaObject.sha256, pageSha256: deltaObject.pageSha256 }], data: { number: 2 } }],
    quality: [], repairs: [], snapshotKind: 'delta', parentSnapshotId: base.snapshotId, checkpointBefore: base.snapshotId,
    watermark: '2026-08-20T00:00:03.000Z', window: { fromInclusive: '2026-08-20T00:00:01.000Z', queryAfter: null, toExclusive: '2026-08-20T00:00:03.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:02.000Z', responseDates: ['2026-08-20T00:00:02.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental',
    operations: { upsert: 1, supersede: 0, tombstone: 0, unavailable: 0 }
  });
  assert.equal(verifySnapshot(root, delta.snapshotId).ok, true);
  const records = materializeSnapshot(root, delta.snapshotId, { asOf: '2026-08-20T00:00:04.000Z' }).records;
  assert.deepEqual(records.map((record) => record.resourceIdentity), ['issue:1', 'issue:2']);
});
