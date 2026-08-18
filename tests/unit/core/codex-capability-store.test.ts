import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { createCodexCapabilityStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts';

const build = {
  protocolVersion: 3,
  packageVersion: '1.2.3',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64)
} as const;

test('Codex capability is attested by one tool use and consumed once', () => {
  let now = 1_000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capability-'));
  const store = createCodexCapabilityStore({
    root,
    now: () => now,
    token: () => 'secret-token'
  });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  assert.equal(armed.status, 'armed');
  assert.equal(fs.readFileSync(armed.path, 'utf8').includes('secret-token'), false);

  const attested = store.attest({
    token: armed.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  });
  assert.equal(attested.status, 'attested');
  const consumed = store.consume(armed.token, {
    taskId: 'TASK-20260101-000001',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  });
  assert.equal(consumed.status, 'consumed');
  assert.throws(
    () => store.consume(armed.token, {
      taskId: 'TASK-20260101-000001',
      hookDefinitionHash: 'c'.repeat(64),
      buildIdentity: build
    }),
    /CODEX_CAPABILITY_REPLAY/
  );

  now += 86_400_001;
  store.sweep();
  assert.equal(fs.existsSync(armed.path), false);
});

test('Codex capability expiry and provenance mismatch fail closed', () => {
  let now = 2_000;
  let tokenIndex = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capability-expiry-'));
  const store = createCodexCapabilityStore({
    root,
    now: () => now,
    token: () => ['expiring-token', 'mismatched-token'][tokenIndex++]!
  });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  now += 30_001;
  assert.throws(() => store.attest({
    token: armed.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  }), /CODEX_CAPABILITY_EXPIRED/);

  now = 3_000;
  const second = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  assert.throws(() => store.attest({
    token: second.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: { ...build, lifecycleContractHash: 'd'.repeat(64) }
  }), /CODEX_CAPABILITY_PROVENANCE_MISMATCH/);
});

test('Codex capability compare-and-swap preserves a competing attestation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capability-cas-'));
  let armedPath = '';
  let injectConflict = false;
  const store = createCodexCapabilityStore({
    root,
    token: () => 'cas-token',
    beforeCompareAndSwap({ path: recordPath, expectedRevision }) {
      if (!injectConflict || expectedRevision !== 1) return;
      injectConflict = false;
      const competing = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      competing.revision = 2;
      competing.status = 'attested';
      competing.sessionId = 'competing-session';
      fs.writeFileSync(recordPath, `${JSON.stringify(competing, null, 2)}\n`);
    }
  });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  armedPath = armed.path;
  injectConflict = true;
  assert.throws(() => store.attest({
    token: armed.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  }), /CODEX_CAPABILITY_REVISION_CONFLICT/);
  assert.equal(JSON.parse(fs.readFileSync(armedPath, 'utf8')).sessionId, 'competing-session');
});

test('Codex capability serializes concurrent attestation writers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capability-concurrent-'));
  const store = createCodexCapabilityStore({ root, token: () => 'concurrent-token' });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createCodexCapabilityStore } = await import(workerData.moduleUrl);
      const state = new Int32Array(workerData.buffer);
      const store = createCodexCapabilityStore({
        root: workerData.root,
        beforeCompareAndSwap({ expectedRevision }) {
          if (expectedRevision !== 1) return;
          Atomics.store(state, workerData.index, 1);
          Atomics.notify(state, workerData.index);
          while (Atomics.load(state, 2) === 0) Atomics.wait(state, 2, 0, 50);
        }
      });
      parentPort.postMessage({ status: 'ready' });
      parentPort.once('message', () => {
        try {
          store.attest({
            token: workerData.token,
            sessionId: \`session-\${workerData.index}\`,
            turnId: \`turn-\${workerData.index}\`,
            toolUseId: \`tool-\${workerData.index}\`,
            hookDefinitionHash: 'c'.repeat(64),
            buildIdentity: workerData.build
          });
          parentPort.postMessage({ status: 'ok' });
        } catch (error) {
          parentPort.postMessage({ status: 'error', name: error.name });
        }
      });
    })().catch((error) => { throw error; });
  `;
  const moduleUrl = new URL('../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts', import.meta.url).href;
  const workers = [0, 1].map((index) => new Worker(workerSource, {
    eval: true,
    workerData: { root, token: armed.token, build, buffer: state.buffer, index, moduleUrl }
  }));
  const nextMessage = (worker: Worker) => new Promise<Record<string, string>>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });

  await Promise.all(workers.map(nextMessage));
  workers[0]!.postMessage('go');
  assert.equal(Atomics.wait(state, 0, 0, 1_000), 'ok');
  workers[1]!.postMessage('go');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const secondWriterEntered = Atomics.load(state, 1);
  Atomics.store(state, 2, 1);
  Atomics.notify(state, 2, 2);

  const results = await Promise.all(workers.map(nextMessage));
  assert.equal(secondWriterEntered, 0);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['error', 'ok']);
  assert.equal(results.find(({ status }) => status === 'error')?.name, 'CODEX_CAPABILITY_REVISION_CONFLICT');
  await Promise.all(workers.map((worker) => worker.terminate()));
});

test('Codex capability consume lazily removes old terminal records', () => {
  let now = 1_000;
  let tokenIndex = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capability-consume-sweep-'));
  const store = createCodexCapabilityStore({
    root,
    now: () => now,
    token: () => ['first-token', 'second-token'][tokenIndex++]!,
    ttlMs: 10_000,
    tombstoneMs: 100
  });
  const first = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  store.attest({
    token: first.token, sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    hookDefinitionHash: 'c'.repeat(64), buildIdentity: build
  });
  store.consume(first.token, {
    taskId: 'TASK-20260101-000001', hookDefinitionHash: 'c'.repeat(64), buildIdentity: build
  });
  const second = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  store.attest({
    token: second.token, sessionId: 'session-2', turnId: 'turn-2', toolUseId: 'tool-2',
    hookDefinitionHash: 'c'.repeat(64), buildIdentity: build
  });
  now += 101;
  store.consume(second.token, {
    taskId: 'TASK-20260101-000001', hookDefinitionHash: 'c'.repeat(64), buildIdentity: build
  });
  assert.equal(fs.existsSync(first.path), false);
});
