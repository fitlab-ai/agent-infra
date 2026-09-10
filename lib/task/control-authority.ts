import path from 'node:path';
import crypto from 'node:crypto';

import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import { consumeHumanOverride, failureId, overrideDryRunConflict } from './human-override.ts';
import {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  awaitOrchestrationDelegationActivation,
  beginOrResumeOrchestration,
  dispatchOrchestrationDelegation,
  OrchestrationStateError,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  recoverPreparedOrchestrationDelegation,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation,
  statusOrchestration
} from './orchestration.ts';
import type {
  OrchestrationDiagnosticLogger,
  OrchestrationOptions,
  OrchestrationResult
} from './orchestration.ts';
import { prepareCodexOrchestrationDelegation } from './codex-orchestration.ts';
import {
  applyTaskFinalization,
  type TaskFinalizationRequest,
  type TaskFinalizationResult
} from './finalization.ts';
import {
  applyTaskLifecycle,
  taskLifecycleFailure,
  type TaskLifecycleRequest,
  type TaskLifecycleResult
} from './lifecycle.ts';
import { resolveTaskRef, TASK_ID_RE } from './resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { verifyTaskEvent } from './verification.ts';
import { createCodexCapabilityStore } from '../agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { findArtifactRepairIntentsByOperation } from './artifact-repair-intent.ts';
import {
  computeLifecycleBuildIdentity,
  type LifecycleBuildIdentity
} from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';

export type LifecycleAuthorityPhase =
  | 'orchestration.prepare'
  | 'artifact.finalize-local'
  | 'task-event.completed';

export type LifecycleAuthorityRequestV1 = Readonly<{
  version: 1;
  requestId: string;
  operationId: string;
  phase: LifecycleAuthorityPhase;
  taskId: string;
  family: 'analysis' | 'plan' | 'code';
  artifact: string;
  round: number;
  lifecycleRequestId: string;
  authorityRef: string;
  expectedControlGeneration: string;
  expectedControllerInstanceDigest: string;
  expectedBuildIdentityDigest: string;
  expectedHookDefinitionHash: string;
}>;

export type LifecycleRecoveryAttestationV1 = Readonly<{
  version: 1;
  attestationId: string;
  authorityRefDigest: string;
  operationId: string;
  phase: LifecycleAuthorityPhase;
  requestId: string;
  lifecycleRequestId: string;
  taskId: string;
  family: 'analysis' | 'plan' | 'code';
  artifact: string;
  round: number;
  controlGeneration: string;
  controllerInstanceDigest: string;
  sessionId: string;
  turnId: string;
  toolUseId: string;
  buildIdentityDigest: string;
  hookDefinitionHash: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type LifecycleAuthorityResponseV1 = Readonly<{
  version: 1;
  requestId: string;
  operationId: string;
  phase: LifecycleAuthorityPhase;
  status: 'issued' | 'already-completed' | 'rejected';
  attestation: LifecycleRecoveryAttestationV1 | null;
  error: { code: string; message: string } | null;
}>;

type LifecycleAuthorityIssuerOptions = Readonly<{
  controllerBinding?: TaskControlControllerBinding | null;
  capabilityStore?: ReturnType<typeof createCodexCapabilityStore>;
  buildIdentity?: LifecycleBuildIdentity;
  now?: () => number;
  operationAttestations?: Map<string, LifecycleRecoveryAttestationV1>;
}>;

export type LifecycleRecoveryOperationQueryV1 = Readonly<{
  version: 1;
  operationId: string;
  status: 'unknown' | 'in-progress' | 'committed';
  capabilityState: 'unknown' | 'reserved' | 'consumed';
  phases: readonly Readonly<{
    phase: LifecycleAuthorityPhase;
    requestId: string;
    attestationId: string | null;
    state: 'issued' | 'consumed' | 'observed';
  }>[];
}>;

const lifecycleAuthorityPhases: readonly LifecycleAuthorityPhase[] = [
  'orchestration.prepare', 'artifact.finalize-local', 'task-event.completed'
];
const lifecycleAuthorityFamilies = ['analysis', 'plan', 'code'] as const;
const lifecycleAuthorityArtifact = /^(?:analysis|plan|code)(?:-r[1-9]\d*)?\.md$/u;
const lifecycleAuthorityDigest = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const lifecycleAuthorityBuildDigest = (value: LifecycleBuildIdentity): string => lifecycleAuthorityDigest(JSON.stringify(value));

export function lifecycleRecoveryAttestationDigest(value: LifecycleRecoveryAttestationV1): string {
  return lifecycleAuthorityDigest(JSON.stringify(value));
}

function authorityExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validateLifecycleAuthorityRequest(value: unknown): LifecycleAuthorityRequestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LIFECYCLE_AUTHORITY_REQUEST_INVALID');
  const request = value as Record<string, unknown>;
  if (!authorityExactKeys(request, [
    'artifact', 'authorityRef', 'expectedBuildIdentityDigest', 'expectedControlGeneration',
    'expectedControllerInstanceDigest', 'expectedHookDefinitionHash', 'family', 'lifecycleRequestId',
    'operationId', 'phase', 'requestId', 'round', 'taskId', 'version'
  ])
    || request.version !== 1
    || typeof request.requestId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(request.requestId)
    || typeof request.operationId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(request.operationId)
    || !lifecycleAuthorityPhases.includes(request.phase as LifecycleAuthorityPhase)
    || typeof request.taskId !== 'string' || !/^TASK-\d{8}-\d{6}$/u.test(request.taskId)
    || !lifecycleAuthorityFamilies.includes(request.family as typeof lifecycleAuthorityFamilies[number])
    || typeof request.artifact !== 'string' || !lifecycleAuthorityArtifact.test(request.artifact)
    || !Number.isSafeInteger(request.round) || (request.round as number) < 1
    || typeof request.lifecycleRequestId !== 'string' || !request.lifecycleRequestId || /[\r\n]/u.test(request.lifecycleRequestId)
    || typeof request.authorityRef !== 'string' || !request.authorityRef || /[\r\n]/u.test(request.authorityRef)
    || typeof request.expectedControlGeneration !== 'string' || !request.expectedControlGeneration
    || typeof request.expectedControllerInstanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedControllerInstanceDigest)
    || typeof request.expectedBuildIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedBuildIdentityDigest)
    || typeof request.expectedHookDefinitionHash !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedHookDefinitionHash)) {
    throw new Error('LIFECYCLE_AUTHORITY_REQUEST_INVALID');
  }
  const expectedArtifactFamily = request.artifact as string;
  if (!expectedArtifactFamily.startsWith(request.family as string)) throw new Error('LIFECYCLE_AUTHORITY_REQUEST_INVALID');
  return request as LifecycleAuthorityRequestV1;
}

