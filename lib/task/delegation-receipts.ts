import { randomUUID } from 'node:crypto';

import type { AgentClientId } from '../agent-clients/types.ts';
import { normalizeAgentToken } from '../agent-clients/tokens.ts';

type DelegationRole = 'executor' | 'reviewer';
type DelegationStage = 'analysis' | 'review-analysis' | 'plan' | 'review-plan' | 'code' | 'review-code' | 'commit';
type DelegationStatus = 'prepared' | 'activated' | 'stage-completed' | 'sealed' | 'consumed' | 'aborted' | 'expired';
type DelegationHostEvidence = Readonly<{
  kind: 'codex-lifecycle-v1' | 'codex-lifecycle-v2';
  hookDefinitionHash: string;
  startRevision: number;
  stopRevision: number | null;
  consumer: string | null;
  consumedAt: string | null;
  protocolVersion?: number;
  packageVersion?: string;
  internalExecutableBuildHash?: string;
  lifecycleContractHash?: string;
  hookSource?: 'project' | 'managed' | 'isolated-user';
  controllerInstanceDigest?: string | null;
  controlGeneration?: string | null;
}>;
type DelegationLifecycleProvenance = Readonly<{
  protocolVersion: number;
  packageVersion: string;
  internalExecutableBuildHash: string;
  lifecycleContractHash: string;
  hookDefinitionHash: string;
  hookSource: 'project' | 'managed' | 'isolated-user';
  controllerInstanceDigest: string | null;
  controlGeneration: string | null;
}>;

type DelegationReceipt = Readonly<{
  id: string;
  taskId: string;
  runId: string;
  role: DelegationRole;
  stage: DelegationStage;
  round: number;
  artifact: string;
  client: AgentClientId;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  actualModel: string | null;
  actualReasoningEffort: string | null;
  modelFallbackReason: string | null;
  reasoningEffortFallbackReason: string | null;
  parentId: string | null;
  childId: string | null;
  spawnMode: string | null;
  agent: string | null;
  status: DelegationStatus;
  workspaceSnapshotScope?: 'task';
  lifecycleProvenance?: DelegationLifecycleProvenance | null;
  hostEvidence?: DelegationHostEvidence | null;
  beforeFingerprint: string;
  afterFingerprint: string | null;
  changedPaths: readonly string[];
  createdAt: string;
  preparedMonotonicMs: number;
  spawnDispatchMonotonicMs: number;
  activationDeadlineMonotonicMs: number;
  startEvidenceMonotonicMs: number | null;
  activatedMonotonicMs: number | null;
  activatedAt: string | null;
  sealedAt: string | null;
  consumedAt: string | null;
}>;

type ReceiptFailure = Readonly<{ ok: false; code: string; message: string; receipt?: never }>;
type ReceiptSuccess = Readonly<{ ok: true; receipt: DelegationReceipt; code?: never; message?: never }>;
type ReceiptResult = ReceiptSuccess | ReceiptFailure;

const MANAGED_AGENTS = {
  'agent-infra-lifecycle-executor': 'executor',
  'agent-infra-lifecycle-reviewer': 'reviewer'
} as const;

function managedDelegationRole(nativeAgent: string): DelegationRole | null {
  return MANAGED_AGENTS[nativeAgent as keyof typeof MANAGED_AGENTS] ?? null;
}

function fail(code: string, message: string): ReceiptFailure {
  return { ok: false, code, message };
}

