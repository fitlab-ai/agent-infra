import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { onPlatforms } from '../../helpers.ts';
import {
  acquireGitHubCheckpoint,
  commitGitHubCheckpoint,
  checkpointPaths,
  readGitHubCheckpoint,
  releaseGitHubCheckpoint
} from '../../../lib/process-data/checkpoint.ts';
import { publishSnapshotV2 } from '../../../lib/process-data/store.ts';

function publishEmptyBase(root: string) {
  return publishSnapshotV2(root, {
    scope: 'github', repository: 'acme/demo', observedFrom: '2026-08-20T00:00:00.000Z', observedTo: '2026-08-20T00:00:01.000Z',
    objects: [], endpoints: [], excerptsEnabled: false, records: [], quality: [], repairs: [], snapshotKind: 'base', parentSnapshotId: null, checkpointBefore: null,
    watermark: '2026-08-20T00:00:01.000Z', window: { fromInclusive: null, queryAfter: null, toExclusive: '2026-08-20T00:00:01.000Z', precision: 'second' },
    observation: { cutoffSource: 'github-response-date', preflightDate: '2026-08-20T00:00:00.000Z', responseDates: ['2026-08-20T00:00:00.000Z'] },
    coverage: { mode: 'boundary-reread-with-full-reconcile', absoluteCompleteness: false }, reconciliation: 'incremental', operations: { upsert: 0, supersede: 0, tombstone: 0, unavailable: 0 }
  });
}

function writeStaleOwner(paths: ReturnType<typeof checkpointPaths>, ownerId: string): void {
  fs.writeFileSync(paths.lock, `${JSON.stringify({
    schema: 'checkpoint-owner/v1',
    ownerId,
    pid: process.pid,
    host: os.hostname(),
    processStartToken: 'stale-process-token',
    createdAt: '2026-08-20T00:00:00.000Z'
  })}\n`);
}

test('checkpoint is single-writer, owner-specific, and committed atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-'));
  const published = publishEmptyBase(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string };
  const first = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const busy = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.error.code, 'CHECKPOINT_BUSY');
  const committed = commitGitHubCheckpoint(first.value, {
    schema: 'github-checkpoint/v1',
    repository: 'acme/demo',
    snapshotId: published.snapshotId,
    watermark: '2026-08-20T00:00:01.000Z',
    manifestSha256: manifest.manifestSha256,
    committedAt: '2026-08-20T00:00:01.000Z'
  });
  assert.equal(committed.ok, true);
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), {
    ok: true,
    value: {
      schema: 'github-checkpoint/v1',
      repository: 'acme/demo',
      snapshotId: published.snapshotId,
      watermark: '2026-08-20T00:00:01.000Z',
      manifestSha256: manifest.manifestSha256,
      committedAt: '2026-08-20T00:00:01.000Z'
    }
  });
  releaseGitHubCheckpoint(first.value);
  const second = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(second.ok, true);
  if (second.ok) releaseGitHubCheckpoint(second.value);
});

