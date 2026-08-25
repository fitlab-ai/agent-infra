import { randomUUID } from 'node:crypto';

import { isAgentClientId } from '../agent-clients/types.ts';
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
  hookSourcePathDigest?: string;
  hookSourceHash?: string;
  capabilitySessionId?: string;
  capabilityTurnId?: string;
  capabilityToolUseId?: string;
  spawnToolUseId?: string;
  spawnObservedAt?: string;
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
  hookSourcePathDigest: string;
  hookSourceHash: string;
  capabilitySessionId: string;
  capabilityTurnId: string;
  capabilityToolUseId: string;
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
  spawnDispatchMonotonicMs: number | null;
  activationDeadlineMonotonicMs: number | null;
  spawnDispatchedAt: string | null;
  activationDeadlineAt: string | null;
  startEvidenceMonotonicMs: number | null;
  activatedMonotonicMs: number | null;
  activatedAt: string | null;
  sealedAt: string | null;
  consumedAt: string | null;
}>;

type ReceiptFailure = Readonly<{ ok: false; code: string; message: string; receipt?: never }>;
type ReceiptSuccess = Readonly<{ ok: true; receipt: DelegationReceipt; code?: never; message?: never }>;
type ReceiptResult = ReceiptSuccess | ReceiptFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nullableText(value: unknown): value is string | null {
  return value === null || exactText(value);
}

function nullableSafeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

const LIFECYCLE_PROVENANCE_KEYS = [
  'protocolVersion', 'packageVersion', 'internalExecutableBuildHash', 'lifecycleContractHash',
  'hookDefinitionHash', 'hookSource', 'hookSourcePathDigest', 'hookSourceHash',
  'capabilitySessionId', 'capabilityTurnId', 'capabilityToolUseId',
  'controllerInstanceDigest', 'controlGeneration'
] as const;

function isDelegationLifecycleProvenance(value: unknown): value is DelegationLifecycleProvenance {
  if (!hasExactKeys(value, LIFECYCLE_PROVENANCE_KEYS)) return false;
  return Number.isSafeInteger(value.protocolVersion)
    && (value.protocolVersion as number) > 0
    && exactText(value.packageVersion)
    && exactText(value.internalExecutableBuildHash)
    && exactText(value.lifecycleContractHash)
    && exactText(value.hookDefinitionHash)
    && ['project', 'managed', 'isolated-user'].includes(value.hookSource as string)
    && exactText(value.hookSourcePathDigest)
    && exactText(value.hookSourceHash)
    && exactText(value.capabilitySessionId)
    && exactText(value.capabilityTurnId)
    && exactText(value.capabilityToolUseId)
    && nullableText(value.controllerInstanceDigest)
    && nullableText(value.controlGeneration);
}

const HOST_EVIDENCE_REQUIRED_KEYS = [
  'kind', 'hookDefinitionHash', 'startRevision', 'stopRevision', 'consumer', 'consumedAt'
] as const;
const HOST_EVIDENCE_OPTIONAL_KEYS = [
  'protocolVersion', 'packageVersion', 'internalExecutableBuildHash', 'lifecycleContractHash',
  'hookSource', 'hookSourcePathDigest', 'hookSourceHash', 'capabilitySessionId',
  'capabilityTurnId', 'capabilityToolUseId', 'spawnToolUseId', 'spawnObservedAt',
  'controllerInstanceDigest', 'controlGeneration'
] as const;