function prepareDelegation(
  input: Omit<DelegationReceipt, 'id' | 'requestedModel' | 'requestedReasoningEffort' | 'actualModel' | 'actualReasoningEffort' | 'modelFallbackReason' | 'reasoningEffortFallbackReason' | 'parentId' | 'childId' | 'spawnMode' | 'agent' | 'status' | 'hostEvidence' | 'afterFingerprint' | 'changedPaths' | 'createdAt' | 'preparedMonotonicMs' | 'spawnDispatchMonotonicMs' | 'activationDeadlineMonotonicMs' | 'startEvidenceMonotonicMs' | 'activatedMonotonicMs' | 'activatedAt' | 'sealedAt' | 'consumedAt'> & Readonly<{ requestedModel: string; requestedReasoningEffort: string }>,
  options: { id?: () => string; now?: () => string; monotonicNow?: () => number; activationWindowMs?: number } = {}
): DelegationReceipt {
  const monotonic = (options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
  return Object.freeze({
    ...input,
    id: (options.id ?? randomUUID)(),
    actualModel: null,
    actualReasoningEffort: null,
    modelFallbackReason: null,
    reasoningEffortFallbackReason: null,
    parentId: null,
    childId: null,
    spawnMode: null,
    agent: null,
    status: 'prepared' as const,
    hostEvidence: null,
    afterFingerprint: null,
    changedPaths: Object.freeze([]),
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    preparedMonotonicMs: monotonic,
    spawnDispatchMonotonicMs: monotonic,
    activationDeadlineMonotonicMs: monotonic + (options.activationWindowMs ?? 15_000),
    startEvidenceMonotonicMs: null,
    activatedMonotonicMs: null,
    activatedAt: null,
    sealedAt: null,
    consumedAt: null
  });
}

function activateDelegation(
  receipt: DelegationReceipt,
  event: Readonly<{
    nativeAgent: string;
    childId: string;
    parentId: string;
    spawnMode: string;
    actualModel?: string;
    actualReasoningEffort?: string;
    modelFallbackReason?: string;
    reasoningEffortFallbackReason?: string;
    hostEvidence?: Readonly<{
      kind: 'codex-lifecycle-v1' | 'codex-lifecycle-v2';
      hookDefinitionHash: string;
      startRevision: number;
      protocolVersion?: number;
      packageVersion?: string;
      internalExecutableBuildHash?: string;
      lifecycleContractHash?: string;
      hookSource?: 'project' | 'managed' | 'isolated-user';
      controllerInstanceDigest?: string | null;
      controlGeneration?: string | null;
    }>;
  }>,
  options: { now?: () => string; monotonicNow?: () => number } = {}
): ReceiptResult {
  const managedRole = managedDelegationRole(event.nativeAgent);
  if (!managedRole) return fail('DELEGATION_IGNORED', `subagent '${event.nativeAgent}' is not lifecycle-managed`);
  if (receipt.status !== 'prepared') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected prepared`);
  const monotonic = (options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
  if (monotonic > receipt.activationDeadlineMonotonicMs) {
    return fail('DELEGATION_ACTIVATION_TIMEOUT', `delegation ${receipt.id} activation evidence arrived after its deadline`);
  }
  if (managedRole !== receipt.role) return fail('DELEGATION_ROLE_MISMATCH', `managed role ${managedRole} does not match ${receipt.role}`);
  if (!event.parentId || (receipt.parentId !== null && event.parentId !== receipt.parentId) || !event.childId || event.childId === event.parentId) {
    return fail('DELEGATION_IDENTITY_INVALID', 'native parent/child identity does not match the prepared delegation');
  }
  if (event.spawnMode !== 'fresh') return fail('DELEGATION_FORK_FORBIDDEN', `spawn mode '${event.spawnMode}' is not fresh`);
  const actualModel = event.actualModel;
  if (!actualModel || actualModel.trim() !== actualModel) {
    return fail('DELEGATION_MODEL_IDENTITY_MISSING', 'native start event must provide a non-empty actual model identity');
  }
  if (actualModel !== receipt.requestedModel && (!event.modelFallbackReason || event.modelFallbackReason.trim() === '')) {
    return fail('DELEGATION_MODEL_FALLBACK_UNRECORDED', 'actual model differs from requested model without a fallback reason');
  }
  const actualReasoningEffort = event.actualReasoningEffort;
  if (!actualReasoningEffort || actualReasoningEffort.trim() !== actualReasoningEffort) {
    return fail('DELEGATION_REASONING_EFFORT_MISSING', 'native start event must provide a non-empty actual reasoning effort');
  }
  if (
    actualReasoningEffort !== receipt.requestedReasoningEffort
    && (!event.reasoningEffortFallbackReason || event.reasoningEffortFallbackReason.trim() === '')
  ) {
    return fail('DELEGATION_REASONING_EFFORT_FALLBACK_UNRECORDED', 'actual reasoning effort differs from requested effort without a fallback reason');
  }
  if (actualModel === receipt.requestedModel && event.modelFallbackReason) {
    return fail('DELEGATION_MODEL_FALLBACK_INVALID', 'model fallback reason is only valid when actual model differs');
  }
  if (actualReasoningEffort === receipt.requestedReasoningEffort && event.reasoningEffortFallbackReason) {
    return fail('DELEGATION_REASONING_EFFORT_FALLBACK_INVALID', 'reasoning-effort fallback reason is only valid when actual effort differs');
  }
  if (
    event.hostEvidence
    && (
      receipt.client !== 'codex'
      || !event.hostEvidence.hookDefinitionHash.trim()
      || !Number.isSafeInteger(event.hostEvidence.startRevision)
      || event.hostEvidence.startRevision < 1
    )
  ) return fail('DELEGATION_HOST_EVIDENCE_INVALID', 'Codex start evidence reference is invalid');
  if (event.hostEvidence?.kind === 'codex-lifecycle-v2') {
    const expected = receipt.lifecycleProvenance;
    if (
      !expected
      || event.hostEvidence.protocolVersion !== expected.protocolVersion
      || event.hostEvidence.packageVersion !== expected.packageVersion
      || event.hostEvidence.internalExecutableBuildHash !== expected.internalExecutableBuildHash
      || event.hostEvidence.lifecycleContractHash !== expected.lifecycleContractHash
      || event.hostEvidence.hookDefinitionHash !== expected.hookDefinitionHash
      || event.hostEvidence.hookSource !== expected.hookSource
      || (event.hostEvidence.controllerInstanceDigest ?? null) !== expected.controllerInstanceDigest
      || (event.hostEvidence.controlGeneration ?? null) !== expected.controlGeneration
    ) return fail('DELEGATION_HOST_EVIDENCE_INVALID', 'Codex lifecycle provenance does not match the prepared receipt');
  }
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'activated',
    parentId: event.parentId,
    childId: event.childId,
    spawnMode: event.spawnMode,
    actualModel,
    actualReasoningEffort,
    modelFallbackReason: event.modelFallbackReason ?? null,
    reasoningEffortFallbackReason: event.reasoningEffortFallbackReason ?? null,
    hostEvidence: event.hostEvidence ? Object.freeze({
      ...event.hostEvidence,
      stopRevision: null,
      consumer: null,
      consumedAt: null
    }) : receipt.hostEvidence ?? null,
    startEvidenceMonotonicMs: monotonic,
    activatedMonotonicMs: monotonic,
    activatedAt: (options.now ?? (() => new Date().toISOString()))()
  }) };
}

function abortPreparedDelegation(receipt: DelegationReceipt): ReceiptResult {
  if (receipt.status !== 'prepared') {
    return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected prepared`);
  }
  return {
    ok: true,
    receipt: Object.freeze({ ...receipt, status: 'aborted' as const })
  };
}