test('checkpoint recovery promotes a verified candidate over an existing expected-old head', onPlatforms('linux'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-recovery-'));
  const paths = checkpointPaths(root, 'acme/demo');
  const published = publishEmptyBase(root);
  const old = {
    schema: 'github-checkpoint/v1' as const,
    repository: 'acme/demo',
    snapshotId: 'old-snapshot',
    watermark: '2026-08-20T00:00:00.000Z',
    manifestSha256: 'a'.repeat(64),
    committedAt: '2026-08-20T00:00:01.000Z'
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string };
  const next = { ...old, snapshotId: published.snapshotId, manifestSha256: manifest.manifestSha256, watermark: '2026-08-20T00:00:01.000Z' };
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.checkpoint, `${JSON.stringify(old)}\n`);
  writeStaleOwner(paths, 'crashed-owner');
  const candidatePath = `${paths.checkpoint}.crashed-owner.random.tmp`;
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    ...next,
    candidateSchema: 'github-checkpoint-candidate/v1',
    ownerId: 'crashed-owner',
    expectedOld: { snapshotId: old.snapshotId, manifestSha256: old.manifestSha256 }
  })}\n`);
  const acquired = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  assert.equal(acquired.value.recovery.recovered, true);
  assert.equal(fs.existsSync(candidatePath), false);
  const recovered = readGitHubCheckpoint(root, 'acme/demo');
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.deepEqual(recovered.value, next);
  releaseGitHubCheckpoint(acquired.value);
});

test('checkpoint recovery rejects a candidate whose derived snapshot is corrupt', onPlatforms('linux'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-corrupt-recovery-'));
  const paths = checkpointPaths(root, 'acme/demo');
  const published = publishEmptyBase(root);
  fs.appendFileSync(path.join(published.path, 'normalized.jsonl'), '{"schema":"normalized/v2","recordId":"corrupt"}\n');
  const old = {
    schema: 'github-checkpoint/v1' as const,
    repository: 'acme/demo', snapshotId: 'old-snapshot', watermark: '2026-08-20T00:00:00.000Z', manifestSha256: 'a'.repeat(64), committedAt: '2026-08-20T00:00:01.000Z'
  };
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.checkpoint, `${JSON.stringify(old)}\n`);
  writeStaleOwner(paths, 'corrupt-owner');
  const candidatePath = `${paths.checkpoint}.corrupt-owner.random.tmp`;
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    ...old, snapshotId: published.snapshotId, manifestSha256: (JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string }).manifestSha256, watermark: '2026-08-20T00:00:02.000Z',
    candidateSchema: 'github-checkpoint-candidate/v1', ownerId: 'corrupt-owner', expectedOld: { snapshotId: old.snapshotId, manifestSha256: old.manifestSha256 }
  })}\n`);

  const acquired = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(acquired.ok, false);
  if (!acquired.ok) assert.equal(acquired.error.code, 'CHECKPOINT_RECOVERY_REQUIRED');
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), { ok: true, value: old });
  assert.equal(fs.existsSync(candidatePath), false);
});

test('checkpoint recovery rejects a verified snapshot with a mismatched watermark', onPlatforms('linux'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-watermark-recovery-'));
  const paths = checkpointPaths(root, 'acme/demo');
  const published = publishEmptyBase(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string };
  const old = {
    schema: 'github-checkpoint/v1' as const, repository: 'acme/demo', snapshotId: 'old-snapshot', watermark: '2026-08-20T00:00:00.000Z', manifestSha256: 'a'.repeat(64), committedAt: '2026-08-20T00:00:01.000Z'
  };
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.checkpoint, `${JSON.stringify(old)}\n`);
  writeStaleOwner(paths, 'mismatched-watermark');
  const candidatePath = `${paths.checkpoint}.mismatched-watermark.random.tmp`;
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    ...old, snapshotId: published.snapshotId, watermark: '2099-01-01T00:00:00.000Z', manifestSha256: manifest.manifestSha256,
    candidateSchema: 'github-checkpoint-candidate/v1', ownerId: 'mismatched-watermark', expectedOld: { snapshotId: old.snapshotId, manifestSha256: old.manifestSha256 }
  })}\n`);

  const acquired = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(acquired.ok, false);
  if (!acquired.ok) assert.equal(acquired.error.code, 'CHECKPOINT_RECOVERY_REQUIRED');
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), { ok: true, value: old });
  assert.equal(fs.existsSync(candidatePath), false);
});

test('checkpoint recovery rejects a candidate owned by a different stale lock', onPlatforms('linux'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-owner-recovery-'));
  const paths = checkpointPaths(root, 'acme/demo');
  const published = publishEmptyBase(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string };
  const old = {
    schema: 'github-checkpoint/v1' as const,
    repository: 'acme/demo',
    snapshotId: 'old-snapshot',
    watermark: '2026-08-20T00:00:00.000Z',
    manifestSha256: 'a'.repeat(64),
    committedAt: '2026-08-20T00:00:01.000Z'
  };
  const next = { ...old, snapshotId: published.snapshotId, manifestSha256: manifest.manifestSha256, watermark: '2026-08-20T00:00:01.000Z' };
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.checkpoint, `${JSON.stringify(old)}\n`);
  writeStaleOwner(paths, 'stale-owner');
  const candidatePath = `${paths.checkpoint}.different-owner.random.tmp`;
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    ...next,
    candidateSchema: 'github-checkpoint-candidate/v1',
    ownerId: 'different-owner',
    expectedOld: { snapshotId: old.snapshotId, manifestSha256: old.manifestSha256 }
  })}\n`);

  const acquired = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(acquired.ok, false);
  if (!acquired.ok) assert.equal(acquired.error.code, 'CHECKPOINT_RECOVERY_REQUIRED');
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), { ok: true, value: old });
  assert.equal(fs.existsSync(candidatePath), false);
});

