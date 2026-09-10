import assert from 'node:assert/strict';
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
  validateLifecycleAuthorityRequest,
  validateLifecycleRecoveryAttestation
} from '../../../lib/task/control-authority.ts';

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
