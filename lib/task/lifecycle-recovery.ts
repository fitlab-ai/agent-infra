import fs from 'node:fs';
import path from 'node:path';

import { createCodexLifecycleStore } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import type { StoredCodexLifecycle } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import { managedDelegationRole } from './delegation-receipts.ts';
import type { DelegationReceipt } from './delegation-receipts.ts';
import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { artifactName, parseArtifactName } from './artifact-name.ts';
import { locateActivityLog, pairEntries } from './activity-log.ts';
import type { LogEntry, StepRow } from './activity-log.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { resolveTaskRef, TASK_ID_RE } from './resolve-ref.ts';
import { resolveAgentRuntimeStoreRoot } from '../runtime/agent-runtime.ts';
import {
  recoverActivatedOrchestrationDelegationUnderLock,
  readRun
} from './orchestration.ts';
import type { OrchestrationOptions, OrchestrationRun } from './orchestration.ts';

const RECOVERY_NOTE_PREFIX = 'lifecycle-recovery:v1 ';
const RECOVERY_STAGES = ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'] as const;
const ACTIONS: Readonly<Record<typeof RECOVERY_STAGES[number], string>> = {
  analysis: 'Analyze Task',
  'review-analysis': 'Review Analysis',
  plan: 'Plan Task',
  'review-plan': 'Review Plan',
  code: 'Code Task',
  'review-code': 'Review Code'
};
const RECOVERY_NOTE_KEYS = [
  'version', 'taskId', 'stage', 'round', 'artifact', 'startedAgent', 'receiptId', 'childId',
  'stopRevision', 'consumer', 'consumedAt', 'owner', 'reason'
] as const;

type RecoveryStage = (typeof RECOVERY_STAGES)[number];
type LifecycleRecoveryRequest = Readonly<{
  taskRef: string;
  intent: 'recover-started';
  agent: string;
  stage: RecoveryStage;
  round: number;
  artifact: string;
  reason: string;
}>;
type RecoveryWarning = Readonly<{ code: string; message: string; action: string }>;
type LifecycleRecoveryResult = Readonly<{
  status: 'applied' | 'no-op' | 'owner-unknown' | 'conflict';
  changed: boolean;
  requestRef: string;
  intent: 'recover-started';
  taskId: string | null;
  stage: RecoveryStage | null;
  round: number | null;
  artifact: string | null;
  receiptId: string | null;
  childId: string | null;
  warning: RecoveryWarning | null;
  error: Readonly<{ code: string; message: string }> | null;
}>;
type LifecycleRecoveryOptions = Readonly<{
  repoRoot?: string;
  now?: () => string;
  orchestration?: Pick<OrchestrationOptions, 'diagnosticLog' | 'now'>;
  lifecycleStore?: ReturnType<typeof createCodexLifecycleStore>;
  releaseRecovery?: (childThreadId: string, consumer: string) => boolean;
}>;

type RecoveryNote = Readonly<{
  version: 1;
  taskId: string;
  stage: RecoveryStage;
  round: number;
  artifact: string;
  startedAgent: string;
  receiptId: string;
  childId: string;
  stopRevision: number;
  consumer: string;
  consumedAt: string;
  owner: 'terminated';
  reason: string;
}>;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\r\n]/u.test(value);
}

function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function recoveryConsumer(taskId: string, receiptId: string): string {
  return `lifecycle-recovery:${taskId}:${receiptId}`;
}

