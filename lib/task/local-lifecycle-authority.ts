import crypto from 'node:crypto';

import { createCodexCapabilityStore } from '../agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { verifySandboxLocalControllerAuthority } from '../agent-clients/adapters/codex-lifecycle/controller-context.ts';
import {
  consumeLifecycleRecoveryAttestation,
  issueLifecycleRecoveryAttestation,
  type LifecycleAuthorityPhase,
  type LifecycleRecoveryAttestationV1
} from './control-authority.ts';
import type { ArtifactSchemaFamily } from './artifact-schema.ts';
import { resolveAgentRuntimeStoreRoot } from '../runtime/agent-runtime.ts';

type PhaseInput = Readonly<{
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  round: number;
  operationId: string;
  phase: Extract<LifecycleAuthorityPhase, 'artifact.finalize-local' | 'task-event.completed'>;
  lifecycleRequestId: string;
}>;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function reserveLocalLifecycleAuthorityPhase(
  input: PhaseInput,
  env: NodeJS.ProcessEnv = process.env
): LifecycleRecoveryAttestationV1 | null {
  const context = verifySandboxLocalControllerAuthority({ env, repoRoot: process.cwd() });
  if (!context) return null;
  const controllerBinding = {
    instanceDigest: context.controllerInstanceDigest,
    controlGeneration: context.controlGeneration
  };
  const expected = {
    taskId: input.taskId,
    hookDefinitionHash: context.hookDefinitionHash,
    buildIdentity: context.buildIdentity,
    controller: controllerBinding
  };
  const store = createCodexCapabilityStore({
    root: resolveAgentRuntimeStoreRoot({ env, store: 'capabilities' })
  });
  const authorityRef = input.phase === 'artifact.finalize-local'
    ? (() => {
        const reserved = store.findByRecoveryOperation(input.operationId);
        if (reserved.length > 1) throw new Error('CODEX_CAPABILITY_AMBIGUOUS');
        if (reserved.length === 1) {
          const reference = `sha256:${reserved[0]!.capabilityRefDigest}`;
          store.validateReference(reference, expected);
          return reference;
        }
        return store.findUniqueAttestedReference(expected);
      })()
    : (() => {
        const matches = store.findByRecoveryOperation(input.operationId);
        if (matches.length !== 1) throw new Error('CODEX_CAPABILITY_AMBIGUOUS');
        return `sha256:${matches[0]!.capabilityRefDigest}`;
      })();
  const requestId = digest(`${input.operationId}\0${input.phase}\0${input.lifecycleRequestId}`);
  const issued = issueLifecycleRecoveryAttestation({
    version: 1,
    requestId,
    operationId: input.operationId,
    phase: input.phase,
    taskId: input.taskId,
    family: input.family,
    artifact: input.artifact,
    round: input.round,
    lifecycleRequestId: input.lifecycleRequestId,
    authorityRef,
    expectedControlGeneration: context.controlGeneration,
    expectedControllerInstanceDigest: context.controllerInstanceDigest,
    expectedBuildIdentityDigest: digest(JSON.stringify(context.buildIdentity)),
    expectedHookDefinitionHash: context.hookDefinitionHash
  }, { capabilityStore: store, controllerBinding, buildIdentity: context.buildIdentity });
  if (!issued.attestation || issued.status === 'rejected') {
    throw new Error(`${issued.error?.code ?? 'LIFECYCLE_AUTHORITY_REJECTED'}: ${issued.error?.message ?? 'lifecycle authority was rejected'}`);
  }
  return issued.attestation;
}

export function consumeLocalLifecycleAuthorityPhase(attestation: LifecycleRecoveryAttestationV1 | null): void {
  if (attestation) consumeLifecycleRecoveryAttestation(attestation);
}

export function recoverCommittedLocalLifecycleAuthorityPhase(
  operationId: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const store = createCodexCapabilityStore({
    root: resolveAgentRuntimeStoreRoot({ env, store: 'capabilities' })
  });
  const matches = store.findByRecoveryOperation(operationId);
  if (matches.length === 0) return;
  if (matches.length !== 1) throw new Error('CODEX_CAPABILITY_AMBIGUOUS');
  const record = matches[0]!;
  const phase = record.recoveryPhases.find((entry) => entry.phase === 'task-event.completed');
  if (!phase || !record.controller || !record.hookDefinitionHash) {
    throw new Error('LIFECYCLE_RECOVERY_PROVENANCE_INVALID');
  }
  const authorityRef = `sha256:${record.capabilityRefDigest}`;
  const expected = {
    taskId: record.taskId,
    hookDefinitionHash: record.hookDefinitionHash,
    buildIdentity: record.buildIdentity,
    controller: record.controller
  };
  if (phase.state === 'issued') {
    store.consumeRecoveryPhase(
      authorityRef, operationId, phase.phase, phase.requestId, expected,
      { allowExpiredReserved: true }
    );
  }
  store.consumeReference(authorityRef, operationId, expected, { allowExpiredReserved: true });
}