export function validateLifecycleRecoveryAttestation(
  value: unknown,
  now = Date.now()
): LifecycleRecoveryAttestationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LIFECYCLE_AUTHORITY_ATTESTATION_INVALID');
  const attestation = value as Record<string, unknown>;
  if (!authorityExactKeys(attestation, [
    'artifact', 'attestationId', 'authorityRefDigest', 'buildIdentityDigest', 'controlGeneration',
    'controllerInstanceDigest', 'expiresAt', 'family', 'hookDefinitionHash', 'issuedAt',
    'lifecycleRequestId', 'operationId', 'phase', 'requestId', 'round', 'sessionId',
    'taskId', 'toolUseId', 'turnId', 'version'
  ])
    || attestation.version !== 1
    || typeof attestation.attestationId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(attestation.attestationId)
    || typeof attestation.authorityRefDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(attestation.authorityRefDigest)
    || typeof attestation.operationId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(attestation.operationId)
    || !lifecycleAuthorityPhases.includes(attestation.phase as LifecycleAuthorityPhase)
    || typeof attestation.requestId !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(attestation.requestId)
    || typeof attestation.lifecycleRequestId !== 'string' || !attestation.lifecycleRequestId
    || typeof attestation.taskId !== 'string' || !/^TASK-\d{8}-\d{6}$/u.test(attestation.taskId)
    || !lifecycleAuthorityFamilies.includes(attestation.family as typeof lifecycleAuthorityFamilies[number])
    || typeof attestation.artifact !== 'string' || !lifecycleAuthorityArtifact.test(attestation.artifact)
    || !Number.isSafeInteger(attestation.round) || (attestation.round as number) < 1
    || typeof attestation.controlGeneration !== 'string' || !attestation.controlGeneration
    || typeof attestation.controllerInstanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(attestation.controllerInstanceDigest)
    || typeof attestation.sessionId !== 'string' || !attestation.sessionId
    || typeof attestation.turnId !== 'string' || !attestation.turnId
    || typeof attestation.toolUseId !== 'string' || !attestation.toolUseId
    || typeof attestation.buildIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(attestation.buildIdentityDigest)
    || typeof attestation.hookDefinitionHash !== 'string' || !/^[a-f0-9]{64}$/u.test(attestation.hookDefinitionHash)
    || !Number.isSafeInteger(attestation.issuedAt) || !Number.isSafeInteger(attestation.expiresAt)
    || (attestation.expiresAt as number) <= (attestation.issuedAt as number)
    || (attestation.expiresAt as number) <= now) {
    throw new Error('LIFECYCLE_AUTHORITY_ATTESTATION_INVALID');
  }
  return attestation as LifecycleRecoveryAttestationV1;
}

const authorityOperationMap = new WeakMap<object, Map<string, LifecycleRecoveryAttestationV1>>();
const authorityRecords = new Map<string, Readonly<{
  store: ReturnType<typeof createCodexCapabilityStore>;
  capabilityRef: string;
  expected: Readonly<{
    taskId: string;
    hookDefinitionHash: string;
    buildIdentity: LifecycleBuildIdentity;
    controller: TaskControlControllerBinding;
  }>;
}>>();
const consumedAuthorityPhases = new Set<string>();

