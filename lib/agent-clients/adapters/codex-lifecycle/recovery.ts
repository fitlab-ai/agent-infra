import fs from 'node:fs';
import path from 'node:path';

import { createCodexLifecycleStore } from './store.ts';
import type { StoredCodexLifecycle } from './store.ts';
import { managedDelegationRole } from '../../../task/delegation-receipts.ts';
import type { DelegationReceipt } from '../../../task/delegation-receipts.ts';
import { normalizeAgentToken } from '../../tokens.ts';
import { artifactName, parseArtifactName } from '../../../task/artifact-name.ts';
import { locateActivityLog, pairEntries } from '../../../task/activity-log.ts';
import type { LogEntry, StepRow } from '../../../task/activity-log.ts';
import { captureTaskWriteMetadata, writeTask } from '../../../task/write.ts';
import { parseTypedTaskFrontmatter } from '../../../task/frontmatter.ts';
import { resolveTaskRef, TASK_ID_RE } from '../../../task/resolve-ref.ts';
import { resolveAgentRuntimeStoreRoot } from '../../../runtime/agent-runtime.ts';
import {
  finishActivatedRecoveryOrchestrationUnderLock,
  ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
  pauseOrchestration,
  recoverActivatedOrchestrationDelegationUnderLock,
  readRun
} from '../../../task/orchestration.ts';
import type { OrchestrationOptions, OrchestrationRun } from '../../../task/orchestration.ts';
import { isRecoveryWarning, sameRecoveryWarning } from '../../../task/recovery-warning.ts';
import type { RecoveryWarning } from '../../../task/recovery-warning.ts';
import type {
  AgentClientLifecycleRecoveryRequest,
  AgentClientLifecycleRecoveryResult
} from '../../adapter.ts';

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
type LifecycleRecoverySelectorRequest = Readonly<{
  taskRef: string;
  intent: 'recover-started';
  agent: string;
  stage: RecoveryStage;
  round: number;
  artifact: string;
  reason: string;
}>;
type LifecycleRecoveryAutoRequest = Readonly<{
  taskRef: string;
  intent: 'recover-started';
  agent: string;
  auto: true;
}>;
type LifecycleRecoveryRequest = AgentClientLifecycleRecoveryRequest;
type RecoveryCommitVerification = { ok: true; receipt: DelegationReceipt } | { ok: false; message: string };
type LifecycleRecoveryResult = AgentClientLifecycleRecoveryResult;
type LifecycleRecoveryOptions = Readonly<{
  repoRoot?: string;
  now?: () => string;
  orchestration?: Pick<OrchestrationOptions, 'diagnosticLog' | 'now'>;
  lifecycleStore?: ReturnType<typeof createCodexLifecycleStore>;
  releaseRecovery?: (childThreadId: string, consumer: string) => boolean;
  writeTask?: typeof writeTask;
  verifyRecoveryCommit?: (
    taskMdPath: string,
    taskDir: string,
    taskId: string,
    request: LifecycleRecoverySelectorRequest,
    note: RecoveryNote,
    options: LifecycleRecoveryOptions
  ) => RecoveryCommitVerification;
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
type RecoveryTerminalFacts = Readonly<{
  note: RecoveryNote;
  receipt: DelegationReceipt;
  consumer: string;
  stored: StoredCodexLifecycle | null;
}>;
type RecoveryTerminalFactsResult =
  | { ok: true; facts: RecoveryTerminalFacts }
  | { ok: false; code: string; message: string };

const RECOVERY_RELEASE_RETRY_WARNING: RecoveryWarning = Object.freeze({
  code: 'RECOVERY_RELEASE_RETRY_REQUIRED',
  message: 'recovery receipt and Activity Log are complete but the protected lifecycle claim could not be released',
  action: 'retry recover-started with the same selector and reason'
});
const AUTO_RECOVERY_REASON = 'automatic recovery of a terminated activated delegation';

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\r\n]/u.test(value);
}

