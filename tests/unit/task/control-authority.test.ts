import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexCapabilityStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts';
import {
  consumeLifecycleRecoveryAttestation,
  issueLifecycleRecoveryAttestation,
  queryLifecycleRecoveryOperation,
  recoverLifecycleRecoveryOperation,
  validateLifecycleAuthorityRequest,
  validateLifecycleRecoveryAttestation
} from '../../../lib/task/control-authority.ts';
import { writeArtifactRepairIntent } from '../../../lib/task/artifact-repair-intent.ts';

const build = {
  protocolVersion: 3,
  packageVersion: '1.2.3',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64)
} as const;
const binding = { instanceDigest: 'c'.repeat(64), controlGeneration: 'generation-1' };
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function request(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    phase: 'artifact.finalize-local',
    taskId: 'TASK-20260101-000001',
    family: 'code',
    artifact: 'code.md',
    round: 1,
    lifecycleRequestId: 'lifecycle-request-1',
    authorityRef: ref,
    expectedControlGeneration: binding.controlGeneration,
    expectedControllerInstanceDigest: binding.instanceDigest,
    expectedBuildIdentityDigest: digest(build),
    expectedHookDefinitionHash: 'd'.repeat(64),
    ...overrides
  } as const;
}

test('lifecycle authority reserves a reference and phase retries are idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-'));
  const store = createCodexCapabilityStore({ root, reference: () => 'authority-reference', now: () => 1_000 });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build, controller: binding });
  store.attestByReference({
    capabilityRef: armed.capabilityRef,
    sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    hookDefinitionHash: 'd'.repeat(64), buildIdentity: build, controller: binding
  });
  const input = request(armed.capabilityRef);
  assert.deepEqual(validateLifecycleAuthorityRequest(input), input);
  const issued = issueLifecycleRecoveryAttestation(input, { capabilityStore: store, controllerBinding: binding, buildIdentity: build, now: () => 1_000 });
  assert.equal(issued.status, 'issued');
  assert.ok(issued.attestation);
  assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'reserved');
  assert.equal(queryLifecycleRecoveryOperation(input.operationId, { capabilityStore: store }).status, 'in-progress');
  const retry = issueLifecycleRecoveryAttestation(input, { capabilityStore: store, controllerBinding: binding, buildIdentity: build, now: () => 1_000 });
  assert.equal(retry.status, 'already-completed');
  assert.deepEqual(retry.attestation, issued.attestation);
  assert.doesNotThrow(() => validateLifecycleRecoveryAttestation(issued.attestation, 1_000));
  const completedRequest = request(armed.capabilityRef, {
    requestId: '33333333-3333-4333-8333-333333333333',
    phase: 'task-event.completed',
    lifecycleRequestId: 'lifecycle-request-2'
  });
  const completed = issueLifecycleRecoveryAttestation(completedRequest, {
    capabilityStore: store, controllerBinding: binding, buildIdentity: build, now: () => 1_000
  });
  assert.equal(completed.status, 'issued');
  consumeLifecycleRecoveryAttestation(completed.attestation!, 1_000);
  assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'consumed');
  assert.equal(queryLifecycleRecoveryOperation(input.operationId, { capabilityStore: store }).status, 'committed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('lifecycle authority rejects missing controller proof without reserving', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-unavailable-'));
  const store = createCodexCapabilityStore({ root, reference: () => 'authority-reference', now: () => 1_000 });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build, controller: binding });
  store.attestByReference({
    capabilityRef: armed.capabilityRef,
    sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    hookDefinitionHash: 'd'.repeat(64), buildIdentity: build, controller: binding
  });
  const result = issueLifecycleRecoveryAttestation(request(armed.capabilityRef), { capabilityStore: store, buildIdentity: build });
  assert.equal(result.status, 'rejected');
  assert.equal(result.error?.code, 'LOCAL_EXECUTION_AUTHORITY_UNAVAILABLE');
  assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'unreserved');
  fs.rmSync(root, { recursive: true, force: true });
});