export function issueLifecycleRecoveryAttestation(
  input: LifecycleAuthorityRequestV1,
  options: LifecycleAuthorityIssuerOptions = {}
): LifecycleAuthorityResponseV1 {
  let request: LifecycleAuthorityRequestV1;
  try { request = validateLifecycleAuthorityRequest(input); }
  catch (error) {
    return { version: 1, requestId: String((input as { requestId?: unknown })?.requestId ?? ''), operationId: String((input as { operationId?: unknown })?.operationId ?? ''), phase: (input as { phase?: LifecycleAuthorityPhase })?.phase ?? 'artifact.finalize-local', status: 'rejected', attestation: null, error: { code: 'LIFECYCLE_AUTHORITY_REQUEST_INVALID', message: error instanceof Error ? error.message : String(error) } };
  }
  const binding = options.controllerBinding ?? null;
  if (!binding) return authorityRejected(request, 'LOCAL_EXECUTION_AUTHORITY_UNAVAILABLE', 'current controller authority is unavailable');
  if (binding.controlGeneration !== request.expectedControlGeneration
    || binding.instanceDigest !== request.expectedControllerInstanceDigest) {
    return authorityRejected(request, 'LIFECYCLE_AUTHORITY_CONTROLLER_MISMATCH', 'current controller binding does not match the request');
  }
  const buildIdentity = options.buildIdentity ?? computeLifecycleBuildIdentity(process.cwd());
  if (lifecycleAuthorityBuildDigest(buildIdentity) !== request.expectedBuildIdentityDigest) {
    return authorityRejected(request, 'LIFECYCLE_AUTHORITY_BUILD_MISMATCH', 'current lifecycle build does not match the request');
  }
  const store = options.capabilityStore ?? createCodexCapabilityStore();
  const registry = options.operationAttestations ?? authorityOperationMap.get(store) ?? new Map<string, LifecycleRecoveryAttestationV1>();
  authorityOperationMap.set(store, registry);
  const key = `${request.requestId}\0${request.operationId}\0${request.phase}`;
  const prior = registry.get(key);
  if (prior) return { version: 1, requestId: request.requestId, operationId: request.operationId, phase: request.phase, status: 'already-completed', attestation: prior, error: null };
  try {
    const expected = {
      taskId: request.taskId,
      hookDefinitionHash: request.expectedHookDefinitionHash,
      buildIdentity,
      controller: binding
    };
    const record = store.reserveReference(request.authorityRef, request.operationId, expected);
    if (!record.sessionId || !record.turnId || !record.toolUseId) throw new Error('CODEX_CAPABILITY_IDENTITY_INVALID: capability hook attestation is incomplete');
    const now = (options.now ?? Date.now)();
    const attestation = validateLifecycleRecoveryAttestation({
      version: 1,
      attestationId: crypto.randomUUID(),
      authorityRefDigest: lifecycleAuthorityDigest(request.authorityRef),
      operationId: request.operationId,
      phase: request.phase,
      requestId: request.requestId,
      lifecycleRequestId: request.lifecycleRequestId,
      taskId: request.taskId,
      family: request.family,
      artifact: request.artifact,
      round: request.round,
      controlGeneration: binding.controlGeneration,
      controllerInstanceDigest: binding.instanceDigest,
      sessionId: record.sessionId,
      turnId: record.turnId,
      toolUseId: record.toolUseId,
      buildIdentityDigest: lifecycleAuthorityBuildDigest(buildIdentity),
      hookDefinitionHash: request.expectedHookDefinitionHash,
      issuedAt: now,
      expiresAt: Math.min(record.expiresAt, now + 30_000)
    }, now);
    store.reserveRecoveryPhase(
      request.authorityRef,
      request.operationId,
      request.phase,
      request.requestId,
      expected
    );
    registry.set(key, attestation);
    authorityRecords.set(attestation.attestationId, { store, capabilityRef: request.authorityRef, expected });
    return { version: 1, requestId: request.requestId, operationId: request.operationId, phase: request.phase, status: 'issued', attestation, error: null };
  } catch (error) {
    return authorityRejected(request, error instanceof Error && error.name.startsWith('CODEX_') ? error.name : 'LIFECYCLE_AUTHORITY_REJECTED', error instanceof Error ? error.message : String(error));
  }
}

export function consumeLifecycleRecoveryAttestation(
  value: LifecycleRecoveryAttestationV1,
  now = Date.now()
): void {
  const attestation = validateLifecycleRecoveryAttestation(value, now);
  if (consumedAuthorityPhases.has(attestation.attestationId)) return;
  const record = authorityRecords.get(attestation.attestationId);
  if (!record) throw new Error('LIFECYCLE_AUTHORITY_ATTESTATION_UNKNOWN');
  record.store.consumeRecoveryPhase(
    record.capabilityRef,
    attestation.operationId,
    attestation.phase,
    attestation.requestId,
    record.expected
  );
  if (attestation.phase === 'task-event.completed') {
    record.store.consumeReference(record.capabilityRef, attestation.operationId, record.expected);
  }
  consumedAuthorityPhases.add(attestation.attestationId);
}

export function queryLifecycleRecoveryOperation(
  operationId: string,
  options: Readonly<{
    repoRoot?: string;
    capabilityStore?: ReturnType<typeof createCodexCapabilityStore>;
  }> = {}
): LifecycleRecoveryOperationQueryV1 {
  if (!/^[a-f0-9-]{16,64}$/u.test(operationId)) {
    throw new Error('LIFECYCLE_RECOVERY_OPERATION_INVALID');
  }
  const store = options.capabilityStore ?? createCodexCapabilityStore();
  const registry = authorityOperationMap.get(store);
  const known = [...(registry?.values() ?? [])].filter((value) => value.operationId === operationId);
  const intents = options.repoRoot ? findArtifactRepairIntentsByOperation(options.repoRoot, operationId) : [];
  const capabilities = store.findByRecoveryOperation(operationId);
  const phaseMap = new Map<string, LifecycleRecoveryOperationQueryV1['phases'][number]>();
  for (const capability of capabilities) {
    for (const phase of capability.recoveryPhases) {
      phaseMap.set(`${phase.phase}\0${phase.requestId}`, {
        phase: phase.phase,
        requestId: phase.requestId,
        attestationId: null,
        state: phase.state === 'consumed' ? 'consumed' : 'observed'
      });
    }
  }
  for (const attestation of known) {
    const key = `${attestation.phase}\0${attestation.requestId}`;
    const durable = phaseMap.get(key);
    phaseMap.set(key, {
      phase: attestation.phase,
      requestId: attestation.requestId,
      attestationId: attestation.attestationId,
      state: durable?.state === 'consumed' || consumedAuthorityPhases.has(attestation.attestationId)
        ? 'consumed' : 'issued'
    });
  }
  for (const intent of intents) {
    if (!intent.phase) continue;
    const key = `${intent.phase}\0${intent.requestId}`;
    if (phaseMap.has(key)) continue;
    phaseMap.set(key, {
      phase: intent.phase,
      requestId: intent.requestId,
      attestationId: null,
      state: intent.state === 'consumed' ? 'consumed' : 'observed'
    });
  }
  const capabilityState = capabilities.some((record) => record.recoveryState === 'consumed')
    ? 'consumed'
    : capabilities.some((record) => record.recoveryState === 'reserved') ? 'reserved' : 'unknown';
  const committed = capabilityState === 'consumed' || intents.some((intent) => intent.state === 'consumed');
  return {
    version: 1,
    operationId,
    status: committed ? 'committed' : capabilityState === 'reserved' || phaseMap.size > 0 ? 'in-progress' : 'unknown',
    capabilityState,
    phases: Object.freeze([...phaseMap.values()])
  };
}