function isReleaseRetryWarning(value: unknown): value is RecoveryWarning {
  return sameRecoveryWarning(value, RECOVERY_RELEASE_RETRY_WARNING);
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
    targetState: 'active',
    requestRef: request.taskRef,
    intent: request.intent,
    taskId: null,
    stage: 'stage' in request ? request.stage : null,
    round: 'round' in request ? request.round : null,
    artifact: 'artifact' in request ? request.artifact : null,
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
  ) return { code: 'RECOVERY_PAYLOAD_INVALID', message: 'recover-started requires a task and agent' };
  const agent = normalizeAgentToken(request.agent);
  if (!agent) return { code: 'RECOVERY_PAYLOAD_INVALID', message: 'recovery agent is not a recognized agent token' };
  if ('auto' in request) {
    const record = request as unknown as Record<string, unknown>;
    if (request.auto !== true || agent !== 'codex'
      || record.stage !== undefined || record.round !== undefined
      || record.artifact !== undefined || record.reason !== undefined) {
      return { code: 'RECOVERY_PAYLOAD_INVALID', message: 'automatic recovery requires Codex and cannot include an explicit selector' };
    }
    return { taskRef: request.taskRef, intent: 'recover-started', agent, auto: true };
  }
  if (
    !isRecoveryStage(request.stage)
    || !Number.isSafeInteger(request.round) || request.round < 1
    || typeof request.artifact !== 'string'
    || typeof request.reason !== 'string' || !request.reason.trim() || /[\r\n]/u.test(request.reason)
  ) return { code: 'RECOVERY_PAYLOAD_INVALID', message: 'explicit recover-started requires stage, round, artifact, and a single-line reason' };
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
  request: LifecycleRecoverySelectorRequest,
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
    warning: RECOVERY_RELEASE_RETRY_WARNING
  });
}

function isPostActivationAbortedReceipt(
  receipt: DelegationReceipt,
  taskId: string,
  request: LifecycleRecoverySelectorRequest
): boolean {
  return receipt.status === 'aborted'
    && receipt.activatedAt !== null
    && receipt.agent === null
    && receipt.taskId === taskId
    && receipt.stage === request.stage
    && receipt.round === request.round
    && receipt.artifact === request.artifact;
}

