import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { Worker } from 'node:worker_threads';

import { createCodexCapabilityStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts';

const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});
const mkdtempSync = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return root;
};

const build = {
  protocolVersion: 3,
  packageVersion: '1.2.3',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64)
} as const;

test('Codex capability is attested by one tool use and consumed once', () => {
  let now = 1_000;
  const root = mkdtempSync('codex-capability-');
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

test('Codex capability expiry and protocol mismatch fail closed while build drift is diagnostic', () => {
  let now = 2_000;
  let tokenIndex = 0;
  const root = mkdtempSync('codex-capability-expiry-');
  const store = createCodexCapabilityStore({
    root,
    now: () => now,
    token: () => ['expiring-token', 'mismatched-token', 'drift-token'][tokenIndex++]!
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
    buildIdentity: { ...build, protocolVersion: 2 as never }
  }), /CODEX_CAPABILITY_PROVENANCE_MISMATCH/);

  const drifted = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  const driftedBuild = {
    ...build,
    packageVersion: '1.2.4',
    internalExecutableBuildHash: 'c'.repeat(64),
    lifecycleContractHash: 'd'.repeat(64)
  };
  const attested = store.attest({
    token: drifted.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: driftedBuild
  });
  assert.equal(attested.status, 'attested');
  assert.equal(store.validate(drifted.token, {
    taskId: 'TASK-20260101-000001',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: driftedBuild
  }).status, 'attested');
  assert.equal(store.consume(drifted.token, {
    taskId: 'TASK-20260101-000001',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: driftedBuild
  }).status, 'consumed');
});

test('Codex capability mismatch exposes fixed safe field detail without consuming', () => {
  const root = mkdtempSync('codex-capability-detail-');
  const controller = { instanceDigest: 'i'.repeat(64), controlGeneration: 'generation-1' };
  const store = createCodexCapabilityStore({ root, token: () => 'detail-token' });
  const armed = store.arm({
    taskId: 'TASK-20260101-000001',
    buildIdentity: build,
    controller
  });
  store.attest({
    token: armed.token,
    sessionId: 'session-secret',
    turnId: 'turn-secret',
    toolUseId: 'tool-secret',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build,
    controller
  });

  assert.throws(() => store.consume(armed.token, {
    taskId: 'TASK-20260101-000002',
    hookDefinitionHash: 'd'.repeat(64),
    buildIdentity: {
      protocolVersion: 3,
      packageVersion: '1.2.4',
      internalExecutableBuildHash: 'f'.repeat(64),
      lifecycleContractHash: 'e'.repeat(64)
    },
    controller: { instanceDigest: 'j'.repeat(64), controlGeneration: 'generation-2' }
  }), (error: unknown) => {
    assert.equal(error instanceof Error && error.name, 'CODEX_CAPABILITY_PROVENANCE_MISMATCH');
    const detail = (error as { detail?: unknown }).detail;
    assert.deepEqual(detail, {
      kind: 'codex-capability-provenance-mismatch',
      version: 1,
      fields: {
        taskId: {
          matches: false,
          expected: { kind: 'digest-prefix', value: 'sha256:e0669166e5733c3a' },
          actual: { kind: 'digest-prefix', value: 'sha256:e8dbe4a4d8fdd5f1' }
        },
        hookDefinitionHash: {
          matches: false,
          expected: { kind: 'digest-prefix', value: 'sha256:0c365521729ffa91' },
          actual: { kind: 'digest-prefix', value: 'sha256:caf64839e259fbb3' }
        },
        buildIdentity: {
          protocolVersion: {
            matches: true,
            expected: { kind: 'protocol-version', value: 3 },
            actual: { kind: 'protocol-version', value: 3 }
          },
          packageVersion: {
            matches: false,
            expected: { kind: 'semver', value: '1.2.4' },
            actual: { kind: 'semver', value: '1.2.3' }
          },
          internalExecutableBuildHash: {
            matches: false,
            expected: { kind: 'digest-prefix', value: 'sha256:15eb94f73038f786' },
            actual: { kind: 'digest-prefix', value: 'sha256:9746b6aeb2193daa' }
          },
          lifecycleContractHash: {
            matches: false,
            expected: { kind: 'digest-prefix', value: 'sha256:5896d13b1a9fe473' },
            actual: { kind: 'digest-prefix', value: 'sha256:c37350387c5d73db' }
          }
        },
        controller: {
          instanceDigest: {
            matches: false,
            expected: { kind: 'presence', present: true },
            actual: { kind: 'presence', present: true }
          },
          controlGeneration: {
            matches: false,
            expected: { kind: 'presence', present: true },
            actual: { kind: 'presence', present: true }
          }
        }
      }
    });
    assert.equal(JSON.stringify(detail).includes('detail-token'), false);
    assert.equal(JSON.stringify(detail).includes('session-secret'), false);
    return true;
  });

  assert.deepEqual(store.inspect(armed.token), {
    ...store.inspect(armed.token),
    status: 'attested',
    revision: 2
  });
});

test('Codex capability detail maps malformed persisted identity to absent', () => {
  const root = mkdtempSync('codex-capability-detail-invalid-');
  const store = createCodexCapabilityStore({ root, token: () => 'invalid-detail-token' });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build });
  store.attest({
    token: armed.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  });
  const record = JSON.parse(fs.readFileSync(armed.path, 'utf8'));
  record.buildIdentity.packageVersion = 'arbitrary raw identity';
  fs.writeFileSync(armed.path, `${JSON.stringify(record)}\n`);

  assert.throws(() => store.consume(armed.token, {
    taskId: 'TASK-20260101-000002',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  }), (error: unknown) => {
    const detail = (error as { detail?: { fields?: { buildIdentity?: { packageVersion?: { actual?: unknown } } } } }).detail;
    assert.deepEqual(detail?.fields?.buildIdentity?.packageVersion?.actual, { kind: 'absent' });
    assert.equal(JSON.stringify(detail).includes('arbitrary raw identity'), false);
    return true;
  });
});