test('checkpoint recovery rejects an ownerless legacy candidate without a canonical head', onPlatforms('linux'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-ownerless-recovery-'));
  const paths = checkpointPaths(root, 'acme/demo');
  const published = publishEmptyBase(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string };
  fs.mkdirSync(paths.directory, { recursive: true });
  writeStaleOwner(paths, 'dead-owner');
  const candidatePath = `${paths.checkpoint}.legacy-owner.random.tmp`;
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    schema: 'github-checkpoint/v1',
    repository: 'acme/demo',
    snapshotId: published.snapshotId,
    watermark: '2026-08-20T00:00:01.000Z',
    manifestSha256: manifest.manifestSha256,
    committedAt: '2026-08-20T00:00:01.000Z'
  })}\n`);

  const acquired = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(acquired.ok, false);
  if (!acquired.ok) assert.equal(acquired.error.code, 'CHECKPOINT_RECOVERY_REQUIRED');
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), { ok: true, value: null });
  assert.equal(fs.existsSync(candidatePath), false);
});

test('checkpoint commit rejects an invalid or mismatched watermark', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-watermark-commit-'));
  const published = publishEmptyBase(root);
  const first = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const manifest = JSON.parse(fs.readFileSync(path.join(published.path, 'manifest.json'), 'utf8')) as { manifestSha256: string };
  const committed = commitGitHubCheckpoint(first.value, {
    schema: 'github-checkpoint/v1', repository: 'acme/demo', snapshotId: published.snapshotId, watermark: 'not-an-iso-timestamp',
    manifestSha256: manifest.manifestSha256, committedAt: '2026-08-20T00:00:01.000Z'
  });
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.equal(committed.error.code, 'CHECKPOINT_INVALID');
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), { ok: true, value: null });
  releaseGitHubCheckpoint(first.value);
});

test('busy checkpoint acquisition does not promote a recovery candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-checkpoint-busy-recovery-'));
  const first = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const paths = checkpointPaths(root, 'acme/demo');
  const old = {
    schema: 'github-checkpoint/v1' as const,
    repository: 'acme/demo',
    snapshotId: 'old-snapshot',
    watermark: '2026-08-20T00:00:00.000Z',
    manifestSha256: 'a'.repeat(64),
    committedAt: '2026-08-20T00:00:01.000Z'
  };
  const next = { ...old, snapshotId: 'new-snapshot', manifestSha256: 'b'.repeat(64), watermark: '2026-08-20T00:00:02.000Z' };
  fs.mkdirSync(path.join(root, 'snapshots', '2026', '08', '20', 'new-snapshot'), { recursive: true });
  fs.writeFileSync(path.join(root, 'snapshots', '2026', '08', '20', 'new-snapshot', 'manifest.json'), JSON.stringify({ manifestSha256: next.manifestSha256 }));
  fs.writeFileSync(paths.checkpoint, `${JSON.stringify(old)}\n`);
  const candidatePath = `${paths.checkpoint}.live-owner.random.tmp`;
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    ...next,
    candidateSchema: 'github-checkpoint-candidate/v1',
    ownerId: 'live-owner',
    expectedOld: { snapshotId: old.snapshotId, manifestSha256: old.manifestSha256 }
  })}\n`);

  const busy = acquireGitHubCheckpoint(root, 'acme/demo');
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.error.code, 'CHECKPOINT_BUSY');
  assert.deepEqual(readGitHubCheckpoint(root, 'acme/demo'), { ok: true, value: old });
  assert.equal(fs.existsSync(candidatePath), true);
  releaseGitHubCheckpoint(first.value);
});