function isDelegationHostEvidence(value: unknown): value is DelegationHostEvidence {
  if (!hasExactKeys(value, HOST_EVIDENCE_REQUIRED_KEYS, HOST_EVIDENCE_OPTIONAL_KEYS)) return false;
  if (!['codex-lifecycle-v1', 'codex-lifecycle-v2'].includes(value.kind as string)) return false;
  if (!exactText(value.hookDefinitionHash)
    || !Number.isSafeInteger(value.startRevision) || (value.startRevision as number) < 1
    || !nullableSafeInteger(value.stopRevision)
    || !nullableText(value.consumer)
    || !nullableText(value.consumedAt)) return false;
  if (value.kind === 'codex-lifecycle-v1') return true;
  return Number.isSafeInteger(value.protocolVersion)
    && (value.protocolVersion as number) > 0
    && exactText(value.packageVersion)
    && exactText(value.internalExecutableBuildHash)
    && exactText(value.lifecycleContractHash)
    && ['project', 'managed', 'isolated-user'].includes(value.hookSource as string)
    && exactText(value.hookSourcePathDigest)
    && exactText(value.hookSourceHash)
    && exactText(value.capabilitySessionId)
    && exactText(value.capabilityTurnId)
    && exactText(value.spawnToolUseId)
    && exactText(value.spawnObservedAt)
    && nullableText(value.controllerInstanceDigest)
    && nullableText(value.controlGeneration);
}

function hasCurrentCodexEvidence(receipt: DelegationReceipt): boolean {
  const provenance = receipt.lifecycleProvenance;
  if (!provenance) return false;
  const activated = ['activated', 'stage-completed', 'sealed', 'consumed'].includes(receipt.status);
  if (!activated) return receipt.hostEvidence === null;
  const host = receipt.hostEvidence;
  if (
    host?.kind !== 'codex-lifecycle-v2'
    || host.protocolVersion !== provenance.protocolVersion
    || host.packageVersion !== provenance.packageVersion
    || host.internalExecutableBuildHash !== provenance.internalExecutableBuildHash
    || host.lifecycleContractHash !== provenance.lifecycleContractHash
    || host.hookDefinitionHash !== provenance.hookDefinitionHash
    || host.hookSource !== provenance.hookSource
    || host.hookSourcePathDigest !== provenance.hookSourcePathDigest
    || host.hookSourceHash !== provenance.hookSourceHash
    || host.capabilitySessionId !== provenance.capabilitySessionId
    || host.capabilityTurnId !== provenance.capabilityTurnId
    || host.controllerInstanceDigest !== provenance.controllerInstanceDigest
    || host.controlGeneration !== provenance.controlGeneration
    || receipt.parentId !== provenance.capabilitySessionId
    || host.spawnToolUseId === provenance.capabilityToolUseId
  ) return false;
  const spawnObservedAt = Date.parse(host.spawnObservedAt ?? '');
  const spawnDispatchedAt = Date.parse(receipt.spawnDispatchedAt ?? '');
  const activationDeadlineAt = Date.parse(receipt.activationDeadlineAt ?? '');
  if (
    !Number.isFinite(spawnObservedAt)
    || !Number.isFinite(spawnDispatchedAt)
    || !Number.isFinite(activationDeadlineAt)
    || spawnObservedAt < spawnDispatchedAt
    || spawnObservedAt > activationDeadlineAt
  ) return false;
  if (['sealed', 'consumed'].includes(receipt.status)) {
    return Number.isSafeInteger(host.stopRevision)
      && (host.stopRevision as number) > host.startRevision
      && host.consumer === receipt.id
      && exactText(host.consumedAt);
  }
  return host.stopRevision === null && host.consumer === null && host.consumedAt === null;
}

const RECEIPT_KEYS = [
  'id', 'taskId', 'runId', 'role', 'stage', 'round', 'artifact', 'client',
  'requestedModel', 'requestedReasoningEffort', 'actualModel', 'actualReasoningEffort',
  'modelFallbackReason', 'reasoningEffortFallbackReason', 'parentId', 'childId',
  'spawnMode', 'agent', 'status', 'workspaceSnapshotScope', 'lifecycleProvenance',
  'hostEvidence', 'beforeFingerprint', 'afterFingerprint', 'changedPaths', 'createdAt',
  'preparedMonotonicMs', 'spawnDispatchMonotonicMs', 'activationDeadlineMonotonicMs',
  'spawnDispatchedAt', 'activationDeadlineAt', 'startEvidenceMonotonicMs',
  'activatedMonotonicMs', 'activatedAt', 'sealedAt', 'consumedAt'
] as const;

