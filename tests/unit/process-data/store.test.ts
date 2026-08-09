import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalJsonBytes,
  createObjectStore,
  publishSnapshot,
  sha256,
  verifySnapshot
} from '../../../lib/process-data/store.ts';
import { readAppliedOverlays, repairSnapshot } from '../../../lib/process-data/repair.ts';

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