test('lifecycle authority persists phase replay state across requests and store recreation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-restart-'));
  const store = createCodexCapabilityStore({ root, reference: () => 'authority-reference', now: () => 1_000 });
  const armed = store.arm({ taskId: 'TASK-20260101-000001', buildIdentity: build, controller: binding });
  store.attestByReference({
    capabilityRef: armed.capabilityRef,
    sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    hookDefinitionHash: 'd'.repeat(64), buildIdentity: build, controller: binding
  });

  const firstRequest = request(armed.capabilityRef, {
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  });
  const first = issueLifecycleRecoveryAttestation(firstRequest, { capabilityStore: store, controllerBinding: binding, buildIdentity: build, now: () => 1_000 });
  assert.equal(first.status, 'issued');

  const restartedStore = createCodexCapabilityStore({ root, now: () => 1_000 });
  const replay = issueLifecycleRecoveryAttestation(request(armed.capabilityRef, {
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  }), { capabilityStore: restartedStore, controllerBinding: binding, buildIdentity: build, now: () => 1_000 });
  assert.equal(replay.status, 'rejected');
  assert.equal(replay.error?.code, 'CODEX_CAPABILITY_PHASE_REPLAY');

  const observed = queryLifecycleRecoveryOperation(firstRequest.operationId, { capabilityStore: restartedStore });
  assert.equal(observed.status, 'in-progress');
  assert.deepEqual(observed.phases, [{
    phase: 'artifact.finalize-local',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    attestationId: null,
    state: 'observed'
  }]);

  consumeLifecycleRecoveryAttestation(first.attestation!, 1_000);
  const consumed = queryLifecycleRecoveryOperation(observed.operationId, { capabilityStore: restartedStore });
  assert.equal(consumed.phases[0]?.state, 'consumed');

  const completed = issueLifecycleRecoveryAttestation(request(armed.capabilityRef, {
    requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    phase: 'task-event.completed',
    lifecycleRequestId: 'lifecycle-request-2'
  }), { capabilityStore: restartedStore, controllerBinding: binding, buildIdentity: build, now: () => 1_000 });
  assert.equal(completed.status, 'issued');
  consumeLifecycleRecoveryAttestation(completed.attestation!, 1_000);
  assert.equal(queryLifecycleRecoveryOperation(observed.operationId, { capabilityStore: restartedStore }).status, 'committed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('lifecycle recovery compensates a committed task event across processes without replaying the task write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-compensation-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-repo-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  const taskPath = path.join(taskDir, 'task.md');
  const sourcePath = path.resolve('lib/task/control-authority.ts');
  const initialTask = [
    '---',
    `id: ${taskId}`,
    'status: active',
    'current_step: code',
    '---',
    '',
    '# Recovery fixture',
    '',
    '## 活动日志',
    '',
    ''
  ].join('\n');
  const completedTask = `${initialTask}- 2026-01-01 00:00:00+00:00 — **Code Task (Round 1)** by codex — Fixed 0 blockers, 0 major, 0 minor issues → code.md\n`;
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(taskPath, initialTask);
  const store = createCodexCapabilityStore({ root, reference: () => 'authority-reference', now: () => 1_000 });
  const armed = store.arm({ taskId, buildIdentity: build, controller: binding });
  store.attestByReference({
    capabilityRef: armed.capabilityRef,
    sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    hookDefinitionHash: 'd'.repeat(64), buildIdentity: build, controller: binding
  });
  const selector = request(armed.capabilityRef, {
    requestId: '33333333-3333-4333-8333-333333333333',
    phase: 'task-event.completed'
  });
  const issued = issueLifecycleRecoveryAttestation(selector, {
    capabilityStore: store, controllerBinding: binding, buildIdentity: build, now: () => 1_000
  });
  assert.equal(issued.status, 'issued');
  writeArtifactRepairIntent(repoRoot, {
    version: 2,
    taskId,
    family: 'code',
    artifact: 'code.md',
    state: 'commit-started',
    baselineSemanticDigest: null,
    artifactSha256: 'e'.repeat(64),
    semanticDigest: 'f'.repeat(64),
    recoveryOperationId: selector.operationId,
    phase: selector.phase,
    authorityDigest: digest(issued.attestation),
    requestId: selector.lifecycleRequestId,
    createdAt: 1_000,
    updatedAt: 1_000
  });
  store.consumeRecoveryPhase(
    armed.capabilityRef,
    selector.operationId,
    selector.phase,
    issued.attestation!.requestId,
    { taskId, hookDefinitionHash: 'd'.repeat(64), buildIdentity: build, controller: binding }
  );

  const runChild = (childBinding = binding) => {
    const script = `
      const [root, repoRoot, sourcePath, selectorJson, buildJson, bindingJson] = process.argv.slice(1);
      const { createCodexCapabilityStore } = await import(${JSON.stringify(path.resolve('lib/agent-clients/adapters/codex-lifecycle/capability-store.ts'))});
      const { recoverLifecycleRecoveryOperation, queryLifecycleRecoveryOperation } = await import(sourcePath);
      const selector = JSON.parse(selectorJson);
      const result = recoverLifecycleRecoveryOperation(selector, {
        repoRoot,
        capabilityStore: createCodexCapabilityStore({ root, now: () => 1000 }),
        buildIdentity: JSON.parse(buildJson),
        controllerBinding: JSON.parse(bindingJson),
        now: () => 2000
      });
      const query = queryLifecycleRecoveryOperation(selector.operationId, {
        repoRoot,
        capabilityStore: createCodexCapabilityStore({ root, now: () => 1000 })
      });
      process.stdout.write(JSON.stringify({ result, query }));
    `;
    return spawnSync(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '-e', script,
      root, repoRoot, sourcePath, JSON.stringify(selector), JSON.stringify(build), JSON.stringify(childBinding)
    ], { cwd: process.cwd(), encoding: 'utf8' });
  };

  const beforeCommit = runChild();
  assert.notEqual(beforeCommit.status, 0);
  assert.match(`${beforeCommit.stdout}${beforeCommit.stderr}`, /LIFECYCLE_RECOVERY_COMMIT_UNCONFIRMED/u);
  assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'reserved');
  fs.writeFileSync(taskPath, completedTask);
  const taskAfterCommit = fs.readFileSync(taskPath, 'utf8');
  const staleBinding = { ...binding, controlGeneration: 'generation-stale' };
  const staleRecovery = runChild(staleBinding);
  assert.notEqual(staleRecovery.status, 0);
  assert.match(`${staleRecovery.stdout}${staleRecovery.stderr}`, /LIFECYCLE_AUTHORITY_CONTROLLER_MISMATCH/u);
  const recovered = runChild();
  assert.equal(recovered.status, 0, recovered.stderr);
  const payload = JSON.parse(recovered.stdout) as {
    result: { status: string; capabilityState: string };
    query: { status: string; capabilityState: string };
  };
  assert.equal(payload.result.status, 'committed');
  assert.equal(payload.result.capabilityState, 'consumed');
  assert.equal(payload.query.status, 'committed');
  assert.equal(payload.query.capabilityState, 'consumed');
  assert.equal(fs.readFileSync(taskPath, 'utf8'), taskAfterCommit);
  assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'consumed');
  const intentPath = path.join(repoRoot, '.agents', 'workspace', '.local-artifact-finalization-intents', `${taskId}-code-code.md.json`);
  assert.equal(JSON.parse(fs.readFileSync(intentPath, 'utf8')).state, 'consumed');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('lifecycle recovery requires the persisted task event before consuming a reserved capability', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-uncommitted-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-authority-uncommitted-repo-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${taskId}`, 'status: active', 'current_step: code', '---', '',
    '## 活动日志', '', '- 2026-01-01 00:00:00+00:00 — **Code Task (Round 1) [started]** by codex — started', ''
  ].join('\n'));
  const store = createCodexCapabilityStore({ root, reference: () => 'authority-reference', now: () => 1_000 });
  const armed = store.arm({ taskId, buildIdentity: build, controller: binding });
  store.attestByReference({
    capabilityRef: armed.capabilityRef,
    sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
    hookDefinitionHash: 'd'.repeat(64), buildIdentity: build, controller: binding
  });
  const selector = request(armed.capabilityRef, { phase: 'task-event.completed' });
  const issued = issueLifecycleRecoveryAttestation(selector, {
    capabilityStore: store, controllerBinding: binding, buildIdentity: build, now: () => 1_000
  });
  writeArtifactRepairIntent(repoRoot, {
    version: 2, taskId, family: 'code', artifact: 'code.md', state: 'commit-started',
    baselineSemanticDigest: null, artifactSha256: 'e'.repeat(64), semanticDigest: 'f'.repeat(64),
    recoveryOperationId: selector.operationId, phase: selector.phase,
    authorityDigest: digest(issued.attestation), requestId: selector.lifecycleRequestId,
    createdAt: 1_000, updatedAt: 1_000
  });
  assert.throws(() => recoverLifecycleRecoveryOperation(selector, {
    repoRoot, capabilityStore: createCodexCapabilityStore({ root, now: () => 1_000 }),
    buildIdentity: build, controllerBinding: binding, now: () => 2_000
  }), /LIFECYCLE_RECOVERY_COMMIT_UNCONFIRMED/u);
  assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'reserved');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});