function hasStatusBoundEvidence(receipt: DelegationReceipt): boolean {
  const dispatchFields = [
    receipt.spawnDispatchMonotonicMs,
    receipt.activationDeadlineMonotonicMs,
    receipt.spawnDispatchedAt,
    receipt.activationDeadlineAt
  ];
  const dispatchEmpty = dispatchFields.every((field) => field === null);
  const dispatchComplete = dispatchFields.every((field) => field !== null);
  if (!dispatchEmpty && !dispatchComplete) return false;

  const beforeActivation = ['prepared', 'aborted', 'expired'].includes(receipt.status);
  if (beforeActivation) {
    return receipt.parentId === null
      && receipt.childId === null
      && receipt.spawnMode === null
      && receipt.actualModel === null
      && receipt.actualReasoningEffort === null
      && receipt.modelFallbackReason === null
      && receipt.reasoningEffortFallbackReason === null
      && receipt.agent === null
      && receipt.hostEvidence === null
      && receipt.startEvidenceMonotonicMs === null
      && receipt.activatedMonotonicMs === null
      && receipt.activatedAt === null
      && receipt.afterFingerprint === null
      && receipt.changedPaths.length === 0
      && receipt.sealedAt === null
      && receipt.consumedAt === null;
  }

  if (
    !dispatchComplete
    || !exactText(receipt.parentId)
    || !exactText(receipt.childId)
    || receipt.parentId === receipt.childId
    || receipt.startEvidenceMonotonicMs === null
    || receipt.activatedMonotonicMs === null
    || !exactText(receipt.activatedAt)
  ) return false;

  if (receipt.status === 'activated') {
    return receipt.agent === null
      && receipt.afterFingerprint === null
      && receipt.changedPaths.length === 0
      && receipt.sealedAt === null
      && receipt.consumedAt === null;
  }

  if (
    !exactText(receipt.agent)
    || normalizeAgentToken(receipt.agent) !== normalizeAgentToken(receipt.client)
  ) return false;

  if (receipt.status === 'stage-completed') {
    return receipt.afterFingerprint === null
      && receipt.changedPaths.length === 0
      && receipt.sealedAt === null
      && receipt.consumedAt === null;
  }

  if (!exactText(receipt.afterFingerprint) || !exactText(receipt.sealedAt)) return false;
  return receipt.status === 'sealed'
    ? receipt.consumedAt === null
    : receipt.status === 'consumed' && exactText(receipt.consumedAt);
}

function isDelegationReceipt(value: unknown): value is DelegationReceipt {
  if (!hasExactKeys(value, RECEIPT_KEYS)) return false;
  const structurallyValid = exactText(value.id)
    && exactText(value.taskId)
    && exactText(value.runId)
    && ['executor', 'reviewer'].includes(value.role as string)
    && ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code', 'commit'].includes(value.stage as string)
    && Number.isSafeInteger(value.round)
    && (value.round as number) > 0
    && exactText(value.artifact)
    && isAgentClientId(value.client)
    && exactText(value.requestedModel)
    && exactText(value.requestedReasoningEffort)
    && nullableText(value.actualModel)
    && nullableText(value.actualReasoningEffort)
    && nullableText(value.modelFallbackReason)
    && nullableText(value.reasoningEffortFallbackReason)
    && nullableText(value.parentId)
    && nullableText(value.childId)
    && nullableText(value.spawnMode)
    && nullableText(value.agent)
    && ['prepared', 'activated', 'stage-completed', 'sealed', 'consumed', 'aborted', 'expired'].includes(value.status as string)
    && value.workspaceSnapshotScope === 'task'
    && (value.lifecycleProvenance === null || isDelegationLifecycleProvenance(value.lifecycleProvenance))
    && (value.hostEvidence === null || isDelegationHostEvidence(value.hostEvidence))
    && exactText(value.beforeFingerprint)
    && nullableText(value.afterFingerprint)
    && Array.isArray(value.changedPaths)
    && value.changedPaths.every(exactText)
    && exactText(value.createdAt)
    && nullableSafeInteger(value.preparedMonotonicMs)
    && value.preparedMonotonicMs !== null
    && nullableSafeInteger(value.spawnDispatchMonotonicMs)
    && nullableSafeInteger(value.activationDeadlineMonotonicMs)
    && nullableText(value.spawnDispatchedAt)
    && nullableText(value.activationDeadlineAt)
    && nullableSafeInteger(value.startEvidenceMonotonicMs)
    && nullableSafeInteger(value.activatedMonotonicMs)
    && nullableText(value.activatedAt)
    && nullableText(value.sealedAt)
    && nullableText(value.consumedAt);
  if (!structurallyValid) return false;
  const receipt = value as unknown as DelegationReceipt;
  return hasStatusBoundEvidence(receipt)
    && (receipt.client !== 'codex' || hasCurrentCodexEvidence(receipt));
}

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