function completeDelegationStage(
  receipt: DelegationReceipt,
  event: Readonly<{ stage: DelegationStage; round: number; artifact: string; agent: string }>
): ReceiptResult {
  if (receipt.status !== 'activated') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected activated`);
  if (event.stage !== receipt.stage || event.round !== receipt.round || event.artifact !== receipt.artifact) {
    return fail('DELEGATION_STAGE_MISMATCH', 'stage completion identity does not match the active delegation');
  }
  if (normalizeAgentToken(event.agent) !== normalizeAgentToken(receipt.client)) {
    return fail('DELEGATION_AGENT_MISMATCH', `stage agent '${event.agent}' does not match client '${receipt.client}'`);
  }
  return { ok: true, receipt: Object.freeze({ ...receipt, status: 'stage-completed', agent: event.agent }) };
}

function sealDelegation(
  receipt: DelegationReceipt,
  event: Readonly<{
    childId: string;
    exitCode: number;
    afterFingerprint: string;
    changedPaths: readonly string[];
    hostEvidence?: Readonly<{ stopRevision: number; consumer: string; consumedAt: string }>;
  }>,
  options: { now?: () => string } = {}
): ReceiptResult {
  if (receipt.status !== 'stage-completed') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected stage-completed`);
  if (event.childId !== receipt.childId || event.exitCode !== 0) return fail('DELEGATION_STOP_INVALID', 'native stop identity or exit status is invalid');
  if (receipt.role === 'reviewer') {
    const taskRoot = `.agents/workspace/active/${receipt.taskId}/`;
    const allowed = new Set([
      `${taskRoot}${receipt.artifact}`,
      `${taskRoot}task.md`,
      `${taskRoot}orchestration.json`
    ]);
    const disallowed = event.changedPaths.find((entry) => !allowed.has(entry));
    if (disallowed) return fail('DELEGATION_REVIEWER_WRITE_FORBIDDEN', `reviewer changed forbidden path '${disallowed}'`);
  }
  if (event.hostEvidence) {
    if (
      !receipt.hostEvidence
      || !Number.isSafeInteger(event.hostEvidence.stopRevision)
      || event.hostEvidence.stopRevision <= receipt.hostEvidence.startRevision
      || event.hostEvidence.consumer !== receipt.id
      || !event.hostEvidence.consumedAt.trim()
    ) return fail('DELEGATION_HOST_EVIDENCE_INVALID', 'Codex stop evidence reference is invalid');
  }
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'sealed',
    afterFingerprint: event.afterFingerprint,
    changedPaths: Object.freeze([...event.changedPaths]),
    hostEvidence: event.hostEvidence && receipt.hostEvidence ? Object.freeze({
      ...receipt.hostEvidence,
      ...event.hostEvidence
    }) : receipt.hostEvidence ?? null,
    sealedAt: (options.now ?? (() => new Date().toISOString()))()
  }) };
}

function consumeDelegation(receipt: DelegationReceipt, options: { now?: () => string } = {}): ReceiptResult {
  if (receipt.status === 'consumed') return fail('DELEGATION_REPLAY', `delegation ${receipt.id} was already consumed`);
  if (receipt.status !== 'sealed') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected sealed`);
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'consumed',
    consumedAt: (options.now ?? (() => new Date().toISOString()))()
  }) };
}

export {
  activateDelegation,
  abortPreparedDelegation,
  completeDelegationStage,
  consumeDelegation,
  managedDelegationRole,
  prepareDelegation,
  sealDelegation
};
export type {
  DelegationHostEvidence,
  DelegationLifecycleProvenance,
  DelegationReceipt,
  DelegationRole,
  DelegationStage,
  DelegationStatus,
  ReceiptResult
};