test('Codex capability rejects malformed persisted controller without consuming', () => {
  const root = mkdtempSync('codex-capability-controller-invalid-');
  const controller = { instanceDigest: 'i'.repeat(64), controlGeneration: 'generation-1' };
  const store = createCodexCapabilityStore({ root, token: () => 'invalid-controller-token' });
  const armed = store.arm({
    taskId: 'TASK-20260101-000001',
    buildIdentity: build,
    controller
  });
  store.attest({
    token: armed.token,
    sessionId: 'session',
    turnId: 'turn',
    toolUseId: 'tool',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build,
    controller
  });
  const record = JSON.parse(fs.readFileSync(armed.path, 'utf8'));
  record.controller = {};
  fs.writeFileSync(armed.path, `${JSON.stringify(record)}\n`);

  assert.throws(() => store.consume(armed.token, {
    taskId: 'TASK-20260101-000001',
    hookDefinitionHash: 'c'.repeat(64),
    buildIdentity: build
  }), (error: unknown) => {
    assert.equal(error instanceof Error && error.name, 'CODEX_CAPABILITY_PROVENANCE_MISMATCH');
    const detail = (error as { detail?: { fields?: { controller?: { instanceDigest?: { matches?: boolean } } } } }).detail;
    assert.equal(detail?.fields?.controller?.instanceDigest?.matches, false);
    return true;
  });
  assert.equal(store.inspect(armed.token).status, 'attested');
  assert.equal(store.inspect(armed.token).revision, 2);
});

test('Codex capability detail localizes one controller field mismatch', () => {
  const scenarios = [
    {
      name: 'instance digest',
      expected: { instanceDigest: 'j'.repeat(64), controlGeneration: 'generation-1' },
      matches: { instanceDigest: false, controlGeneration: true }
    },
    {
      name: 'control generation',
      expected: { instanceDigest: 'i'.repeat(64), controlGeneration: 'generation-2' },
      matches: { instanceDigest: true, controlGeneration: false }
    }
  ] as const;

  for (const scenario of scenarios) {
    const root = mkdtempSync(`codex-capability-controller-${scenario.name.replaceAll(' ', '-')}-`);
    const controller = { instanceDigest: 'i'.repeat(64), controlGeneration: 'generation-1' };
    const store = createCodexCapabilityStore({ root, token: () => `controller-${scenario.name}` });
    const armed = store.arm({
      taskId: 'TASK-20260101-000001',
      buildIdentity: build,
      controller
    });
    store.attest({
      token: armed.token,
      sessionId: 'session',
      turnId: 'turn',
      toolUseId: 'tool',
      hookDefinitionHash: 'c'.repeat(64),
      buildIdentity: build,
      controller
    });

    assert.throws(() => store.consume(armed.token, {
      taskId: 'TASK-20260101-000001',
      hookDefinitionHash: 'c'.repeat(64),
      buildIdentity: build,
      controller: scenario.expected
    }), (error: unknown) => {
      const detail = (error as { detail?: { fields?: { controller?: {
        instanceDigest?: { matches?: boolean };
        controlGeneration?: { matches?: boolean };
      } } } }).detail;
      assert.equal(detail?.fields?.controller?.instanceDigest?.matches, scenario.matches.instanceDigest);
      assert.equal(detail?.fields?.controller?.controlGeneration?.matches, scenario.matches.controlGeneration);
      return true;
    });
    assert.equal(store.inspect(armed.token).status, 'attested');
    assert.equal(store.inspect(armed.token).revision, 2);
  }
});

test('Codex capability compare-and-swap preserves a competing attestation', () => {
  const root = mkdtempSync('codex-capability-cas-');
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
  const root = mkdtempSync('codex-capability-concurrent-');
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

  try {
    await Promise.all(workers.map(nextMessage));
    workers[0]!.postMessage('go');
    assert.notEqual(Atomics.wait(state, 0, 0, 1_000), 'timed-out');
    workers[1]!.postMessage('go');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondWriterEntered = Atomics.load(state, 1);
    Atomics.store(state, 2, 1);
    Atomics.notify(state, 2, 2);

    const results = await Promise.all(workers.map(nextMessage));
    assert.equal(secondWriterEntered, 0);
    assert.deepEqual(results.map(({ status }) => status).sort(), ['error', 'ok']);
    assert.equal(results.find(({ status }) => status === 'error')?.name, 'CODEX_CAPABILITY_REVISION_CONFLICT');
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

test('Codex capability consume lazily removes old terminal records', () => {
  let now = 1_000;
  let tokenIndex = 0;
  const root = mkdtempSync('codex-capability-consume-sweep-');
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
