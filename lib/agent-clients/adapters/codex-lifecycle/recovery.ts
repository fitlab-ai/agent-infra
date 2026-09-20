import fs from 'node:fs';

import { createCodexLifecycleStore } from './store.ts';
import type { StoredCodexLifecycle } from './store.ts';
import { managedDelegationRole } from '../../../task/delegation-receipts.ts';
import type { DelegationReceipt } from '../../../task/delegation-receipts.ts';
import { normalizeAgentToken } from '../../tokens.ts';
import { locateActivityLog, pairEntries, appendActivityEntry } from '../../../task/activity-log.ts';
import type { ActivityLogSection, StepRow } from '../../../task/activity-log.ts';
import { captureTaskWriteMetadata, writeTask } from '../../../task/write.ts';
import { parseTypedTaskFrontmatter } from '../../../task/frontmatter.ts';
import { resolveTaskRef } from '../../../task/resolve-ref.ts';
import { resolveAgentRuntimeStoreRoot } from '../../../runtime/agent-runtime.ts';
import {
  recoverActivatedOrchestrationDelegationUnderLock,
  readRun
} from '../../../task/orchestration.ts';
import type { OrchestrationOptions, OrchestrationRun } from '../../../task/orchestration.ts';
import type {
  AgentClientLifecycleRecoveryRequest,
  AgentClientLifecycleRecoveryResult
} from '../../adapter.ts';

const ACTIONS = {
  analysis: 'Analyze Task',
  'review-analysis': 'Review Analysis',
  plan: 'Plan Task',
  'review-plan': 'Review Plan',
  code: 'Code Task',
  'review-code': 'Review Code'
} as const;

type RecoveryStage = keyof typeof ACTIONS;
type LifecycleRecoveryRequest = AgentClientLifecycleRecoveryRequest;
type LifecycleRecoveryResult = AgentClientLifecycleRecoveryResult;
type LifecycleRecoveryOptions = Readonly<{
  repoRoot?: string;
  now?: () => string;
  orchestration?: Pick<OrchestrationOptions, 'diagnosticLog' | 'now'>;
  lifecycleStore?: ReturnType<typeof createCodexLifecycleStore>;
  writeTask?: typeof writeTask;
}>;

type RecoveryCandidate = Readonly<{
  receipt: DelegationReceipt;
  row: StepRow;
}>;

function result(
  request: LifecycleRecoveryRequest,
  status: LifecycleRecoveryResult['status'],
  extra: Partial<LifecycleRecoveryResult> = {}
): LifecycleRecoveryResult {
  return {
    status,
    changed: status === 'applied',
    targetState: 'active',
    requestRef: request.taskRef,
    intent: 'recover-started',
    taskId: null,
    receiptId: null,
    childId: null,
    error: null,
    ...extra
  };
}

function failure(
  request: LifecycleRecoveryRequest,
  status: 'owner-unknown' | 'conflict',
  code: string,
  message: string,
  extra: Partial<LifecycleRecoveryResult> = {}
): LifecycleRecoveryResult {
  return result(request, status, { error: { code, message }, ...extra });
}