function authorityRejected(request: LifecycleAuthorityRequestV1, code: string, message: string): LifecycleAuthorityResponseV1 {
  return { version: 1, requestId: request.requestId, operationId: request.operationId, phase: request.phase, status: 'rejected', attestation: null, error: { code, message } };
}

export type TaskControlControllerBinding = Readonly<{
  instanceDigest: string;
  controlGeneration: string;
}>;

export type TaskControlExecutionContext =
  | Readonly<{
      source: 'direct-host';
      mode: 'direct-host';
      repoRoot: string;
      runtimeDir?: string;
      controllerBinding?: TaskControlControllerBinding | null;
      lifecycleRecoveryAttestation?: LifecycleRecoveryAttestationV1 | null;
    }>
  | Readonly<{
      source: 'sandbox-executor';
      mode: 'task-bound-sandbox';
      repoRoot: string;
      worktreeRoot: string;
      runtimeDir: string;
      taskId: string;
      generation: string;
      manifestPath: string;
      requestId: string;
      diagnosticLog?: OrchestrationDiagnosticLogger;
      controllerBinding?: TaskControlControllerBinding | null;
      lifecycleRecoveryAttestation?: LifecycleRecoveryAttestationV1 | null;
    }>;

export type TaskControlOrchestrationIntent =
  | 'begin-or-resume'
  | 'route'
  | 'prepare'
  | 'dispatch'
  | 'await-activation'
  | 'recover-prepared'
  | 'hook-start'
  | 'hook-stop'
  | 'advance'
  | 'pause'
  | 'status';

export type TaskControlOperation =
  | Readonly<{ family: 'task-lifecycle'; request: TaskLifecycleControlRequest }>
  | Readonly<{ family: 'task-finalization'; request: TaskFinalizationRequest }>
  | Readonly<{
      family: 'task-orchestration';
      taskRef: string;
      intent: TaskControlOrchestrationIntent;
      input: Readonly<Record<string, unknown>>;
      options?: Omit<OrchestrationOptions, 'repoRoot'>;
    }>;

export type TaskControlDispatchResult = TaskLifecycleResult | TaskFinalizationResult | OrchestrationResult;

export function taskControlOperationKey(operation: TaskControlOperation): string {
  if (operation.family === 'task-finalization') return 'complete';
  if (operation.family === 'task-lifecycle') return operation.request.intent;
  return operation.intent === 'route'
    ? operation.input && operation.input.completed === true ? 'route.clean-completion' : 'route.read'
    : operation.intent;
}

export type TaskLifecycleControlRequest = TaskLifecycleRequest & Readonly<{
  overrideTicket?: string;
  overrideTarget?: string;
  overrideScope?: string;
}>;

function invalidContext(message: string): never {
  throw new Error(`TASK_CONTROL_CONTEXT_INVALID: ${message}`);
}

function absolute(name: string, value: string): string {
  if (!value || !path.isAbsolute(value)) invalidContext(`${name} must be absolute`);
  return path.resolve(value);
}

function binding(value: TaskControlControllerBinding | null | undefined): TaskControlControllerBinding | null | undefined {
  if (value === null || value === undefined) return value;
  if (!/^[a-f0-9]{64}$/u.test(value.instanceDigest) || !value.controlGeneration) {
    invalidContext('controller binding is invalid');
  }
  return value;
}

export function createDirectHostExecutionContext(params: Readonly<{
  repoRoot: string;
  runtimeDir?: string;
  controllerBinding?: TaskControlControllerBinding | null;
  lifecycleRecoveryAttestation?: LifecycleRecoveryAttestationV1 | null;
}>): TaskControlExecutionContext {
  return {
    source: 'direct-host',
    mode: 'direct-host',
    repoRoot: absolute('repoRoot', params.repoRoot),
    ...(params.runtimeDir === undefined ? {} : { runtimeDir: absolute('runtimeDir', params.runtimeDir) }),
    ...(params.controllerBinding === undefined ? {} : { controllerBinding: binding(params.controllerBinding) }),
    ...(params.lifecycleRecoveryAttestation === undefined ? {} : {
      lifecycleRecoveryAttestation: params.lifecycleRecoveryAttestation === null
        ? null : validateLifecycleRecoveryAttestation(params.lifecycleRecoveryAttestation)
    })
  };
}