// 空白串折叠为 null，保持"缺失即 null"的单一表示（Start/Stop 两处共用，避免任一入口把 "   " 当成已观察到的值入账）
function foldBlankToNull(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

function prepareDelegation(
  input: Omit<DelegationReceipt, 'id' | 'requestedModel' | 'requestedReasoningEffort' | 'actualModel' | 'actualReasoningEffort' | 'modelFallbackReason' | 'reasoningEffortFallbackReason' | 'parentId' | 'childId' | 'spawnMode' | 'agent' | 'status' | 'hostEvidence' | 'afterFingerprint' | 'changedPaths' | 'createdAt' | 'preparedMonotonicMs' | 'spawnDispatchMonotonicMs' | 'activationDeadlineMonotonicMs' | 'spawnDispatchedAt' | 'activationDeadlineAt' | 'startEvidenceMonotonicMs' | 'activatedMonotonicMs' | 'activatedAt' | 'sealedAt' | 'consumedAt'> & Readonly<{ requestedModel: string; requestedReasoningEffort: string }>,
  options: { id?: () => string; now?: () => string; monotonicNow?: () => number } = {}
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
    spawnDispatchMonotonicMs: null,
    activationDeadlineMonotonicMs: null,
    spawnDispatchedAt: null,
    activationDeadlineAt: null,
    startEvidenceMonotonicMs: null,
    activatedMonotonicMs: null,
    activatedAt: null,
    sealedAt: null,
    consumedAt: null
  });
}