function actionPattern(receipt: Pick<DelegationReceipt, 'stage' | 'round'>): RegExp | null {
  const action = ACTIONS[receipt.stage as RecoveryStage];
  if (!action) return null;
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped} \\(Round ${receipt.round}(?:, (?:fix for review-code(?:-r[2-9]|-r[1-9]\\d+)?.md|decision II-[1-9]\\d*))?\\)$`, 'u');
}

function openRows(section: ActivityLogSection): StepRow[] {
  return pairEntries([...section.entries]).filter((row) => row.started !== '' && row.done === '');
}

function rowForReceipt(rows: readonly StepRow[], receipt: DelegationReceipt): StepRow[] {
  const pattern = actionPattern(receipt);
  return pattern ? rows.filter((row) => pattern.test(row.step)) : [];
}

function readLifecycleStore(
  options: LifecycleRecoveryOptions,
  repoRoot: string
): ReturnType<typeof createCodexLifecycleStore> {
  return options.lifecycleStore ?? createCodexLifecycleStore({
    root: resolveAgentRuntimeStoreRoot({ repoRoot, store: 'lifecycle' }),
    cliVersion: 'recovery',
    now: options.now
  });
}

function readStoredEvidence(
  store: ReturnType<typeof createCodexLifecycleStore>,
  childId: string
): StoredCodexLifecycle | { missing: true } | { error: Error } {
  try {
    return store.read(childId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('was not found uniquely')) return { missing: true };
    return { error: error instanceof Error ? error : new Error(message) };
  }
}

function validateStopRecord(
  record: StoredCodexLifecycle,
  receipt: DelegationReceipt
): { ok: true } | { ok: false; code: string; message: string } {
  const start = record.state.startEvidence;
  const stop = record.state.stopEvidence;
  const provenance = receipt.lifecycleProvenance;
  const host = receipt.hostEvidence;
  if (
    receipt.client !== 'codex'
    || !provenance
    || host?.kind !== 'codex-lifecycle-v2'
    || !start
    || !stop
    || record.state.status !== 'stop-ready'
    || stop.terminalStatus !== 'completed'
    || stop.hookStopObserved !== true
    || start.childThreadId !== receipt.childId
    || start.parentThreadId !== receipt.parentId
    || managedDelegationRole(start.nativeAgent) !== receipt.role
    || start.hookDefinitionHash !== provenance.hookDefinitionHash
    || host.hookDefinitionHash !== provenance.hookDefinitionHash
    || host.capabilitySessionId !== provenance.capabilitySessionId
    || host.capabilityTurnId !== provenance.capabilityTurnId
    || host.capabilityToolUseId !== provenance.capabilityToolUseId
    || host.spawnToolUseId !== start.spawnToolUseId
    || !host.spawnObservedAt
    || host.spawnObservedAt !== record.spawnObservedAt
    || host.controllerInstanceDigest !== provenance.controllerInstanceDigest
    || host.controlGeneration !== provenance.controlGeneration
    || typeof host.controllerInstanceDigest !== 'string'
    || typeof host.controlGeneration !== 'string'
    || host.startRevision < 1
    || record.revision <= host.startRevision
    || record.state.child?.childThreadId !== receipt.childId
    || record.state.stop?.childThreadId !== receipt.childId
  ) {
    return { ok: false, code: 'RECOVERY_STOP_EVIDENCE_INVALID', message: 'Codex stop evidence does not match the activated receipt' };
  }
  if (record.consumer !== null && record.consumer !== receipt.id) {
    return { ok: false, code: 'RECOVERY_CONSUMER_CONFLICT', message: `Codex lifecycle evidence was consumed by '${record.consumer}'` };
  }
  return { ok: true };
}

function abortedCandidates(run: OrchestrationRun, rows: readonly StepRow[]): RecoveryCandidate[] {
  const candidates = run.receipts.flatMap((receipt) => {
    if (receipt.status !== 'aborted' || receipt.activatedAt === null || receipt.client !== 'codex') return [];
    const matches = rowForReceipt(rows, receipt);
    return matches.length === 1 ? [{ receipt, row: matches[0]! }] : [];
  });
  return candidates;
}

function appendRecoveryLog(
  request: LifecycleRecoveryRequest,
  taskId: string,
  section: ActivityLogSection,
  candidate: RecoveryCandidate,
  repoRoot: string,
  writer: typeof writeTask
): LifecycleRecoveryResult {
  const metadata = captureTaskWriteMetadata();
  const body = appendActivityEntry(section, {
    time: metadata.timestamp,
    step: `${candidate.row.step} [aborted]`,
    agent: request.agent,
    note: `terminated Codex delegation; receipt=${candidate.receipt.id}; child=${candidate.receipt.childId}`
  });
  const written = writer({
    taskRef: taskId,
    expectedState: 'active',
    mutations: [{ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body }]
  }, { repoRoot, metadataProvider: () => metadata });
  if (written.status === 'failed') {
    return failure(request, 'owner-unknown', 'RECOVERY_LOG_WRITE_FAILED', written.error.message, {
      taskId, receiptId: candidate.receipt.id, childId: candidate.receipt.childId
    });
  }
  return result(request, 'applied', {
    taskId, receiptId: candidate.receipt.id, childId: candidate.receipt.childId
  });
}

function recoverStartedLifecycleUnderLock(
  request: LifecycleRecoveryRequest,
  options: LifecycleRecoveryOptions = {}
): LifecycleRecoveryResult {
  if (!request || request.intent !== 'recover-started' || request.auto !== true || normalizeAgentToken(request.agent) !== 'codex') {
    return failure(request, 'conflict', 'RECOVERY_PAYLOAD_INVALID', 'automatic recovery requires a task and the Codex agent');
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(request, 'conflict', resolved.code, resolved.message);
  const taskId = resolved.taskId;
  let content: string;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    parseTypedTaskFrontmatter(content);
  } catch (error) {
    return failure(request, 'conflict', 'RECOVERY_TASK_INVALID', error instanceof Error ? error.message : String(error), { taskId });
  }
  const section = locateActivityLog(content);
  if (!section) return failure(request, 'conflict', 'RECOVERY_LOG_INVALID', 'task has no unique Activity Log section', { taskId });
  let run: OrchestrationRun | null;
  try {
    run = readRun(resolved.taskDir, options.orchestration);
  } catch (error) {
    return failure(request, 'owner-unknown', 'RECOVERY_ORCHESTRATION_UNKNOWN', error instanceof Error ? error.message : String(error), { taskId });
  }
  if (!run) return result(request, 'no-op', { taskId });

  const rows = openRows(section);
  const pending = run.pendingDelegation;
  if (!pending) {
    const candidates = abortedCandidates(run, rows);
    if (candidates.length === 0) return result(request, 'no-op', { taskId });
    if (candidates.length > 1) {
      return failure(request, 'conflict', 'RECOVERY_CANDIDATE_AMBIGUOUS', 'more than one aborted delegation has an open lifecycle row', { taskId });
    }
    return appendRecoveryLog(request, taskId, section, candidates[0]!, resolved.repoRoot, options.writeTask ?? writeTask);
  }
  if (pending.status !== 'activated') return result(request, 'no-op', { taskId });
  if (pending.client !== 'codex' || run.status !== 'running' || run.pause !== null) {
    return failure(request, 'conflict', 'RECOVERY_ORCHESTRATION_INVALID', 'activated recovery requires one running Codex delegation', {
      taskId, receiptId: pending.id, childId: pending.childId
    });
  }
  const matchingRows = rowForReceipt(rows, pending);
  if (matchingRows.length !== 1 || normalizeAgentToken(matchingRows[0]!.agent) !== 'codex' || matchingRows[0]!.note !== 'started') {
    return failure(request, 'conflict', 'RECOVERY_LOG_CONFLICT', 'activated delegation does not have one matching open lifecycle row', {
      taskId, receiptId: pending.id, childId: pending.childId
    });
  }
  if (!pending.childId) {
    return failure(request, 'conflict', 'RECOVERY_DELEGATION_INVALID', 'activated delegation has no child identity', { taskId, receiptId: pending.id });
  }
  const store = readLifecycleStore(options, resolved.repoRoot);
  const stored = readStoredEvidence(store, pending.childId);
  if ('error' in stored) return failure(request, 'owner-unknown', 'RECOVERY_STORE_UNKNOWN', stored.error.message, { taskId, receiptId: pending.id, childId: pending.childId });
  if ('missing' in stored) return failure(request, 'owner-unknown', 'RECOVERY_STOP_EVIDENCE_MISSING', 'matching Codex lifecycle stop evidence is missing', { taskId, receiptId: pending.id, childId: pending.childId });
  const evidence = validateStopRecord(stored, pending);
  if (!evidence.ok) return failure(request, evidence.code === 'RECOVERY_CONSUMER_CONFLICT' ? 'conflict' : 'owner-unknown', evidence.code, evidence.message, { taskId, receiptId: pending.id, childId: pending.childId });

  let consumed = stored;
  if (stored.consumer === null) {
    try {
      consumed = store.consume(pending.childId, pending.id, pending.hostEvidence?.hookDefinitionHash);
    } catch (error) {
      return failure(request, 'owner-unknown', 'RECOVERY_EVIDENCE_CONSUME_FAILED', error instanceof Error ? error.message : String(error), { taskId, receiptId: pending.id, childId: pending.childId });
    }
  }
  if (!consumed.consumedAt) {
    return failure(request, 'owner-unknown', 'RECOVERY_EVIDENCE_INVALID', 'consumed stop evidence has no timestamp', { taskId, receiptId: pending.id, childId: pending.childId });
  }
  const recovered = recoverActivatedOrchestrationDelegationUnderLock(taskId, {
    receiptId: pending.id,
    stage: pending.stage,
    round: pending.round,
    artifact: pending.artifact,
    startedAgent: request.agent,
    childId: pending.childId,
    stopRevision: consumed.revision,
    consumer: pending.id,
    consumedAt: consumed.consumedAt
  }, { ...options.orchestration, repoRoot: resolved.repoRoot, now: options.now });
  if (recovered.status === 'failed' || !recovered.run) {
    return failure(request, 'owner-unknown', recovered.error?.code ?? 'RECOVERY_ORCHESTRATION_FAILED', recovered.error?.message ?? 'orchestration recovery failed', { taskId, receiptId: pending.id, childId: pending.childId });
  }
  return appendRecoveryLog(request, taskId, section, { receipt: recovered.run.receipts.at(-1)!, row: matchingRows[0]! }, resolved.repoRoot, options.writeTask ?? writeTask);
}

function recoverStartedLifecycleFromAdapter(
  request: LifecycleRecoveryRequest,
  options: LifecycleRecoveryOptions = {}
): LifecycleRecoveryResult {
  return recoverStartedLifecycleUnderLock(request, options);
}

export { recoverStartedLifecycleFromAdapter, recoverStartedLifecycleUnderLock };
export type { LifecycleRecoveryOptions, LifecycleRecoveryRequest, LifecycleRecoveryResult };