export function createSandboxExecutorExecutionContext(params: Readonly<{
  repoRoot: string;
  worktreeRoot: string;
  runtimeDir: string;
  taskId: string;
  generation: string;
  manifestPath: string;
  requestId: string;
  diagnosticLog?: OrchestrationDiagnosticLogger;
  controllerBinding?: TaskControlControllerBinding | null;
  lifecycleRecoveryAttestation?: LifecycleRecoveryAttestationV1 | null;
}>): TaskControlExecutionContext {
  if (!/^TASK-\d{8}-\d{6}$/u.test(params.taskId) || !params.generation || !params.requestId) {
    invalidContext('sandbox binding is incomplete');
  }
  const controlRoot = path.dirname(path.resolve(params.manifestPath));
  if (path.resolve(params.runtimeDir) !== path.join(controlRoot, 'runtime')) {
    invalidContext('runtimeDir is not bound to the manifest control root');
  }
  return {
    source: 'sandbox-executor',
    mode: 'task-bound-sandbox',
    repoRoot: absolute('repoRoot', params.repoRoot),
    worktreeRoot: absolute('worktreeRoot', params.worktreeRoot),
    runtimeDir: absolute('runtimeDir', params.runtimeDir),
    taskId: params.taskId,
    generation: params.generation,
    manifestPath: absolute('manifestPath', params.manifestPath),
    requestId: params.requestId,
    ...(params.diagnosticLog === undefined ? {} : { diagnosticLog: params.diagnosticLog }),
    ...(params.controllerBinding === undefined ? {} : { controllerBinding: binding(params.controllerBinding) }),
    ...(params.lifecycleRecoveryAttestation === undefined ? {} : {
      lifecycleRecoveryAttestation: params.lifecycleRecoveryAttestation === null
        ? null : validateLifecycleRecoveryAttestation(params.lifecycleRecoveryAttestation)
    })
  };
}

export function assertTaskControlExecutionContext(context: TaskControlExecutionContext): void {
  if (context.source === 'direct-host') {
    if (context.mode !== 'direct-host') invalidContext('direct-host mode is inconsistent');
    absolute('repoRoot', context.repoRoot);
    if (context.runtimeDir !== undefined) absolute('runtimeDir', context.runtimeDir);
    binding(context.controllerBinding);
    if (context.lifecycleRecoveryAttestation) validateLifecycleRecoveryAttestation(context.lifecycleRecoveryAttestation);
    return;
  }
  if (context.mode !== 'task-bound-sandbox' || !/^TASK-\d{8}-\d{6}$/u.test(context.taskId)
    || !context.generation || !context.requestId) {
    invalidContext('sandbox executor context is incomplete');
  }
  absolute('repoRoot', context.repoRoot);
  absolute('worktreeRoot', context.worktreeRoot);
  absolute('runtimeDir', context.runtimeDir);
  absolute('manifestPath', context.manifestPath);
  if (path.resolve(context.runtimeDir) !== path.join(path.dirname(path.resolve(context.manifestPath)), 'runtime')) {
    invalidContext('runtimeDir is not bound to the manifest control root');
  }
  binding(context.controllerBinding);
  if (context.lifecycleRecoveryAttestation) validateLifecycleRecoveryAttestation(context.lifecycleRecoveryAttestation);
}

function operationTaskId(context: TaskControlExecutionContext, taskRef: string): void {
  if (context.source === 'sandbox-executor' && taskRef !== context.taskId) {
    throw new Error('TASK_CONTROL_CONTEXT_TASK_MISMATCH: operation task does not match the sandbox manifest');
  }
}

function domainOptions(
  context: TaskControlExecutionContext,
  options: Omit<OrchestrationOptions, 'repoRoot'> | undefined
): OrchestrationOptions {
  return {
    ...options,
    repoRoot: context.repoRoot,
    ...(context.source === 'sandbox-executor' && context.diagnosticLog !== undefined
      ? { diagnosticLog: context.diagnosticLog }
      : {}),
    ...(context.source === 'sandbox-executor' ? { gitWorktreeRoot: context.worktreeRoot } : {})
  };
}

function lifecycleTaskId(request: TaskLifecycleControlRequest, repoRoot: string): string | null {
  if (request.intent === 'restore') return TASK_ID_RE.test(request.taskRef) ? request.taskRef : null;
  try {
    const resolved = resolveTaskRef(request.taskRef, { repoRoot });
    return resolved.ok ? resolved.taskId : null;
  } catch {
    return null;
  }
}