function dispatchDelegation(
  receipt: DelegationReceipt,
  options: { now?: () => string; monotonicNow?: () => number; activationWindowMs?: number } = {}
): ReceiptResult {
  if (receipt.status !== 'prepared') {
    return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected prepared`);
  }
  if (receipt.spawnDispatchMonotonicMs != null || receipt.spawnDispatchedAt != null) {
    return fail('DELEGATION_DISPATCH_REPLAY', `delegation ${receipt.id} was already dispatched`);
  }
  const monotonic = (options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
  const dispatchedAt = (options.now ?? (() => new Date().toISOString()))();
  const window = options.activationWindowMs ?? 60_000;
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    spawnDispatchMonotonicMs: monotonic,
    activationDeadlineMonotonicMs: monotonic + window,
    spawnDispatchedAt: dispatchedAt,
    activationDeadlineAt: new Date(Date.parse(dispatchedAt) + window).toISOString()
  }) };
}

function activateDelegation(
  receipt: DelegationReceipt,
  event: Readonly<{
    nativeAgent: string;
    childId: string;
    parentId: string;
    spawnMode?: string;
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
      hookSourcePathDigest?: string;
      hookSourceHash?: string;
      capabilitySessionId?: string;
      capabilityTurnId?: string;
      capabilityToolUseId?: string;
      spawnToolUseId?: string;
      spawnObservedAt?: string;
      controllerInstanceDigest?: string | null;
      controlGeneration?: string | null;
    }>;
  }>,
  options: { now?: () => string; monotonicNow?: () => number } = {}
): ReceiptResult {
  const managedRole = managedDelegationRole(event.nativeAgent);
  if (!managedRole) return fail('DELEGATION_IGNORED', `subagent '${event.nativeAgent}' is not lifecycle-managed`);
  if (receipt.status !== 'prepared') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected prepared`);
  if (
    receipt.spawnDispatchMonotonicMs == null
    || receipt.spawnDispatchedAt == null
    || receipt.activationDeadlineAt == null
    || receipt.activationDeadlineMonotonicMs == null
    || !Number.isFinite(Date.parse(receipt.spawnDispatchedAt))
    || !Number.isFinite(Date.parse(receipt.activationDeadlineAt))
  ) {
    return fail('DELEGATION_NOT_DISPATCHED', `delegation ${receipt.id} has not reached the native spawn dispatch boundary`);
  }
  const monotonic = (options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
  const wallNow = Date.parse((options.now ?? (() => new Date().toISOString()))());
  if (wallNow > Date.parse(receipt.activationDeadlineAt)) {
    return fail('DELEGATION_ACTIVATION_TIMEOUT', `delegation ${receipt.id} activation evidence arrived after its deadline`);
  }
  if (managedRole !== receipt.role) return fail('DELEGATION_ROLE_MISMATCH', `managed role ${managedRole} does not match ${receipt.role}`);
  if (!event.parentId || (receipt.parentId !== null && event.parentId !== receipt.parentId) || !event.childId || event.childId === event.parentId) {
    return fail('DELEGATION_IDENTITY_INVALID', 'native parent/child identity does not match the prepared delegation');
  }
  // spawnMode 的必需性按 client 判断：claude-code 宿主结构上不提供该字段，跳过；其余 client 维持硬校验
  if (receipt.client !== 'claude-code' && event.spawnMode !== 'fresh') {
    return fail('DELEGATION_FORK_FORBIDDEN', `spawn mode '${event.spawnMode}' is not fresh`);
  }
  // model/effort 维度：claude-code 如实记录、不做门禁；其余 client 维持现状硬校验（HDR-2）
  const actualModel = foldBlankToNull(event.actualModel);
  const actualReasoningEffort = foldBlankToNull(event.actualReasoningEffort);
  if (receipt.client !== 'claude-code') {
    if (!actualModel || actualModel.trim() !== actualModel) {
      return fail('DELEGATION_MODEL_IDENTITY_MISSING', 'native start event must provide a non-empty actual model identity');
    }
  }
  if (actualModel !== null && actualModel !== receipt.requestedModel) {
    if (receipt.client !== 'claude-code' && (!event.modelFallbackReason || event.modelFallbackReason.trim() === '')) {
      return fail('DELEGATION_MODEL_FALLBACK_UNRECORDED', 'actual model differs from requested model without a fallback reason');
    }
  }
  if (receipt.client !== 'claude-code') {
    if (!actualReasoningEffort || actualReasoningEffort.trim() !== actualReasoningEffort) {
      return fail('DELEGATION_REASONING_EFFORT_MISSING', 'native start event must provide a non-empty actual reasoning effort');
    }
  }
  if (
    receipt.client === 'codex'
    && event.hostEvidence?.kind !== 'codex-lifecycle-v2'
  ) return fail('DELEGATION_HOST_EVIDENCE_REQUIRED', 'Codex activation requires trusted lifecycle-v2 host evidence');
  if (actualReasoningEffort !== null && actualReasoningEffort !== receipt.requestedReasoningEffort) {
    if (receipt.client !== 'claude-code' && (!event.reasoningEffortFallbackReason || event.reasoningEffortFallbackReason.trim() === '')) {
      return fail('DELEGATION_REASONING_EFFORT_FALLBACK_UNRECORDED', 'actual reasoning effort differs from requested effort without a fallback reason');
    }
  }
  // "无关 fallback 理由"检查对所有 client 保持不变——防止编造理由的红线，不属于 HDR-2 放宽范围
  // actualModel/actualReasoningEffort 为 null（未观察到）时同样没有"实际不同"这回事，理由一样是无关的
  if ((actualModel === null || actualModel === receipt.requestedModel) && event.modelFallbackReason) {
    return fail('DELEGATION_MODEL_FALLBACK_INVALID', 'model fallback reason is only valid when actual model differs');
  }
  if (
    (actualReasoningEffort === null || actualReasoningEffort === receipt.requestedReasoningEffort)
    && event.reasoningEffortFallbackReason
  ) {
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
    const spawnObservedAt = Date.parse(event.hostEvidence.spawnObservedAt ?? '');
    const spawnDispatchedAt = Date.parse(receipt.spawnDispatchedAt);
    const activationDeadlineAt = Date.parse(receipt.activationDeadlineAt);
    if (
      !expected
      || event.hostEvidence.protocolVersion !== expected.protocolVersion
      || event.hostEvidence.packageVersion !== expected.packageVersion
      || event.hostEvidence.internalExecutableBuildHash !== expected.internalExecutableBuildHash
      || event.hostEvidence.lifecycleContractHash !== expected.lifecycleContractHash
      || event.hostEvidence.hookDefinitionHash !== expected.hookDefinitionHash
      || event.hostEvidence.hookSource !== expected.hookSource
      || event.hostEvidence.hookSourcePathDigest !== expected.hookSourcePathDigest
      || event.hostEvidence.hookSourceHash !== expected.hookSourceHash
      || event.hostEvidence.capabilitySessionId !== expected.capabilitySessionId
      || event.hostEvidence.capabilityTurnId !== expected.capabilityTurnId
      || !event.hostEvidence.spawnToolUseId?.trim()
      || event.hostEvidence.spawnToolUseId === expected.capabilityToolUseId
      || !Number.isFinite(spawnObservedAt)
      || spawnObservedAt < spawnDispatchedAt
      || spawnObservedAt > activationDeadlineAt
      || event.parentId !== expected.capabilitySessionId
      || (event.hostEvidence.controllerInstanceDigest ?? null) !== expected.controllerInstanceDigest
      || (event.hostEvidence.controlGeneration ?? null) !== expected.controlGeneration
    ) return fail('DELEGATION_HOST_EVIDENCE_INVALID', 'Codex lifecycle provenance does not match the prepared receipt');
  }
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'activated',
    parentId: event.parentId,
    childId: event.childId,
    spawnMode: event.spawnMode ?? null,
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
    activatedMonotonicMs: (options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))(),
    activatedAt: new Date(wallNow).toISOString()
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
    actualModel?: string;
    actualReasoningEffort?: string;
    modelFallbackReason?: string;
    reasoningEffortFallbackReason?: string;
    hostEvidence?: Readonly<{ stopRevision: number; consumer: string; consumedAt: string }>;
  }>,
  options: { now?: () => string; requireHostEvidence?: boolean } = {}
): ReceiptResult {
  if (receipt.status !== 'stage-completed') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected stage-completed`);
  if (receipt.client === 'codex' && options.requireHostEvidence !== false && !event.hostEvidence) {
    return fail('DELEGATION_HOST_EVIDENCE_REQUIRED', 'Codex sealing requires consumed lifecycle-v2 host evidence');
  }
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
    actualModel: receipt.actualModel ?? foldBlankToNull(event.actualModel),
    actualReasoningEffort: receipt.actualReasoningEffort ?? foldBlankToNull(event.actualReasoningEffort),
    modelFallbackReason: receipt.modelFallbackReason ?? event.modelFallbackReason ?? null,
    reasoningEffortFallbackReason: receipt.reasoningEffortFallbackReason ?? event.reasoningEffortFallbackReason ?? null,
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
  dispatchDelegation,
  foldBlankToNull,
  isDelegationReceipt,
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
