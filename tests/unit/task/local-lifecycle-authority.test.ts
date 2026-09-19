import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexCapabilityStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { computeLifecycleBuildIdentity } from '../../../lib/agent-clients/adapters/codex-lifecycle/build-identity.ts';
import {
  contextFromControllerLease,
  writeCodexSandboxControllerContext
} from '../../../lib/agent-clients/adapters/codex-lifecycle/controller-context.ts';
import {
  activeControllerAuthorityState,
  createInactiveControllerAuthorityState,
  writeControllerAuthorityState
} from '../../../lib/sandbox/control/controller-authority-state.ts';
import { getProcessStartTime } from '../../../lib/server/process-state.ts';
import {
  consumeLocalLifecycleAuthorityPhase,
  recoverCommittedLocalLifecycleAuthorityPhase,
  reserveLocalLifecycleAuthorityPhase
} from '../../../lib/task/local-lifecycle-authority.ts';

test('active sandbox lifecycle reserves and consumes the unique attested capability phase', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-lifecycle-authority-'));
  const statusDir = path.join(root, 'status');
  const runtimeDir = path.join(root, 'runtime');
  const contextPath = path.join(root, 'controller-context.json');
  const now = Date.now();
  const processIdentity = { pid: process.pid, startTime: getProcessStartTime(process.pid)! };
  const buildIdentity = computeLifecycleBuildIdentity(process.cwd());
  const leaseSecret = 'e'.repeat(64);
  const lease = {
    version: 1 as const,
    leaseId: 'f'.repeat(64),
    leaseSecret,
    taskId: 'TASK-20260101-000001',
    controlGeneration: 'generation-1',
    controllerInstanceDigest: 'c'.repeat(64),
    controllerProcess: processIdentity,
    buildIdentity,
    issuedAt: now - 1_000,
    expiresAt: now + 60_000
  };
  const hookDefinitionHash = 'd'.repeat(64);
  const env = {
    ...process.env,
    AGENT_INFRA_TASK_ID: lease.taskId,
    AGENT_INFRA_CONTROL_GENERATION: lease.controlGeneration,
    AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
    AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
    AGENT_INFRA_CODEX_CONTROLLER_CONTEXT: contextPath,
    AGENT_INFRA_RUNTIME_DIR: runtimeDir
  };
  try {
    writeCodexSandboxControllerContext(contextPath, contextFromControllerLease(lease, { hookDefinitionHash }));
    const inactive = createInactiveControllerAuthorityState({
      taskId: lease.taskId,
      generation: lease.controlGeneration,
      controlRootId: env.AGENT_INFRA_CONTROL_ROOT_ID
    }, now);
    const registration = {
      version: 1 as const,
      taskId: lease.taskId,
      controlGeneration: lease.controlGeneration,
      containerId: 'container-1',
      leaseId: lease.leaseId,
      leaseSecretHash: crypto.createHash('sha256')
        .update('agent-infra/codex-controller-lease/v1\0').update(leaseSecret).digest('hex'),
      controllerInstanceDigest: lease.controllerInstanceDigest,
      controllerProcess: processIdentity,
      buildIdentity,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt
    };
    writeControllerAuthorityState(statusDir, inactive, { expected: null });
    writeControllerAuthorityState(
      statusDir,
      activeControllerAuthorityState(inactive, registration, inactive.transitionId, now),
      { expected: inactive }
    );
    const capabilityRoot = path.join(runtimeDir, 'clients', 'codex', 'capabilities');
    const store = createCodexCapabilityStore({ root: capabilityRoot });
    const armed = store.arm({
      taskId: lease.taskId,
      buildIdentity,
      controller: { instanceDigest: lease.controllerInstanceDigest, controlGeneration: lease.controlGeneration }
    });
    store.attestByReference({
      capabilityRef: armed.capabilityRef,
      sessionId: 'session-1', turnId: 'turn-1', toolUseId: 'tool-1',
      hookDefinitionHash, buildIdentity,
      controller: { instanceDigest: lease.controllerInstanceDigest, controlGeneration: lease.controlGeneration }
    });
    const attestation = reserveLocalLifecycleAuthorityPhase({
      taskId: lease.taskId,
      family: 'code',
      artifact: 'code.md',
      round: 1,
      operationId: '1'.repeat(64),
      phase: 'artifact.finalize-local',
      lifecycleRequestId: 'code:code.md:finalize'
    }, env);
    assert.ok(attestation);
    assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'reserved');
    consumeLocalLifecycleAuthorityPhase(attestation);
    assert.equal(store.inspectReference(armed.capabilityRef).recoveryPhases[0]?.state, 'consumed');
    const completed = reserveLocalLifecycleAuthorityPhase({
      taskId: lease.taskId,
      family: 'code',
      artifact: 'code.md',
      round: 1,
      operationId: '1'.repeat(64),
      phase: 'task-event.completed',
      lifecycleRequestId: 'lifecycle-request-1'
    }, env);
    assert.ok(completed);
    recoverCommittedLocalLifecycleAuthorityPhase('1'.repeat(64), env);
    assert.equal(store.inspectReference(armed.capabilityRef).recoveryState, 'consumed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
