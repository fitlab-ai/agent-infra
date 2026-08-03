import { randomUUID } from 'node:crypto';

import type { AgentClientId } from '../agent-clients/types.ts';

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
  actualModel: string | null;
  modelFallbackReason: string | null;
  parentId: string | null;
  childId: string | null;
  spawnMode: string | null;
  agent: string | null;
  status: DelegationStatus;
  beforeFingerprint: string;
  afterFingerprint: string | null;
  changedPaths: readonly string[];
  createdAt: string;
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
  input: Omit<DelegationReceipt, 'id' | 'actualModel' | 'modelFallbackReason' | 'parentId' | 'childId' | 'spawnMode' | 'agent' | 'status' | 'afterFingerprint' | 'changedPaths' | 'createdAt' | 'activatedAt' | 'sealedAt' | 'consumedAt'>,
  options: { id?: () => string; now?: () => string } = {}
): DelegationReceipt {
  return Object.freeze({
    ...input,
    id: (options.id ?? randomUUID)(),
    actualModel: null,
    modelFallbackReason: null,
    parentId: null,
    childId: null,
    spawnMode: null,
    agent: null,
    status: 'prepared' as const,
    afterFingerprint: null,
    changedPaths: Object.freeze([]),
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
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
    modelFallbackReason?: string;
  }>,
  options: { now?: () => string } = {}
): ReceiptResult {
  const managedRole = managedDelegationRole(event.nativeAgent);
  if (!managedRole) return fail('DELEGATION_IGNORED', `subagent '${event.nativeAgent}' is not lifecycle-managed`);
  if (receipt.status !== 'prepared') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected prepared`);
  if (managedRole !== receipt.role) return fail('DELEGATION_ROLE_MISMATCH', `managed role ${managedRole} does not match ${receipt.role}`);
  if (!event.parentId || (receipt.parentId !== null && event.parentId !== receipt.parentId) || !event.childId || event.childId === event.parentId) {
    return fail('DELEGATION_IDENTITY_INVALID', 'native parent/child identity does not match the prepared delegation');
  }
  if (event.spawnMode !== 'fresh') return fail('DELEGATION_FORK_FORBIDDEN', `spawn mode '${event.spawnMode}' is not fresh`);
  const actualModel = event.actualModel ?? null;
  if (actualModel && receipt.requestedModel && actualModel !== receipt.requestedModel && !event.modelFallbackReason) {
    return fail('DELEGATION_MODEL_FALLBACK_UNRECORDED', 'actual model differs from requested model without a fallback reason');
  }
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'activated',
    parentId: event.parentId,
    childId: event.childId,
    spawnMode: event.spawnMode,
    actualModel,
    modelFallbackReason: event.modelFallbackReason ?? null,
    activatedAt: (options.now ?? (() => new Date().toISOString()))()
  }) };
}

function completeDelegationStage(
  receipt: DelegationReceipt,
  event: Readonly<{ stage: DelegationStage; round: number; artifact: string; agent: string }>
): ReceiptResult {
  if (receipt.status !== 'activated') return fail('DELEGATION_STATE_INVALID', `delegation ${receipt.id} is ${receipt.status}, expected activated`);
  if (event.stage !== receipt.stage || event.round !== receipt.round || event.artifact !== receipt.artifact) {
    return fail('DELEGATION_STAGE_MISMATCH', 'stage completion identity does not match the active delegation');
  }
  const acceptedAgents = receipt.client === 'claude-code' ? ['claude', 'claude-code'] : [receipt.client];
  if (!acceptedAgents.includes(event.agent)) {
    return fail('DELEGATION_AGENT_MISMATCH', `stage agent '${event.agent}' does not match client '${receipt.client}'`);
  }
  return { ok: true, receipt: Object.freeze({ ...receipt, status: 'stage-completed', agent: event.agent }) };
}

function sealDelegation(
  receipt: DelegationReceipt,
  event: Readonly<{ childId: string; exitCode: number; afterFingerprint: string; changedPaths: readonly string[] }>,
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
  return { ok: true, receipt: Object.freeze({
    ...receipt,
    status: 'sealed',
    afterFingerprint: event.afterFingerprint,
    changedPaths: Object.freeze([...event.changedPaths]),
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
  completeDelegationStage,
  consumeDelegation,
  managedDelegationRole,
  prepareDelegation,
  sealDelegation
};
export type { DelegationReceipt, DelegationRole, DelegationStage, DelegationStatus, ReceiptResult };