function matchingPostActivationAbortedReceipts(
  run: OrchestrationRun,
  taskId: string,
  request: LifecycleRecoverySelectorRequest
): DelegationReceipt[] {
  return run.receipts.filter((receipt) => isPostActivationAbortedReceipt(receipt, taskId, request));
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

function recoveryNoteMatchesRequest(
  note: RecoveryNote,
  taskId: string,
  request: LifecycleRecoverySelectorRequest
): boolean {
  return note.taskId === taskId
    && note.stage === request.stage
    && note.round === request.round
    && note.artifact === request.artifact
    && note.startedAgent === request.agent
    && note.reason === request.reason;
}

function recoveryReferencesMatch(
  receipt: DelegationReceipt,
  note: RecoveryNote,
  consumer: string
): boolean {
  return receipt.childId === note.childId
    && note.consumer === consumer
    && receipt.hostEvidence?.stopRevision === note.stopRevision
    && receipt.hostEvidence.consumer === consumer
    && receipt.hostEvidence.consumedAt === note.consumedAt;
}

function recoveryRunCanFinish(run: OrchestrationRun | null): run is OrchestrationRun {
  return run !== null
    && run.pendingDelegation === null
    && (
      (run.status === 'running' && run.pause === null)
      || (run.status === 'paused'
        && run.pause?.code === ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE
        && run.pause.recoverable === true)
    );
}

function recoveryRunAllowsActivatedMutation(run: OrchestrationRun): boolean {
  return (run.status === 'running' && run.pause === null)
    || (run.status === 'paused'
      && run.pause?.code === ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE
      && run.pause.recoverable === true);
}

function recoveryTerminalFailureStatus(code: string): 'owner-unknown' | 'conflict' {
  switch (code) {
    case 'RECOVERY_LOG_CONFLICT':
    case 'RECOVERY_NOTE_INVALID':
    case 'RECOVERY_ORCHESTRATION_INVALID':
    case 'RECOVERY_RECEIPT_INVALID':
    case 'RECOVERY_REFERENCE_CONFLICT':
    case 'RECOVERY_CONSUMER_CONFLICT':
      return 'conflict';
    default:
      return 'owner-unknown';
  }
}

function readRecoveryTerminalFacts(
  section: Readonly<{ entries: readonly LogEntry[] }>,
  taskId: string,
  request: LifecycleRecoverySelectorRequest,
  run: OrchestrationRun | null,
  store: ReturnType<typeof createCodexLifecycleStore>
): RecoveryTerminalFactsResult {
  const targets = targetRows(section.entries, request.stage, request.round);
  const paired = targets.rows.filter((row) => row.started !== '' && row.done !== '');
  if (targets.recoveryEntries.length !== 1 || paired.length !== 1
    || paired[0]!.done !== targets.recoveryEntries[0]!.time) {
    return { ok: false, code: 'RECOVERY_LOG_CONFLICT', message: 'recovery Activity Log does not contain one completed started/aborted pair' };
  }
  const note = parseRecoveryNote(targets.recoveryEntries[0]!.note);
  if (!note || !recoveryNoteMatchesRequest(note, taskId, request)) {
    return { ok: false, code: 'RECOVERY_NOTE_INVALID', message: 'recovery Activity Log note does not match the selector' };
  }
  if (!recoveryRunCanFinish(run)) {
    return { ok: false, code: 'RECOVERY_ORCHESTRATION_INVALID', message: 'recovery state must be running or use the dedicated recovery pause, with no pending delegation' };
  }
  const receipts = matchingPostActivationAbortedReceipts(run, taskId, request);
  if (receipts.length !== 1 || receipts[0]!.id !== note.receiptId) {
    return { ok: false, code: 'RECOVERY_RECEIPT_INVALID', message: 'there is not one matching post-activation aborted receipt' };
  }
  const receipt = receipts[0]!;
  const consumer = recoveryConsumer(taskId, receipt.id);
  if (!recoveryReferencesMatch(receipt, note, consumer)) {
    return { ok: false, code: 'RECOVERY_REFERENCE_CONFLICT', message: 'recovery receipt and Activity Log references do not match' };
  }
  const stored = readStoredEvidence(store, note.childId);
  if ('error' in stored) return { ok: false, code: 'RECOVERY_STORE_UNKNOWN', message: stored.error.message };
  if ('missing' in stored) return { ok: true, facts: { note, receipt, consumer, stored: null } };
  const evidence = validateStopRecord(stored, receipt, consumer);
  if (!evidence.ok) return evidence;
  if (stored.consumer !== consumer || !stored.consumedAt
    || evidence.stopRevision !== note.stopRevision || evidence.consumedAt !== note.consumedAt) {
    return { ok: false, code: 'RECOVERY_REFERENCE_CONFLICT', message: 'complete recovery facts do not reference the protected recovery claim' };
  }
  return { ok: true, facts: { note, receipt, consumer, stored } };
}

function verifyRecoveryCommit(
  taskMdPath: string,
  taskDir: string,
  taskId: string,
  request: LifecycleRecoverySelectorRequest,
  note: RecoveryNote,
  options: LifecycleRecoveryOptions
): RecoveryCommitVerification {
  try {
    const content = fs.readFileSync(taskMdPath, 'utf8');
    parseTypedTaskFrontmatter(content);
    const section = locateActivityLog(content);
    if (!section) return { ok: false, message: 'recovery Activity Log cannot be reread uniquely' };
    const run = readRun(taskDir, options.orchestration);
    const store = readLifecycleStore(options, options.repoRoot ?? path.resolve(taskDir, '../../../..'));
    const facts = readRecoveryTerminalFacts(section, taskId, request, run, store);
    if (!facts.ok) return { ok: false, message: facts.message };
    if (!sameRecoveryNote(facts.facts.note, note)) {
      return { ok: false, message: 'recovery Activity Log note changed during commit verification' };
    }
    if (!facts.facts.stored) return { ok: false, message: 'protected lifecycle claim disappeared before release' };
    return { ok: true, receipt: facts.facts.receipt };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

type AutoRecoveryResolution =
  | { kind: 'not-needed'; taskId: string }
  | { kind: 'candidate'; request: LifecycleRecoverySelectorRequest }
  | { kind: 'failure'; status: 'owner-unknown' | 'conflict'; code: string; message: string; taskId: string | null };

function selectorForReceipt(
  request: LifecycleRecoveryAutoRequest,
  receipt: DelegationReceipt,
  reason: string
): LifecycleRecoverySelectorRequest | null {
  if (!isRecoveryStage(receipt.stage) || receipt.round < 1 || receipt.artifact !== artifactName(receipt.stage, receipt.round)) {
    return null;
  }
  return {
    taskRef: request.taskRef,
    intent: 'recover-started',
    agent: request.agent,
    stage: receipt.stage,
    round: receipt.round,
    artifact: receipt.artifact,
    reason
  };
}

function resolveAutoRecoveryRequest(
  request: LifecycleRecoveryAutoRequest,
  options: LifecycleRecoveryOptions
): AutoRecoveryResolution {
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return { kind: 'failure', status: 'conflict', code: resolved.code, message: resolved.message, taskId: resolved.taskId };
  let content: string;
  try { content = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) { return { kind: 'failure', status: 'owner-unknown', code: 'RECOVERY_TASK_READ_FAILED', message: String(error), taskId: resolved.taskId }; }
  try { parseTypedTaskFrontmatter(content); }
  catch (error) {
    return {
      kind: 'failure', status: 'conflict', code: 'RECOVERY_TASK_INVALID',
      message: error instanceof Error ? error.message : String(error), taskId: resolved.taskId
    };
  }
  const section = locateActivityLog(content);
  if (!section) {
    return { kind: 'failure', status: 'conflict', code: 'RECOVERY_LOG_INVALID', message: 'task has no unique Activity Log section', taskId: resolved.taskId };
  }
  const recoveryEntries = section.entries.filter((entry) => entry.note.startsWith(RECOVERY_NOTE_PREFIX));
  const parsedNotes = recoveryEntries.map((entry) => parseRecoveryNote(entry.note));
  if (parsedNotes.some((note) => note === null)) {
    return { kind: 'failure', status: 'conflict', code: 'RECOVERY_NOTE_INVALID', message: 'structured recovery Activity Log note is invalid', taskId: resolved.taskId };
  }
  const notes = parsedNotes as RecoveryNote[];
  let run: OrchestrationRun | null;
  try { run = readRun(resolved.taskDir, options.orchestration); }
  catch (error) {
    return { kind: 'failure', status: 'owner-unknown', code: 'RECOVERY_ORCHESTRATION_UNKNOWN', message: String(error), taskId: resolved.taskId };
  }
  if (!run) {
    return notes.length === 0
      ? { kind: 'not-needed', taskId: resolved.taskId }
      : { kind: 'failure', status: 'conflict', code: 'RECOVERY_ORCHESTRATION_MISSING', message: 'structured recovery facts exist without an orchestration run', taskId: resolved.taskId };
  }

  const candidates = new Map<string, LifecycleRecoverySelectorRequest>();
  const noteByReceipt = new Map(notes.map((note) => [note.receiptId, note]));
  const noteOrderByReceipt = new Map(notes.map((note, index) => [note.receiptId, index]));
  const dedicatedPause = run.status === 'paused'
    && run.pause?.code === ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE;
  let dedicatedPauseFallback: Readonly<{
    receiptId: string;
    request: LifecycleRecoverySelectorRequest;
    noteOrder: number;
  }> | null = null;
  const pending = run.pendingDelegation;
  if (pending?.status === 'activated') {
    if (pending.client !== 'codex') {
      return { kind: 'failure', status: 'conflict', code: 'RECOVERY_CLIENT_UNSUPPORTED', message: 'automatic recovery only supports Codex activated delegations', taskId: resolved.taskId };
    }
    const selector = selectorForReceipt(request, pending, AUTO_RECOVERY_REASON);
    if (!selector) {
      return { kind: 'failure', status: 'conflict', code: 'RECOVERY_SELECTOR_MISMATCH', message: 'activated delegation has an invalid lifecycle selector', taskId: resolved.taskId };
    }
    candidates.set(pending.id, selector);
  }

  const store = readLifecycleStore(options, resolved.repoRoot);
  for (const receipt of run.receipts) {
    if (receipt.status !== 'aborted' || receipt.activatedAt === null || receipt.agent !== null || receipt.client !== 'codex') continue;
    const selector = selectorForReceipt(request, receipt, AUTO_RECOVERY_REASON);
    if (!selector) {
      return { kind: 'failure', status: 'conflict', code: 'RECOVERY_SELECTOR_MISMATCH', message: 'aborted delegation has an invalid lifecycle selector', taskId: resolved.taskId };
    }
    const targets = targetRows(section.entries, selector.stage, selector.round);
    const open = targets.rows.filter((row) => row.started !== '' && row.done === '');
    const note = noteByReceipt.get(receipt.id) ?? null;
    if (targets.recoveryEntries.length > 0 && !note) {
      return { kind: 'failure', status: 'conflict', code: 'RECOVERY_NOTE_INVALID', message: 'recovery terminal row does not match an aborted receipt', taskId: resolved.taskId };
    }
    if (note && (note.taskId !== resolved.taskId || note.childId !== receipt.childId)) {
      return { kind: 'failure', status: 'conflict', code: 'RECOVERY_REFERENCE_CONFLICT', message: 'recovery note does not match its aborted receipt', taskId: resolved.taskId };
    }
    let retainedClaim = false;
    if (note) {
      const stored = readStoredEvidence(store, note.childId);
      if ('error' in stored) {
        return { kind: 'failure', status: 'owner-unknown', code: 'RECOVERY_STORE_UNKNOWN', message: stored.error.message, taskId: resolved.taskId };
      }
      retainedClaim = !('missing' in stored);
    }
    if (open.length > 0 || (note && retainedClaim)) {
      candidates.set(receipt.id, { ...selector, reason: note?.reason ?? AUTO_RECOVERY_REASON });
    } else if (note && dedicatedPause) {
      const noteOrder = noteOrderByReceipt.get(receipt.id) ?? -1;
      if (!dedicatedPauseFallback || noteOrder > dedicatedPauseFallback.noteOrder) {
        dedicatedPauseFallback = {
          receiptId: receipt.id,
          request: { ...selector, reason: note.reason },
          noteOrder
        };
      }
    }
  }

  for (const note of notes) {
    if (!run.receipts.some((receipt) => receipt.id === note.receiptId)) {
      return { kind: 'failure', status: 'conflict', code: 'RECOVERY_REFERENCE_CONFLICT', message: 'recovery note references a missing orchestration receipt', taskId: resolved.taskId };
    }
  }
  if (candidates.size === 0 && dedicatedPauseFallback) {
    candidates.set(dedicatedPauseFallback.receiptId, dedicatedPauseFallback.request);
  }
  if (candidates.size > 1) {
    return { kind: 'failure', status: 'conflict', code: 'RECOVERY_SELECTOR_AMBIGUOUS', message: 'automatic recovery found multiple candidate lifecycle attempts', taskId: resolved.taskId };
  }
  if (candidates.size === 1) return { kind: 'candidate', request: [...candidates.values()][0]! };
  if (run.status === 'paused' && run.pause?.code === ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE) {
    return { kind: 'failure', status: 'conflict', code: 'RECOVERY_REFERENCE_CONFLICT', message: 'dedicated recovery pause has no matching recovery transaction', taskId: resolved.taskId };
  }
  return { kind: 'not-needed', taskId: resolved.taskId };
}

function activatedRecoveryEvent(
  request: LifecycleRecoverySelectorRequest,
  receipt: DelegationReceipt,
  note: RecoveryNote
) {
  return {
    receiptId: receipt.id,
    stage: request.stage,
    round: request.round,
    artifact: request.artifact,
    startedAgent: request.agent,
    childId: note.childId,
    stopRevision: note.stopRevision,
    consumer: note.consumer,
    consumedAt: note.consumedAt
  } as const;
}

function finishRecoveryRun(
  taskId: string,
  request: LifecycleRecoverySelectorRequest,
  receipt: DelegationReceipt,
  note: RecoveryNote,
  options: LifecycleRecoveryOptions
): { ok: true; changed: boolean } | { ok: false; code: string; message: string } {
  const finished = finishActivatedRecoveryOrchestrationUnderLock(
    taskId,
    activatedRecoveryEvent(request, receipt, note),
    { ...options.orchestration, repoRoot: options.repoRoot, now: options.now }
  );
  if (finished.status === 'failed') {
    return {
      ok: false,
      code: finished.error?.code ?? 'RECOVERY_ORCHESTRATION_FAILED',
      message: finished.error?.message ?? 'orchestration recovery completion failed'
    };
  }
  return { ok: true, changed: finished.changed };
}

function recoveryDomainFailure(): Readonly<Record<string, unknown>> {
  return { consistent: false, recovery: true, targetState: 'active' };
}

export function readLifecycleRecoveryDomainEvidence(
  repoRoot: string,
  requestInput: LifecycleRecoveryRequest,
  terminalResult: Readonly<{
    status: string;
    changed: boolean | null;
    targetState: string | null;
    warning?: unknown | null;
    receiptId?: unknown;
    stage?: unknown;
    round?: unknown;
    artifact?: unknown;
  }>,
  options: Pick<LifecycleRecoveryOptions, 'lifecycleStore' | 'now'> = {}
): Readonly<Record<string, unknown>> {
  const terminalStateValid = terminalResult.status === 'no-op'
    ? terminalResult.changed === false
    : terminalResult.status === 'applied'
      && (terminalResult.changed === true || (terminalResult.changed === false && isReleaseRetryWarning(terminalResult.warning)));
  const normalized = normalizeRequest(requestInput);
  if ('code' in normalized || terminalResult.targetState !== 'active'
    || !terminalStateValid) return recoveryDomainFailure();
  let request: LifecycleRecoverySelectorRequest;
  if ('auto' in normalized) {
    const automatic = resolveAutoRecoveryRequest(normalized, { ...options, repoRoot });
    if (automatic.kind === 'not-needed' && terminalResult.status === 'no-op' && terminalResult.changed === false) {
      return { consistent: true, recovery: true, targetState: 'active', recoveryState: 'not-needed' };
    }
    const resolved = resolveTaskRef(normalized.taskRef, { repoRoot });
    if (!resolved.ok) return recoveryDomainFailure();
    try {
      const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
      const section = locateActivityLog(content);
      if (!section) return recoveryDomainFailure();
      const notes = section.entries.map((entry) => parseRecoveryNote(entry.note))
        .filter((note): note is RecoveryNote => note !== null);
      const run = readRun(resolved.taskDir);
      if (!run) return recoveryDomainFailure();
      const store = readLifecycleStore(options, repoRoot);
      const candidates = notes.filter((note) => {
        if (typeof terminalResult.receiptId === 'string' && note.receiptId !== terminalResult.receiptId) return false;
        const selector: LifecycleRecoverySelectorRequest = {
          taskRef: normalized.taskRef,
          intent: 'recover-started',
          agent: normalized.agent,
          stage: note.stage,
          round: note.round,
          artifact: note.artifact,
          reason: note.reason
        };
        const facts = readRecoveryTerminalFacts(section, resolved.taskId, selector, run, store);
        return facts.ok && (isReleaseRetryWarning(terminalResult.warning)
          ? facts.facts.stored !== null
          : facts.facts.stored === null);
      });
      if (candidates.length !== 1) return recoveryDomainFailure();
      const note = candidates[0]!;
      request = {
        taskRef: normalized.taskRef,
        intent: 'recover-started',
        agent: normalized.agent,
        stage: note.stage,
        round: note.round,
        artifact: note.artifact,
        reason: note.reason
      };
    } catch {
      return recoveryDomainFailure();
    }
  } else {
    request = normalized;
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot });
  if (!resolved.ok) return recoveryDomainFailure();
  try {
    const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    parseTypedTaskFrontmatter(content);
    const section = locateActivityLog(content);
    if (!section) return recoveryDomainFailure();
    const run = readRun(resolved.taskDir);
    const store = readLifecycleStore(options, repoRoot);
    const facts = readRecoveryTerminalFacts(section, resolved.taskId, request, run, store);
    if (!facts.ok) return recoveryDomainFailure();
    if (!facts.facts.stored) return { consistent: true, recovery: true, targetState: 'active', recoveryState: 'released' };
    if (!isReleaseRetryWarning(terminalResult.warning)) return recoveryDomainFailure();
    return {
      consistent: true,
      recovery: true,
      targetState: 'active',
      recoveryState: 'retry-required',
      warning: terminalResult.warning
    };
  } catch {
    return recoveryDomainFailure();
  }
}

function recoverStartedLifecycleUnderLock(
  requestInput: LifecycleRecoveryRequest,
  options: LifecycleRecoveryOptions = {}
): LifecycleRecoveryResult {
  const normalized = normalizeRequest(requestInput);
  if ('code' in normalized) return failure(requestInput, 'conflict', normalized.code, normalized.message);
  if ('auto' in normalized) {
    const automatic = resolveAutoRecoveryRequest(normalized, options);
    if (automatic.kind === 'failure') {
      return failure(normalized, automatic.status, automatic.code, automatic.message, { taskId: automatic.taskId });
    }
    if (automatic.kind === 'not-needed') {
      return result(normalized, 'no-op', { taskId: automatic.taskId });
    }
    return recoverStartedLifecycleUnderLock(automatic.request, options);
  }
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
    const store = readLifecycleStore(options, resolved.repoRoot);
    const facts = readRecoveryTerminalFacts(section, taskId, request, run, store);
    if (!facts.ok) {
      return failure(request, recoveryTerminalFailureStatus(facts.code), facts.code, facts.message, { taskId });
    }
    const { note, receipt, consumer, stored } = facts.facts;
    if (!stored) {
      const finished = finishRecoveryRun(taskId, request, receipt, note, { ...options, repoRoot: resolved.repoRoot });
      if (!finished.ok) return failure(request, 'conflict', finished.code, finished.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
      return result(request, finished.changed ? 'applied' : 'no-op', { taskId, receiptId: receipt.id, childId: receipt.childId });
    }
    let released = false;
    try { released = (options.releaseRecovery ?? store.releaseRecovery)(note.childId, consumer); }
    catch (error) {
      return releaseResult(request, taskId, receipt, false, false);
    }
    if (!released) return releaseResult(request, taskId, receipt, false, false);
    const finished = finishRecoveryRun(taskId, request, receipt, note, { ...options, repoRoot: resolved.repoRoot });
    if (!finished.ok) return failure(request, 'conflict', finished.code, finished.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
    return result(request, 'applied', { taskId, receiptId: receipt.id, childId: receipt.childId });
  }

  const started = open[0]!;
  if (normalizeAgentToken(started.agent) !== request.agent || started.note !== 'started') {
    return failure(request, 'conflict', 'RECOVERY_SELECTOR_MISMATCH', 'open started lifecycle row does not match the recovery selector', { taskId });
  }
  if (targets.recoveryEntries.length > 0) {
    return failure(request, 'conflict', 'RECOVERY_LOG_CONFLICT', 'open lifecycle execution already has a recovery terminal row', { taskId });
  }
  const pending = run.pendingDelegation;
  const recovered = run.receipts.filter((candidate) => isPostActivationAbortedReceipt(candidate, taskId, request));
  if (pending && recovered.length > 0) {
    return failure(request, 'conflict', 'RECOVERY_RECEIPT_INVALID', 'open lifecycle execution has both a pending and an aborted matching delegation', { taskId });
  }
  const receipt = pending ?? (recovered.length === 1 ? recovered[0]! : null);
  if (!receipt || (pending && (receipt.status !== 'activated' || receipt.client !== 'codex')) || (!pending && receipt.status !== 'aborted')) {
    return failure(request, 'owner-unknown', 'RECOVERY_DELEGATION_UNAVAILABLE', 'open lifecycle execution is not backed by one matching activated Codex delegation', { taskId });
  }
  if (receipt.status === 'activated' && !recoveryRunAllowsActivatedMutation(run)) {
    return failure(
      request,
      'conflict',
      'RECOVERY_ORCHESTRATION_INVALID',
      'activated recovery cannot replace an unrelated orchestration pause',
      { taskId, receiptId: receipt.id, childId: receipt.childId }
    );
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
    try { claimed = store.claimRecovery(receipt.childId!, taskId, receipt.id, receipt.hostEvidence?.hookDefinitionHash); }
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
  const written = (options.writeTask ?? writeTask)({
    taskRef: taskId,
    expectedState: 'active',
    mutations: [{ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body: updatedBody }]
  }, { repoRoot: resolved.repoRoot, metadataProvider: () => metadata });
  if (written.status === 'failed') {
    return failure(request, 'owner-unknown', 'RECOVERY_LOG_WRITE_FAILED', written.error.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  }
  const verified = (options.verifyRecoveryCommit ?? verifyRecoveryCommit)(resolved.taskMdPath, resolved.taskDir, taskId, request, note, options);
  if (!verified.ok) {
    return failure(request, 'owner-unknown', 'RECOVERY_COMMIT_VERIFY_FAILED', verified.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  }
  let released = false;
  try { released = (options.releaseRecovery ?? store.releaseRecovery)(receipt.childId!, consumer); }
  catch { released = false; }
  if (!released) {
    return releaseResult(request, taskId, receipt, false, true);
  }
  const finished = finishRecoveryRun(taskId, request, receipt, note, { ...options, repoRoot: resolved.repoRoot });
  if (!finished.ok) return failure(request, 'conflict', finished.code, finished.message, { taskId, receiptId: receipt.id, childId: receipt.childId });
  return result(request, 'applied', { taskId, receiptId: receipt.id, childId: receipt.childId });
}

function recoverStartedLifecycleFromAdapter(
  request: LifecycleRecoveryRequest,
  options: LifecycleRecoveryOptions = {}
): LifecycleRecoveryResult {
  const first = recoverStartedLifecycleUnderLock(request, options);
  if (
    'auto' in request
    && first.error?.code === 'RECOVERY_COMMIT_VERIFY_FAILED'
  ) {
    const message = `${first.error.code}: ${first.error.message}`;
    const paused = pauseOrchestration(
      request.taskRef,
      ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
      message,
      true,
      { ...options.orchestration, repoRoot: options.repoRoot, now: options.now }
    );
    return {
      ...first,
      changed: first.changed || paused.changed,
      error: {
        code: paused.status === 'paused'
          ? ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE
          : paused.error?.code ?? ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
        message: paused.status === 'paused'
          ? message
          : paused.error?.message ?? message
      }
    };
  }
  if (
    'auto' in request
    && first.warning?.code === RECOVERY_RELEASE_RETRY_WARNING.code
  ) {
    const second = recoverStartedLifecycleUnderLock(request, options);
    if (second.warning?.code !== RECOVERY_RELEASE_RETRY_WARNING.code) return second;
    const message = `${second.warning.code}: ${second.warning.message}`;
    const paused = pauseOrchestration(
      request.taskRef,
      ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
      message,
      true,
      { ...options.orchestration, repoRoot: options.repoRoot, now: options.now }
    );
    return {
      ...second,
      status: 'owner-unknown',
      changed: second.changed || paused.changed,
      error: {
        code: paused.status === 'paused'
          ? ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE
          : paused.error?.code ?? ORCHESTRATION_LIFECYCLE_RECOVERY_INCOMPLETE,
        message: paused.status === 'paused'
          ? message
          : paused.error?.message ?? message
      }
    };
  }
  return first;
}

export {
  RECOVERY_NOTE_PREFIX,
  parseRecoveryNote,
  recoveryFailure,
  recoveryConsumer,
  recoverStartedLifecycleFromAdapter,
  recoverStartedLifecycleUnderLock,
  renderRecoveryNote
};
export type { LifecycleRecoveryOptions, LifecycleRecoveryRequest, LifecycleRecoveryResult, RecoveryNote, RecoveryStage };