async function applyLifecycleWithAuthority(
  context: TaskControlExecutionContext,
  request: TaskLifecycleControlRequest
): Promise<TaskLifecycleResult & { humanOverride?: unknown }> {
  const conflict = overrideDryRunConflict(request as unknown as Record<string, unknown>);
  if (conflict) {
    return taskLifecycleFailure(request, { code: 'LIFECYCLE_PAYLOAD_INVALID', message: conflict.message });
  }
  const execute = async (): Promise<TaskLifecycleResult & { humanOverride?: unknown }> => {
    const lifecycleResult = applyTaskLifecycle(request, { repoRoot: context.repoRoot });
    if (lifecycleResult.status !== 'failed' || !request.overrideTicket) return lifecycleResult;
    if (!request.overrideTarget || !request.overrideScope) {
      return {
        ...lifecycleResult,
        error: { code: 'OVERRIDE_PAYLOAD_INVALID', message: 'override ticket requires --override-target and --override-scope' }
      };
    }
    const override = await consumeHumanOverride({
      taskRef: request.taskRef,
      ticketId: request.overrideTicket,
      failureId: failureId('lifecycle.apply', lifecycleResult.error?.code ?? 'LIFECYCLE_FAILED'),
      target: request.overrideTarget,
      scope: request.overrideScope,
      intent: request.intent,
      ...('alertNumber' in request && request.alertNumber ? { alertNumber: request.alertNumber } : {}),
      ...('issueNumber' in request && request.issueNumber ? { issueNumber: request.issueNumber } : {}),
      ...('stagingDir' in request && request.stagingDir ? { stagingDir: request.stagingDir } : {})
    }, { repoRoot: context.repoRoot });
    if (override.status === 'failed') return { ...lifecycleResult, humanOverride: override };
    return { ...lifecycleResult, ...override, humanOverride: override, error: null };
  };
  const taskId = lifecycleTaskId(request, context.repoRoot);
  if (!taskId) return await execute();
  try {
    return await withTaskExecutionLock(
      context.repoRoot,
      taskId,
      `task-lifecycle.${request.intent}`,
      execute
    );
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    return taskLifecycleFailure(request, { code: error.code, message: error.message }, taskId);
  }
}

function orchestration(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-orchestration' }>
): OrchestrationResult | Promise<OrchestrationResult> {
  operationTaskId(context, operation.taskRef);
  const input = operation.input;
  const options = domainOptions(context, operation.options);
  switch (operation.intent) {
    case 'begin-or-resume':
      return beginOrResumeOrchestration(operation.taskRef, {
        ...options,
        client: input.client as AgentClientId,
        maxSteps: input.maxSteps as number | undefined,
        modelPolicy: input.modelPolicy as OrchestrationOptions['modelPolicy']
      });
    case 'route': return routeOrchestration(operation.taskRef, options);
    case 'status': return statusOrchestration(operation.taskRef, options);
    case 'prepare': {
      const prepareInput = {
        client: input.client as AgentClientId,
        requestedModel: input.requestedModel as string | undefined,
        requestedReasoningEffort: input.requestedReasoningEffort as string | undefined,
        ...(input.capabilityRef === undefined ? {} : { capabilityRef: input.capabilityRef as string }),
        ...(context.lifecycleRecoveryAttestation === undefined
          ? {}
          : { lifecycleRecoveryAttestation: context.lifecycleRecoveryAttestation })
      };
      if (prepareInput.client === 'codex') {
        return prepareCodexOrchestrationDelegation(operation.taskRef, prepareInput, {
          repoRoot: context.repoRoot,
          orchestrationOptions: options,
          deferLifecycleRecoveryConsumption: context.source === 'sandbox-executor',
          ...(context.controllerBinding ? { controllerBinding: context.controllerBinding } : {})
        });
      }
      return prepareOrchestrationDelegation(operation.taskRef, prepareInput, options);
    }
    case 'dispatch': return dispatchOrchestrationDelegation(operation.taskRef, options);
    case 'await-activation':
      return awaitOrchestrationDelegationActivation(operation.taskRef, input.event as never, options);
    case 'recover-prepared': return recoverPreparedOrchestrationDelegation(operation.taskRef, options);
    case 'hook-start':
      return input.auto === true
        ? activateMatchingOrchestrationDelegation(input.client as AgentClientId, input.event as never, options)
        : activateOrchestrationDelegation(operation.taskRef, input.event as never, options);
    case 'hook-stop':
      return input.auto === true
        ? sealMatchingOrchestrationDelegation(input.client as AgentClientId, input.event as never, options)
        : sealOrchestrationDelegation(operation.taskRef, input.event as never, options);
    case 'advance': return advanceOrchestration(operation.taskRef, options);
    case 'pause':
      return pauseOrchestration(
        operation.taskRef,
        input.code as string,
        input.message as string,
        input.recoverable as boolean,
        options
      );
  }
}

function orchestrationFailure(error: unknown): OrchestrationResult {
  if (error instanceof OrchestrationStateError) {
    return {
      status: 'failed', changed: false, taskId: error.taskId, run: null, next: null,
      error: { code: error.code, message: error.message }
    };
  }
  throw error;
}

export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-lifecycle' }>
): Promise<TaskLifecycleResult & { humanOverride?: unknown }>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-finalization' }>
): Promise<TaskFinalizationResult>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: Extract<TaskControlOperation, { family: 'task-orchestration' }>
): OrchestrationResult | Promise<OrchestrationResult>;
export function dispatchTaskControlOperation(
  context: TaskControlExecutionContext,
  operation: TaskControlOperation
): TaskControlDispatchResult | Promise<TaskControlDispatchResult> {
  assertTaskControlExecutionContext(context);
  assertTaskControlOperation(operation);
  if (operation.family === 'task-lifecycle') {
    operationTaskId(context, operation.request.taskRef);
    return applyLifecycleWithAuthority(context, operation.request);
  }
  if (operation.family === 'task-finalization') {
    operationTaskId(context, operation.request.taskRef);
    return applyTaskFinalization(operation.request, {
      repoRoot: context.repoRoot,
      ...(context.source === 'sandbox-executor' ? {
        controlBinding: { generation: context.generation, requestId: context.requestId }
      } : {}),
      preflight: (request, options) => verifyTaskEvent(
        { ...request, event: 'complete-task.hard-preflight' }, options
      )
    });
  }
  try {
    const result = orchestration(context, operation);
    return result instanceof Promise ? result.catch(orchestrationFailure) : result;
  } catch (error) {
    return orchestrationFailure(error);
  }
}