function actionPattern(stage: RecoveryStage, round: number): RegExp {
  const escaped = ACTIONS[stage].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped} \\(Round ${round}(?:, (?:fix for review-code(?:-r[2-9]|-r[1-9]\\d+)?.md|decision II-[1-9]\\d*))?\\)$`, 'u');
}

function baseStep(step: string): string {
  return step.replace(/\s*\[(?:started|aborted)\]\s*$/u, '');
}

function isRecoveryStage(value: unknown): value is RecoveryStage {
  return (RECOVERY_STAGES as readonly string[]).includes(value as string);
}

function parseRecoveryNote(note: string): RecoveryNote | null {
  if (!note.startsWith(RECOVERY_NOTE_PREFIX)) return null;
  let value: unknown;
  try { value = JSON.parse(note.slice(RECOVERY_NOTE_PREFIX.length)); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...RECOVERY_NOTE_KEYS].sort().join(',')) return null;
  if (
    record.version !== 1
    || typeof record.taskId !== 'string' || !TASK_ID_RE.test(record.taskId)
    || !isRecoveryStage(record.stage)
    || !Number.isSafeInteger(record.round) || (record.round as number) < 1
    || !text(record.artifact)
    || !text(record.startedAgent)
    || !text(record.receiptId)
    || !text(record.childId)
    || !Number.isSafeInteger(record.stopRevision) || (record.stopRevision as number) < 1
    || !text(record.consumer)
    || !timestamp(record.consumedAt)
    || record.owner !== 'terminated'
    || !text(record.reason)
  ) return null;
  const parsedArtifact = parseArtifactName(record.artifact);
  if (!parsedArtifact || parsedArtifact.family !== record.stage || parsedArtifact.round !== record.round) return null;
  if (record.consumer !== recoveryConsumer(record.taskId, record.receiptId)) return null;
  return record as RecoveryNote;
}

function renderRecoveryNote(note: RecoveryNote): string {
  return `${RECOVERY_NOTE_PREFIX}${JSON.stringify(note)}`;
}

function result(
  request: LifecycleRecoveryRequest,
  status: LifecycleRecoveryResult['status'],
  extra: Partial<LifecycleRecoveryResult> = {}
): LifecycleRecoveryResult {
  return {
    status,
    changed: status === 'applied',
    requestRef: request.taskRef,
    intent: request.intent,
    taskId: null,
    stage: request.stage,
    round: request.round,
    artifact: request.artifact,
    receiptId: null,
    childId: null,
    warning: null,
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

function recoveryFailure(
  request: LifecycleRecoveryRequest,
  status: 'owner-unknown' | 'conflict',
  code: string,
  message: string
): LifecycleRecoveryResult {
  return failure(request, status, code, message);
}

function normalizeRequest(request: LifecycleRecoveryRequest): LifecycleRecoveryRequest | { code: string; message: string } {
  if (
    !request || typeof request !== 'object'
    || request.intent !== 'recover-started'
    || typeof request.taskRef !== 'string' || !request.taskRef.trim()
    || typeof request.agent !== 'string'
    || !isRecoveryStage(request.stage)
    || !Number.isSafeInteger(request.round) || request.round < 1
    || typeof request.artifact !== 'string'
    || typeof request.reason !== 'string' || !request.reason.trim() || /[\r\n]/u.test(request.reason)
  ) return { code: 'RECOVERY_PAYLOAD_INVALID', message: 'recover-started requires a task, agent, stage, round, artifact, and single-line reason' };
  const agent = normalizeAgentToken(request.agent);
  if (!agent) return { code: 'RECOVERY_PAYLOAD_INVALID', message: 'recovery agent is not a recognized agent token' };
  const expectedArtifact = artifactName(request.stage, request.round);
  if (request.artifact !== expectedArtifact) {
    return { code: 'RECOVERY_PAYLOAD_INVALID', message: `artifact must be ${expectedArtifact} for ${request.stage} round ${request.round}` };
  }
  return { ...request, agent, reason: request.reason.trim() };
}

function targetRows(sectionEntries: readonly LogEntry[], stage: RecoveryStage, round: number): {
  rows: StepRow[];
  recoveryEntries: LogEntry[];
} {
  const pattern = actionPattern(stage, round);
  const rows = pairEntries([...sectionEntries]).filter((row) => pattern.test(row.step));
  const recoveryEntries = sectionEntries.filter((entry) => entry.step.endsWith(' [aborted]') && pattern.test(baseStep(entry.step)));
  return { rows, recoveryEntries };
}

function matchingReceipt(run: OrchestrationRun, taskId: string, request: LifecycleRecoveryRequest, receiptId?: string): DelegationReceipt | null {
  const candidates = [
    ...(run.pendingDelegation ? [run.pendingDelegation] : []),
    ...run.receipts
  ].filter((receipt) => receipt.taskId === taskId
    && receipt.stage === request.stage
    && receipt.round === request.round
    && receipt.artifact === request.artifact
    && (receiptId === undefined || receipt.id === receiptId));
  return candidates.length === 1 ? candidates[0]! : null;
}

function validateStopRecord(
  record: StoredCodexLifecycle,
  receipt: DelegationReceipt,
  consumer: string
): { ok: true; stopRevision: number; consumedAt: string } | { ok: false; code: string; message: string } {
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
    || !record.spawnObservedAt
    || host.spawnObservedAt !== record.spawnObservedAt
    || host.controllerInstanceDigest !== provenance.controllerInstanceDigest
    || host.controlGeneration !== provenance.controlGeneration
    || typeof host.controllerInstanceDigest !== 'string'
    || typeof host.controlGeneration !== 'string'
    || host.startRevision < 1
    || record.revision <= host.startRevision
  ) return { ok: false, code: 'RECOVERY_STOP_EVIDENCE_INVALID', message: 'Codex stop evidence does not match the managed activated receipt' };
  if (record.state.child?.childThreadId !== receipt.childId || record.state.stop?.childThreadId !== receipt.childId) {
    return { ok: false, code: 'RECOVERY_STOP_EVIDENCE_INVALID', message: 'Codex stop evidence child identity is inconsistent' };
  }
  if (record.consumer !== null && record.consumer !== consumer) {
    return { ok: false, code: 'RECOVERY_CONSUMER_CONFLICT', message: `Codex lifecycle evidence was consumed by '${record.consumer}'` };
  }
  if (record.consumer === null) return { ok: true, stopRevision: record.revision, consumedAt: '' };
  if (receipt.status === 'activated' && record.consumer === consumer && record.consumedAt) {
    return { ok: true, stopRevision: record.revision, consumedAt: record.consumedAt };
  }
  if (
    record.consumer !== consumer
    || !record.consumedAt
    || receipt.hostEvidence?.stopRevision !== record.revision
    || receipt.hostEvidence.consumer !== consumer
    || receipt.hostEvidence.consumedAt !== record.consumedAt
  ) return { ok: false, code: 'RECOVERY_REFERENCE_CONFLICT', message: 'recovery receipt references do not match the protected lifecycle claim' };
  return { ok: true, stopRevision: record.revision, consumedAt: record.consumedAt };
}

function readLifecycleStore(
  options: LifecycleRecoveryOptions,
  repoRoot: string
): ReturnType<typeof createCodexLifecycleStore> {
  if (options.lifecycleStore) return options.lifecycleStore;
  return createCodexLifecycleStore({
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

function taskNote(
  taskId: string,
  request: LifecycleRecoveryRequest,
  receipt: DelegationReceipt,
  stopRevision: number,
  consumer: string,
  consumedAt: string
): RecoveryNote {
  return {
    version: 1,
    taskId,
    stage: request.stage,
    round: request.round,
    artifact: request.artifact,
    startedAgent: request.agent,
    receiptId: receipt.id,
    childId: receipt.childId!,
    stopRevision,
    consumer,
    consumedAt,
    owner: 'terminated',
    reason: request.reason
  };
}

function releaseResult(
  request: LifecycleRecoveryRequest,
  taskId: string,
  receipt: DelegationReceipt,
  released: boolean,
  previousChange: boolean
): LifecycleRecoveryResult {
  if (released) return result(request, 'applied', { taskId, receiptId: receipt.id, childId: receipt.childId });
  return result(request, 'applied', {
    changed: previousChange,
    taskId,
    receiptId: receipt.id,
    childId: receipt.childId,
    warning: {
      code: 'RECOVERY_RELEASE_RETRY_REQUIRED',
      message: 'recovery receipt and Activity Log are complete but the protected lifecycle claim could not be released',
      action: 'retry recover-started with the same selector and reason'
    }
  });
}

function matchingPostActivationAbortedReceipts(
  run: OrchestrationRun,
  taskId: string,
  request: LifecycleRecoveryRequest
): DelegationReceipt[] {
  return run.receipts.filter((receipt) => receipt.status === 'aborted'
    && receipt.activatedAt !== null
    && receipt.agent === null
    && receipt.taskId === taskId
    && receipt.stage === request.stage
    && receipt.round === request.round
    && receipt.artifact === request.artifact);
}

function sameRecoveryNote(left: RecoveryNote, right: RecoveryNote): boolean {
  return left.version === right.version
    && left.taskId === right.taskId
    && left.stage === right.stage
    && left.round === right.round
    && left.artifact === right.artifact
    && left.startedAgent === right.startedAgent
    && left.receiptId === right.receiptId
    && left.childId === right.childId
    && left.stopRevision === right.stopRevision
    && left.consumer === right.consumer
    && left.consumedAt === right.consumedAt
    && left.owner === right.owner
    && left.reason === right.reason;
}

function verifyRecoveryCommit(
  taskMdPath: string,
  taskDir: string,
  taskId: string,
  request: LifecycleRecoveryRequest,
  note: RecoveryNote,
  options: LifecycleRecoveryOptions
): { ok: true; receipt: DelegationReceipt } | { ok: false; message: string } {
  try {
    const content = fs.readFileSync(taskMdPath, 'utf8');
    parseTypedTaskFrontmatter(content);
    const section = locateActivityLog(content);
    if (!section) return { ok: false, message: 'recovery Activity Log cannot be reread uniquely' };
    const targets = targetRows(section.entries, request.stage, request.round);
    const paired = targets.rows.filter((row) => row.started !== '' && row.done !== '');
    if (targets.recoveryEntries.length !== 1 || paired.length !== 1 || paired[0]!.done !== targets.recoveryEntries[0]!.time) {
      return { ok: false, message: 'recovery Activity Log does not contain one completed started/aborted pair' };
    }
    const logged = parseRecoveryNote(targets.recoveryEntries[0]!.note);
    if (!logged || !sameRecoveryNote(logged, note)) {
      return { ok: false, message: 'recovery Activity Log note changed during commit verification' };
    }
    const run = readRun(taskDir, options.orchestration);
    if (!run || run.status !== 'running' || run.pendingDelegation !== null) {
      return { ok: false, message: 'orchestration recovery state is not running with no pending delegation' };
    }
    const receipts = matchingPostActivationAbortedReceipts(run, taskId, request);
    if (receipts.length !== 1 || receipts[0]!.id !== note.receiptId) {
      return { ok: false, message: 'orchestration recovery state does not contain one matching aborted receipt' };
    }
    const receipt = receipts[0]!;
    if (
      receipt.childId !== note.childId
      || receipt.hostEvidence?.stopRevision !== note.stopRevision
      || receipt.hostEvidence.consumer !== note.consumer
      || receipt.hostEvidence.consumedAt !== note.consumedAt
    ) return { ok: false, message: 'orchestration recovery references changed during commit verification' };
    const store = readLifecycleStore(options, options.repoRoot ?? path.resolve(taskDir, '../../../..'));
    const stored = readStoredEvidence(store, note.childId);
    if ('error' in stored) return { ok: false, message: stored.error.message };
    if ('missing' in stored) return { ok: false, message: 'protected lifecycle claim disappeared before release' };
    const evidence = validateStopRecord(stored, receipt, note.consumer);
    if (!evidence.ok || evidence.stopRevision !== note.stopRevision || evidence.consumedAt !== note.consumedAt) {
      return { ok: false, message: evidence.ok ? 'protected lifecycle claim references changed during commit verification' : evidence.message };
    }
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function recoverStartedLifecycleUnderLock(
  requestInput: LifecycleRecoveryRequest,
  options: LifecycleRecoveryOptions = {}
): LifecycleRecoveryResult {
  const normalized = normalizeRequest(requestInput);
  if ('code' in normalized) return failure(requestInput, 'conflict', normalized.code, normalized.message);
  const request = normalized;
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(request, 'conflict', resolved.code, resolved.message);
  const taskId = resolved.taskId;
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return failure(request, 'owner-unknown', 'RECOVERY_TASK_READ_FAILED', String(error), { taskId }); }
  try { parseTypedTaskFrontmatter(content); }
  catch (error) { return failure(request, 'conflict', 'RECOVERY_TASK_INVALID', error instanceof Error ? error.message : String(error), { taskId }); }
  const section = locateActivityLog(content);
  if (!section) return failure(request, 'conflict', 'RECOVERY_LOG_INVALID', 'task has no unique Activity Log section', { taskId });
  const targets = targetRows(section.entries, request.stage, request.round);
  const open = targets.rows.filter((row) => row.started !== '' && row.done === '');
  if (open.length > 1 || targets.recoveryEntries.length > 1) {
    return failure(request, 'conflict', 'RECOVERY_SELECTOR_AMBIGUOUS', 'recovery selector does not identify one lifecycle attempt', { taskId });
  }
  let run: OrchestrationRun | null;
  try { run = readRun(resolved.taskDir, options.orchestration); }
  catch (error) { return failure(request, 'owner-unknown', 'RECOVERY_ORCHESTRATION_UNKNOWN', String(error), { taskId }); }
  if (!run) return failure(request, 'owner-unknown', 'RECOVERY_ORCHESTRATION_MISSING', 'no orchestration run exists for the open lifecycle execution', { taskId });

  if (open.length === 0) {
    if (targets.recoveryEntries.length !== 1) {
      return failure(request, 'conflict', 'RECOVERY_TERMINAL_MISSING', 'there is no matching open or structured recovery lifecycle row', { taskId });
    }
    const paired = targets.rows.filter((row) => row.started !== '' && row.done !== '');
    if (paired.length !== 1 || paired[0]!.done !== targets.recoveryEntries[0]!.time) {
      return failure(request, 'conflict', 'RECOVERY_LOG_CONFLICT', 'recovery terminal row is not paired with the matching started row', { taskId });
    }
    const note = parseRecoveryNote(targets.recoveryEntries[0]!.note);
    if (!note || note.taskId !== taskId || note.stage !== request.stage || note.round !== request.round || note.artifact !== request.artifact || note.startedAgent !== request.agent || note.reason !== request.reason) {
      return failure(request, 'conflict', 'RECOVERY_NOTE_INVALID', 'recovery Activity Log note does not match the selector', { taskId });
    }
    if (run.status !== 'running' || run.pendingDelegation !== null) {
      return failure(request, 'conflict', 'RECOVERY_ORCHESTRATION_INVALID', 'completed recovery state must be running with no pending delegation', { taskId });
    }
    const postActivationReceipts = matchingPostActivationAbortedReceipts(run, taskId, request);
    if (postActivationReceipts.length !== 1) {
      return failure(request, 'conflict', 'RECOVERY_RECEIPT_INVALID', 'there is not one unique post-activation aborted receipt', { taskId });
    }
    const receipt = matchingReceipt(run, taskId, request, note.receiptId);
    if (!receipt || receipt.status !== 'aborted' || receipt.agent !== null || receipt.childId !== note.childId) {
      return failure(request, 'conflict', 'RECOVERY_RECEIPT_INVALID', 'there is not one matching post-activation aborted receipt', { taskId, receiptId: note.receiptId, childId: note.childId });
    }
    const consumer = recoveryConsumer(taskId, receipt.id);
    if (note.consumer !== consumer || receipt.hostEvidence?.stopRevision !== note.stopRevision || receipt.hostEvidence.consumer !== consumer || receipt.hostEvidence.consumedAt !== note.consumedAt) {
      return failure(request, 'conflict', 'RECOVERY_REFERENCE_CONFLICT', 'recovery receipt and Activity Log references do not match', { taskId, receiptId: receipt.id, childId: receipt.childId });
    }
    const store = readLifecycleStore(options, resolved.repoRoot);
    const stored = readStoredEvidence(store, note.childId);
    if ('error' in stored) return failure(request, 'owner-unknown', 'RECOVERY_STORE_UNKNOWN', stored.error.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
    if ('missing' in stored) return result(request, 'no-op', { taskId, receiptId: receipt.id, childId: receipt.childId });
    if (stored.consumer === null || !stored.consumedAt) {
      return failure(request, 'conflict', 'RECOVERY_REFERENCE_CONFLICT', 'complete recovery facts do not reference the protected recovery claim', { taskId, receiptId: receipt.id, childId: receipt.childId });
    }
    const evidence = validateStopRecord(stored, receipt, consumer);
    if (!evidence.ok) return failure(request, evidence.code === 'RECOVERY_CONSUMER_CONFLICT' ? 'conflict' : 'owner-unknown', evidence.code, evidence.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
    let released = false;
    try { released = (options.releaseRecovery ?? store.releaseRecovery)(note.childId, consumer); }
    catch (error) {
      return releaseResult(request, taskId, receipt, false, false);
    }
    return releaseResult(request, taskId, receipt, released, false);
  }

  const started = open[0]!;
  if (normalizeAgentToken(started.agent) !== request.agent || started.note !== 'started') {
    return failure(request, 'conflict', 'RECOVERY_SELECTOR_MISMATCH', 'open started lifecycle row does not match the recovery selector', { taskId });
  }
  if (targets.recoveryEntries.length > 0) {
    return failure(request, 'conflict', 'RECOVERY_LOG_CONFLICT', 'open lifecycle execution already has a recovery terminal row', { taskId });
  }
  const pending = run.pendingDelegation;
  const recovered = run.receipts.filter((candidate) => candidate.status === 'aborted'
    && candidate.activatedAt !== null
    && candidate.agent === null
    && candidate.taskId === taskId
    && candidate.stage === request.stage
    && candidate.round === request.round
    && candidate.artifact === request.artifact);
  if (pending && recovered.length > 0) {
    return failure(request, 'conflict', 'RECOVERY_RECEIPT_INVALID', 'open lifecycle execution has both a pending and an aborted matching delegation', { taskId });
  }
  const receipt = pending ?? (recovered.length === 1 ? recovered[0]! : null);
  if (!receipt || (pending && (receipt.status !== 'activated' || receipt.client !== 'codex')) || (!pending && receipt.status !== 'aborted')) {
    return failure(request, 'owner-unknown', 'RECOVERY_DELEGATION_UNAVAILABLE', 'open lifecycle execution is not backed by one matching activated Codex delegation', { taskId });
  }
  if (normalizeAgentToken(started.agent) !== normalizeAgentToken(receipt.client)) {
    return failure(request, 'conflict', 'RECOVERY_SELECTOR_MISMATCH', 'started agent does not match the delegation client', { taskId, receiptId: receipt.id, childId: receipt.childId });
  }
  const consumer = recoveryConsumer(taskId, receipt.id);
  const store = readLifecycleStore(options, resolved.repoRoot);
  const stored = readStoredEvidence(store, receipt.childId ?? '');
  if ('error' in stored) return failure(request, 'owner-unknown', 'RECOVERY_STORE_UNKNOWN', stored.error.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  if ('missing' in stored) return failure(request, 'owner-unknown', 'RECOVERY_STOP_EVIDENCE_MISSING', 'matching Codex lifecycle stop evidence is missing', { taskId, receiptId: receipt.id, childId: receipt.childId });
  const evidence = validateStopRecord(stored, receipt, consumer);
  if (!evidence.ok) return failure(request, evidence.code === 'RECOVERY_CONSUMER_CONFLICT' ? 'conflict' : 'owner-unknown', evidence.code, evidence.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  let claimed = stored;
  if (stored.consumer === null) {
    try { claimed = store.consume(receipt.childId!, consumer, receipt.hostEvidence?.hookDefinitionHash); }
    catch (error) { return failure(request, 'owner-unknown', 'RECOVERY_CLAIM_FAILED', error instanceof Error ? error.message : String(error), { taskId, receiptId: receipt.id, childId: receipt.childId }); }
  }
  const stopRevision = claimed.revision;
  const consumedAt = claimed.consumedAt;
  if (!consumedAt) return failure(request, 'owner-unknown', 'RECOVERY_CLAIM_INVALID', 'protected lifecycle claim has no consumed timestamp', { taskId, receiptId: receipt.id, childId: receipt.childId });
  if (receipt.status === 'activated') {
    const recoveredRun = recoverActivatedOrchestrationDelegationUnderLock(taskId, {
      receiptId: receipt.id,
      stage: request.stage,
      round: request.round,
      artifact: request.artifact,
      startedAgent: request.agent,
      childId: receipt.childId!,
      stopRevision,
      consumer,
      consumedAt
    }, { ...options.orchestration, repoRoot: resolved.repoRoot, now: options.now });
    if (recoveredRun.status === 'failed' || !recoveredRun.run) {
      return failure(request, 'owner-unknown', recoveredRun.error?.code ?? 'RECOVERY_ORCHESTRATION_FAILED', recoveredRun.error?.message ?? 'orchestration recovery failed', { taskId, receiptId: receipt.id, childId: receipt.childId });
    }
  }
  const note = taskNote(taskId, request, receipt, stopRevision, consumer, consumedAt);
  const metadata = captureTaskWriteMetadata();
  const updatedBody = `${section.body ? `${section.body}\n` : ''}- ${metadata.timestamp} — **${baseStep(started.step)} [aborted]** by ${request.agent} — ${renderRecoveryNote(note)}`;
  const written = writeTask({
    taskRef: taskId,
    expectedState: 'active',
    mutations: [{ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body: updatedBody }]
  }, { repoRoot: resolved.repoRoot, metadataProvider: () => metadata });
  if (written.status === 'failed') {
    return failure(request, 'owner-unknown', 'RECOVERY_LOG_WRITE_FAILED', written.error.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  }
  const verified = verifyRecoveryCommit(resolved.taskMdPath, resolved.taskDir, taskId, request, note, options);
  if (!verified.ok) {
    return failure(request, 'owner-unknown', 'RECOVERY_COMMIT_VERIFY_FAILED', verified.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  }
  let released = false;
  try { released = (options.releaseRecovery ?? store.releaseRecovery)(receipt.childId!, consumer); }
  catch { released = false; }
  if (!released) {
    return releaseResult(request, taskId, receipt, false, true);
  }
  return result(request, 'applied', { taskId, receiptId: receipt.id, childId: receipt.childId });
}

export {
  RECOVERY_NOTE_PREFIX,
  parseRecoveryNote,
  recoveryFailure,
  recoveryConsumer,
  recoverStartedLifecycleUnderLock,
  renderRecoveryNote
};
export type { LifecycleRecoveryOptions, LifecycleRecoveryRequest, LifecycleRecoveryResult, RecoveryNote, RecoveryStage };
