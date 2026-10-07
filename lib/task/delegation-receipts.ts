import { randomUUID } from 'node:crypto';

import { isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import { normalizeAgentToken } from '../agent-clients/tokens.ts';

type DelegationRole = 'executor' | 'reviewer';
type DelegationStage = 'analysis' | 'review-analysis' | 'plan' | 'review-plan' | 'code' | 'review-code' | 'commit';
type DelegationStatus = 'prepared' | 'activated' | 'stage-completed' | 'sealed' | 'consumed' | 'aborted' | 'expired';
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
  adapterEvidence?: Readonly<Record<string, unknown>>;
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

const RECEIPT_KEYS = [
  'id', 'taskId', 'runId', 'role', 'stage', 'round', 'artifact', 'client',
  'requestedModel', 'requestedReasoningEffort', 'actualModel', 'actualReasoningEffort',
  'modelFallbackReason', 'reasoningEffortFallbackReason', 'parentId', 'childId',
  'spawnMode', 'agent', 'status', 'workspaceSnapshotScope',
  'beforeFingerprint', 'afterFingerprint', 'changedPaths', 'createdAt',
  'preparedMonotonicMs', 'spawnDispatchMonotonicMs', 'activationDeadlineMonotonicMs',
  'spawnDispatchedAt', 'activationDeadlineAt', 'startEvidenceMonotonicMs',
  'activatedMonotonicMs', 'activatedAt', 'sealedAt', 'consumedAt'
] as const;
const RECEIPT_OPTIONAL_KEYS = ['adapterEvidence'] as const;

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return JSON.parse(JSON.stringify(value)) !== null;
  } catch {
    return false;
  }
}