export function assertTaskControlOperation(operation: TaskControlOperation): void {
  if (operation.family === 'task-lifecycle') {
    if (!operation.request.taskRef || !normalizeAgentToken(operation.request.agent)) {
      throw new Error('TASK_CONTROL_OPERATION_INVALID: lifecycle request is invalid');
    }
    return;
  }
  if (operation.family === 'task-finalization') {
    if (!operation.request.taskRef || !normalizeAgentToken(operation.request.agent)) {
      throw new Error('TASK_CONTROL_OPERATION_INVALID: finalization request is invalid');
    }
    return;
  }
  if (!operation.taskRef || !operation.intent || !operation.input || typeof operation.input !== 'object' || Array.isArray(operation.input)) {
    throw new Error('TASK_CONTROL_OPERATION_INVALID: orchestration operation is invalid');
  }
}

function operationInvalid(message: string): never {
  throw new Error(`TASK_CONTROL_OPERATION_INVALID: ${message}`);
}

const LIFECYCLE_FLAGS = new Set([
  '--agent', '--reason', '--unblock-condition', '--note', '--alert-number', '--staging-dir', '--issue-number',
  '--override-ticket', '--override-target', '--override-scope', '--dry-run'
]);

const FINALIZATION_FLAGS = new Set(['--agent']);

const ORCHESTRATION_FLAGS = new Set([
  '--agent', '--max-steps', '--executor-model', '--executor-reasoning-effort', '--reviewer-model',
  '--reviewer-reasoning-effort', '--client', '--requested-model', '--requested-reasoning-effort',
  '--capability-ref', '--parent-id', '--before-fingerprint', '--stage', '--round', '--artifact', '--role',
  '--native-agent', '--child-id', '--spawn-mode', '--actual-model', '--actual-reasoning-effort',
  '--model-fallback-reason', '--reasoning-effort-fallback-reason', '--exit-code', '--after-fingerprint',
  '--changed-paths', '--code', '--message', '--recoverable', '--git-worktree-root'
]);

function parseValues(
  args: readonly string[],
  start: number,
  flags: ReadonlySet<string>
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (let index = start; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (!flags.has(flag)) operationInvalid(`unknown option '${flag}'`);
      if (values[flag] !== undefined) operationInvalid(`duplicate option '${flag}'`);
      values[flag] = true;
      continue;
    }
    if (!flags.has(flag)) operationInvalid(`unknown option '${flag}'`);
    if (values[flag] !== undefined) operationInvalid(`duplicate option '${flag}'`);
    const value = args[++index];
    if (!value || value.startsWith('--')) operationInvalid(`option '${flag}' requires a value`);
    values[flag] = value;
  }
  return values;
}

function value(values: Record<string, string | boolean>, flag: string): string | undefined {
  const current = values[flag];
  return typeof current === 'string' ? current : undefined;
}

function required(values: Record<string, string | boolean>, flags: readonly string[]): void {
  const missing = flags.find((flag) => value(values, flag) === undefined);
  if (missing) operationInvalid(`option '${missing}' is required`);
}

