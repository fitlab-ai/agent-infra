import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { completedReentryView, prepareCompletedReentry, publishCompletedReentry } from '../../../lib/sandbox/control/completed-reentry.ts';
import { mergeSandboxTaskView, taskViewAfterFinalization } from '../../../lib/sandbox/control/task-view.ts';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';

function fixture(t: TestContext) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'completed-reentry-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'scratch'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture'], { cwd: root });
  const taskId = 'TASK-20260906-010203';
  const source = path.join(root, '.agents', 'workspace', 'completed', taskId);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'task.md'), `---\nid: ${taskId}\nbranch: scratch\nstatus: completed\n---\n`);
  const control = path.join(root, 'control');
  fs.mkdirSync(path.join(control, 'public'), { recursive: true });
  const generation = 'fixture-generation';
  const requestId = 'a'.repeat(32);
  const receipt = { version: 2, taskId, intent: 'complete', receiptId: 'fixture-receipt', revision: 3,
    lifecycle: 'done', taskComment: 'skipped', verification: 'done', warningProjection: 'done', warnings: [],
    controlBinding: { generation, requestId }, updatedAt: new Date().toISOString(), lastError: null };
  const receiptPath = path.join(root, '.agents', 'workspace', '.task-finalization', taskId + '.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const stale = taskViewAfterFinalization({ taskId, generation, requestId, receipt });
  fs.writeFileSync(path.join(control, 'public', 'status.json'), JSON.stringify({ version: 3, generation,
    broker: { pid: process.pid, startTime: 1, brokerId: 'fixture-broker' }, state: 'healthy', reasonCode: null,
    activeRequestId: null, updatedAt: Date.now(), taskView: stale }));
  const manifest = { repoRoot: root, worktreeRoot: root, project: 'fixture', container: 'fixture-container',
    containerIdentity: { id: 'fixture-container-id', labels: {} }, branch: 'scratch', mode: 'task-bound', taskId,
    generation, token: 'fixture-token', engine: 'native', channelDir: path.join(control, 'channel'),
    publicStatusDir: path.join(control, 'public'), processingDir: path.join(control, 'processing'), runtimeDir: path.join(control, 'runtime')
  } as SandboxControlManifest;
  const inspect = async () => ({ state: 'found' as const, id: manifest.containerIdentity.id, labels: {}, running: true });
  return { root, source, manifest, inspect, receipt, receiptPath, stale };
}

test('only a verified completed re-entry clears the stale projection', async (t) => {
  const f = fixture(t);
  assert.equal(await completedReentryView(f.manifest, f.inspect), null);
  const evidence = await prepareCompletedReentry(f.manifest, f.inspect);
  publishCompletedReentry(f.manifest, evidence);
  const current = await completedReentryView(f.manifest, f.inspect);
  assert.equal(current?.state, 'current');
  assert.equal(current?.observedSource, 'completed');
  assert.deepEqual(current?.receipt, f.stale.receipt);
  assert.deepEqual(mergeSandboxTaskView(current!, f.stale), f.stale);
});

for (const field of ['taskId', 'generation', 'containerId', 'branch', 'worktreeRoot', 'source', 'sourceDevice', 'sourceInode', 'receipt'] as const) {
  test(`completed re-entry rejects changed ${field} evidence`, async (t) => {
    const f = fixture(t);
    const evidence = await prepareCompletedReentry(f.manifest, f.inspect);
    const changed = { ...evidence, [field]: field === 'receipt' ? { ...evidence.receipt, requestId: 'b'.repeat(32) } : 'mismatch' };
    publishCompletedReentry(f.manifest, changed as typeof evidence);
    await assert.rejects(completedReentryView(f.manifest, f.inspect), /SANDBOX_COMPLETED_REENTRY_EVIDENCE_INVALID/);
  });
}

test('completed re-entry rechecks canonical receipt and container identity', async (t) => {
  const f = fixture(t);
  const evidence = await prepareCompletedReentry(f.manifest, f.inspect);
  publishCompletedReentry(f.manifest, evidence);
  await assert.rejects(completedReentryView(f.manifest, async () => ({ state: 'absent', id: f.manifest.containerIdentity.id })), /SANDBOX_COMPLETED_REENTRY_EVIDENCE_INVALID/);
  fs.writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, controlBinding: { ...f.receipt.controlBinding, requestId: 'b'.repeat(32) } }));
  await assert.rejects(completedReentryView(f.manifest, f.inspect), /SANDBOX_COMPLETED_REENTRY_EVIDENCE_INVALID/);
});

for (const field of ['id', 'status'] as const) {
  test(`completed re-entry rejects changed canonical task ${field}`, async (t) => {
    const f = fixture(t);
    const evidence = await prepareCompletedReentry(f.manifest, f.inspect);
    publishCompletedReentry(f.manifest, evidence);
    const file = path.join(f.source, 'task.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: changed`));
    await assert.rejects(completedReentryView(f.manifest, f.inspect), /SANDBOX_COMPLETED_REENTRY_EVIDENCE_INVALID/);
  });
}