function withClientEvidence(receipt: DelegationReceipt, evidence: unknown): Readonly<Record<string, unknown>> | null {
  if (evidence === undefined) return receipt.adapterEvidence ?? Object.freeze({});
  if (!isJsonRecord(evidence)) return null;
  return Object.freeze({
    ...(receipt.adapterEvidence ?? {}),
    [receipt.client]: JSON.parse(JSON.stringify(evidence)) as unknown
  });
}

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

  const beforeActivation = ['prepared', 'expired'].includes(receipt.status)
    || (receipt.status === 'aborted' && receipt.activatedAt === null);
  if (beforeActivation) {
    return receipt.parentId === null
      && receipt.childId === null
      && receipt.spawnMode === null
      && receipt.actualModel === null
      && receipt.actualReasoningEffort === null
      && receipt.modelFallbackReason === null
      && receipt.reasoningEffortFallbackReason === null
      && receipt.agent === null
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

  if (receipt.status === 'aborted') {
    return receipt.agent === null
      && receipt.afterFingerprint === null
      && receipt.changedPaths.length === 0
      && receipt.sealedAt === null
      && receipt.consumedAt === null
      && receipt.childId !== null;
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
  if (!hasExactKeys(value, RECEIPT_KEYS, RECEIPT_OPTIONAL_KEYS)) return false;
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
    && (value.adapterEvidence === undefined || isJsonRecord(value.adapterEvidence))
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
  if (!hasStatusBoundEvidence(receipt)) return false;
  return true;
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

function validateSealRequest(
  receipt: DelegationReceipt,
  event: Parameters<typeof sealDelegation>[1]
): ReceiptFailure | null {
  if (receipt.status !== 'stage-completed') {
    return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected stage-completed`);
  }
  if (event.childId !== receipt.childId || event.exitCode !== 0) {
    return fail('DELEGATION_STOP_INVALID', 'native stop identity or exit status is invalid');
  }
  const reviewerPathFailure = validateReviewerSealPaths(receipt, event.changedPaths);
  return reviewerPathFailure;
}

function validateReviewerSealPaths(receipt: DelegationReceipt, changedPaths: readonly string[]): ReceiptFailure | null {
  if (receipt.role !== 'reviewer') return null;
  const taskRoot = `.agents/workspace/active/${receipt.taskId}/`;
  const allowed = new Set([
    `${taskRoot}${receipt.artifact}`,
    `${taskRoot}task.md`,
    `${taskRoot}.runtime/orchestration.json`
  ]);
  const disallowed = changedPaths.find((entry) => !allowed.has(entry));
  return disallowed
    ? fail('DELEGATION_REVIEWER_WRITE_FORBIDDEN', `reviewer changed forbidden path '${disallowed}'`)
    : null;
}

function prepareDelegation(
  input: Omit<DelegationReceipt, 'id' | 'requestedModel' | 'requestedReasoningEffort' | 'actualModel' | 'actualReasoningEffort' | 'modelFallbackReason' | 'reasoningEffortFallbackReason' | 'parentId' | 'childId' | 'spawnMode' | 'agent' | 'status' | 'afterFingerprint' | 'changedPaths' | 'createdAt' | 'preparedMonotonicMs' | 'spawnDispatchMonotonicMs' | 'activationDeadlineMonotonicMs' | 'spawnDispatchedAt' | 'activationDeadlineAt' | 'startEvidenceMonotonicMs' | 'activatedMonotonicMs' | 'activatedAt' | 'sealedAt' | 'consumedAt'> & Readonly<{ requestedModel: string; requestedReasoningEffort: string }>,
  options: { id?: () => string; now?: () => string; monotonicNow?: () => number } = {}
): DelegationReceipt {
  const monotonic = (options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
  return Object.freeze({
    ...input,
    adapterEvidence: Object.freeze({ ...(input.adapterEvidence ?? {}) }),
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
    clientEvidence?: unknown;
  }>,
  options: {
    now?: () => string;
    monotonicNow?: () => number;
    evidencePolicy?: Readonly<{
      spawnModeRequired?: boolean;
      actualModelRequired?: boolean;
      actualReasoningEffortRequired?: boolean;
      fallbackReasonRequired?: boolean;
    }>;
  } = {}
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
  const evidencePolicy = options.evidencePolicy ?? {};
  if (evidencePolicy.spawnModeRequired !== false && event.spawnMode !== 'fresh') {
    return fail('DELEGATION_FORK_FORBIDDEN', `spawn mode '${event.spawnMode}' is not fresh`);
  }
  const actualModel = foldBlankToNull(event.actualModel);
  const actualReasoningEffort = foldBlankToNull(event.actualReasoningEffort);
  if (evidencePolicy.actualModelRequired !== false) {
    if (!actualModel || actualModel.trim() !== actualModel) {
      return fail('DELEGATION_MODEL_IDENTITY_MISSING', 'native start event must provide a non-empty actual model identity');
    }
  }
  if (actualModel !== null && actualModel !== receipt.requestedModel) {
    if (evidencePolicy.fallbackReasonRequired !== false && (!event.modelFallbackReason || event.modelFallbackReason.trim() === '')) {
      return fail('DELEGATION_MODEL_FALLBACK_UNRECORDED', 'actual model differs from requested model without a fallback reason');
    }
  }
  if (evidencePolicy.actualReasoningEffortRequired !== false) {
    if (!actualReasoningEffort || actualReasoningEffort.trim() !== actualReasoningEffort) {
      return fail('DELEGATION_REASONING_EFFORT_MISSING', 'native start event must provide a non-empty actual reasoning effort');
    }
  }
  if (actualReasoningEffort !== null && actualReasoningEffort !== receipt.requestedReasoningEffort) {
    if (evidencePolicy.fallbackReasonRequired !== false && (!event.reasoningEffortFallbackReason || event.reasoningEffortFallbackReason.trim() === '')) {
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
  const adapterEvidence = withClientEvidence(receipt, event.clientEvidence);
  if (!adapterEvidence) return fail('DELEGATION_ADAPTER_EVIDENCE_INVALID', 'adapter evidence must be a JSON object');
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
    adapterEvidence,
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

function abortActivatedDelegation(
  receipt: DelegationReceipt,
  event: Readonly<{ childId: string; clientEvidence?: unknown }>
): ReceiptResult {
  if (receipt.status !== 'activated') {
    return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected activated`);
  }
  if (event.childId !== receipt.childId) return fail('DELEGATION_RECOVERY_EVIDENCE_INVALID', 'recovery child does not match the activated delegation');
  const adapterEvidence = withClientEvidence(receipt, event.clientEvidence);
  if (!adapterEvidence) return fail('DELEGATION_ADAPTER_EVIDENCE_INVALID', 'adapter evidence must be a JSON object');
  return {
    ok: true,
    receipt: Object.freeze({
      ...receipt,
      status: 'aborted' as const,
      agent: null,
      afterFingerprint: null,
      changedPaths: Object.freeze([]),
      sealedAt: null,
      consumedAt: null,
      adapterEvidence
    })
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
    clientEvidence?: unknown;
  }>,
  options: { now?: () => string } = {}
): ReceiptResult {
  const validationFailure = validateSealRequest(receipt, event);
  if (validationFailure) return validationFailure;
  const adapterEvidence = withClientEvidence(receipt, event.clientEvidence);
  if (!adapterEvidence) return fail('DELEGATION_ADAPTER_EVIDENCE_INVALID', 'adapter evidence must be a JSON object');
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'sealed',
    afterFingerprint: event.afterFingerprint,
    changedPaths: Object.freeze([...event.changedPaths]),
    actualModel: receipt.actualModel ?? foldBlankToNull(event.actualModel),
    actualReasoningEffort: receipt.actualReasoningEffort ?? foldBlankToNull(event.actualReasoningEffort),
    modelFallbackReason: receipt.modelFallbackReason ?? event.modelFallbackReason ?? null,
    reasoningEffortFallbackReason: receipt.reasoningEffortFallbackReason ?? event.reasoningEffortFallbackReason ?? null,
    adapterEvidence,
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
  abortActivatedDelegation,
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
  DelegationReceipt,
  DelegationRole,
  DelegationStage,
  DelegationStatus,
  ReceiptResult
};