export function parseTaskControlOperation(
  family: 'task-lifecycle' | 'task-orchestration' | 'task-finalization',
  args: readonly string[]
): TaskControlOperation {
  if (family === 'task-finalization') {
    if (args.length !== 4 || args[1] !== 'complete' || args[2] !== '--agent' || !args[0] || !args[3]) {
      operationInvalid('task ref, complete intent, and --agent are required');
    }
    const values = parseValues(args, 2, FINALIZATION_FLAGS);
    const agent = normalizeAgentToken(value(values, '--agent') ?? '');
    if (!agent) operationInvalid('finalization agent is invalid');
    return { family, request: { taskRef: args[0]!, intent: 'complete', agent } };
  }
  if (args.length < 2) operationInvalid('task ref and intent are required');
  const taskRef = args[0]!;
  const intent = args[1]!;
  if (family === 'task-lifecycle') {
    const values = parseValues(args, 2, LIFECYCLE_FLAGS);
    const agent = normalizeAgentToken(value(values, '--agent') ?? '');
    if (!agent) operationInvalid('lifecycle agent is invalid');
    const input: Record<string, unknown> = {
      taskRef,
      intent,
      agent,
      ...(value(values, '--reason') ? { reason: value(values, '--reason') } : {}),
      ...(value(values, '--unblock-condition') ? { unblockCondition: value(values, '--unblock-condition') } : {}),
      ...(value(values, '--note') ? { note: value(values, '--note') } : {}),
      ...(value(values, '--staging-dir') ? { stagingDir: value(values, '--staging-dir') } : {}),
      ...(value(values, '--override-ticket') ? { overrideTicket: value(values, '--override-ticket') } : {}),
      ...(value(values, '--override-target') ? { overrideTarget: value(values, '--override-target') } : {}),
      ...(value(values, '--override-scope') ? { overrideScope: value(values, '--override-scope') } : {}),
      ...(value(values, '--alert-number') ? { alertNumber: Number(value(values, '--alert-number')) } : {}),
      ...(value(values, '--issue-number') ? { issueNumber: Number(value(values, '--issue-number')) } : {}),
      ...(values['--dry-run'] === true ? { dryRun: true } : {})
    };
    return { family, request: input as unknown as TaskLifecycleControlRequest };
  }

  const values = parseValues(args, 2, ORCHESTRATION_FLAGS);
  const orchestrationIntents = new Set<TaskControlOrchestrationIntent>([
    'begin-or-resume', 'route', 'prepare', 'dispatch', 'await-activation', 'recover-prepared',
    'hook-start', 'hook-stop', 'advance', 'pause', 'status'
  ]);
  if (!orchestrationIntents.has(intent as TaskControlOrchestrationIntent)) {
    operationInvalid(`unknown orchestration intent '${intent}'`);
  }
  const client = value(values, '--client');
  if (client !== undefined && !isAgentClientId(client)) operationInvalid(`unknown client '${client}'`);
  const parsedIntent = intent as TaskControlOrchestrationIntent;
  const input: Record<string, unknown> = {};
  if (parsedIntent === 'begin-or-resume' || parsedIntent === 'prepare') {
    required(values, ['--client']);
    if (!client || !isAgentClientId(client)) operationInvalid(`unknown client '${client ?? ''}'`);
    input.client = client;
  }
  if (parsedIntent === 'begin-or-resume') {
    const maxSteps = value(values, '--max-steps');
    if (maxSteps !== undefined) {
      const parsed = Number(maxSteps);
      if (!Number.isInteger(parsed) || parsed < 1) operationInvalid('--max-steps must be a positive integer');
      input.maxSteps = parsed;
    }
    const policyFlags = ['--executor-model', '--executor-reasoning-effort', '--reviewer-model', '--reviewer-reasoning-effort'];
    const hasPolicy = policyFlags.some((flag) => value(values, flag) !== undefined);
    if (hasPolicy && policyFlags.some((flag) => value(values, flag) === undefined)) {
      operationInvalid('explicit model policy requires executor/reviewer model and reasoning effort');
    }
    if (hasPolicy) {
      input.modelPolicy = {
        executor: { model: value(values, '--executor-model'), reasoningEffort: value(values, '--executor-reasoning-effort') },
        reviewer: { model: value(values, '--reviewer-model'), reasoningEffort: value(values, '--reviewer-reasoning-effort') }
      };
    }
  }
  if (parsedIntent === 'prepare') {
    input.requestedModel = value(values, '--requested-model');
    input.requestedReasoningEffort = value(values, '--requested-reasoning-effort');
    input.capabilityRef = value(values, '--capability-ref');
  }
  if (parsedIntent === 'await-activation') {
    required(values, ['--stage', '--round', '--artifact', '--role']);
    const round = Number(value(values, '--round'));
    if (!Number.isSafeInteger(round) || round < 1) operationInvalid('--round must be a positive integer');
    const role = value(values, '--role');
    if (role !== 'executor' && role !== 'reviewer') operationInvalid('--role must be executor or reviewer');
    input.event = { stage: value(values, '--stage'), round, artifact: value(values, '--artifact'), role };
  }
  if (parsedIntent === 'hook-start') {
    required(values, ['--native-agent', '--child-id', '--parent-id']);
    if (taskRef === 'auto') required(values, ['--client']);
    input.auto = taskRef === 'auto';
    input.client = value(values, '--client');
    input.event = {
      nativeAgent: value(values, '--native-agent'), childId: value(values, '--child-id'), parentId: value(values, '--parent-id'),
      spawnMode: value(values, '--spawn-mode'), actualModel: value(values, '--actual-model'),
      actualReasoningEffort: value(values, '--actual-reasoning-effort'), modelFallbackReason: value(values, '--model-fallback-reason'),
      reasoningEffortFallbackReason: value(values, '--reasoning-effort-fallback-reason')
    };
  }
  if (parsedIntent === 'hook-stop') {
    input.auto = taskRef === 'auto';
    if (input.auto) {
      required(values, ['--client', '--native-agent', '--child-id']);
      input.client = value(values, '--client');
      input.event = {
        nativeAgent: value(values, '--native-agent'), childId: value(values, '--child-id'), actualModel: value(values, '--actual-model'),
        actualReasoningEffort: value(values, '--actual-reasoning-effort'), modelFallbackReason: value(values, '--model-fallback-reason'),
        reasoningEffortFallbackReason: value(values, '--reasoning-effort-fallback-reason')
      };
    } else {
      required(values, ['--child-id', '--exit-code', '--after-fingerprint']);
      const exitCode = Number(value(values, '--exit-code'));
      if (!Number.isInteger(exitCode)) operationInvalid('--exit-code must be an integer');
      input.event = {
        childId: value(values, '--child-id'), exitCode, afterFingerprint: value(values, '--after-fingerprint'),
        changedPaths: value(values, '--changed-paths')?.split(',').filter(Boolean) ?? [], actualModel: value(values, '--actual-model'),
        actualReasoningEffort: value(values, '--actual-reasoning-effort'), modelFallbackReason: value(values, '--model-fallback-reason'),
        reasoningEffortFallbackReason: value(values, '--reasoning-effort-fallback-reason')
      };
    }
  }
  if (parsedIntent === 'pause') {
    required(values, ['--code', '--message', '--recoverable']);
    const recoverable = value(values, '--recoverable');
    if (recoverable !== 'true' && recoverable !== 'false') operationInvalid('--recoverable must be true or false');
    input.code = value(values, '--code'); input.message = value(values, '--message'); input.recoverable = recoverable === 'true';
  }
  const options = value(values, '--git-worktree-root') === undefined
    ? undefined
    : { gitWorktreeRoot: value(values, '--git-worktree-root') };
  return { family, taskRef, intent: parsedIntent, input, ...(options ? { options } : {}) };
}
