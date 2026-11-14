import fs from 'node:fs';

import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { locateActivityLog, appendActivityEntry, inspectActivityLog } from './activity-log.ts';
import { lifecycleExecutions, prReviewExecution, serializeLifecycleExecution } from './lifecycle-execution.ts';
import {
  assertWritableInventory,
  buildArtifactLinkSection,
  inspectTaskArtifacts
} from './artifact-lifecycle.ts';
import { parseArtifactName } from './artifact-name.ts';
import type { ArtifactIdentity } from './artifact-lifecycle.ts';
import { captureTaskWriteMetadata, writeTask } from './write.ts';
import type { TaskMutation, TaskOperationSummary, TaskWriteOptions } from './write.ts';

type PrReviewVerdict = 'approved' | 'changes-requested' | 'commented';
type PrReviewOutcome = 'aborted' | 'superseded';
type PrReviewArtifactStatus = 'pending' | 'applied' | 'no-op' | 'blocked' | 'failed' | 'aborted' | 'superseded';

export type PrReviewInspectIntent = {
  kind: 'pr-review-inspect';
  taskRef: string;
};

export type PrReviewStartIntent = {
  kind: 'pr-review-start';
  taskRef: string;
  agent: string;
  artifact: string;
  head: string;
  dryRun?: boolean;
};

export type PrReviewCompleteIntent = {
  kind: 'pr-review-complete';
  taskRef: string;
  agent: string;
  artifact: string;
  head: string;
  verdict: PrReviewVerdict;
  blockers: number;
  major: number;
  minor: number;
  dryRun?: boolean;
};

export type PrReviewTerminateIntent = {
  kind: 'pr-review-terminate';
  taskRef: string;
  agent: string;
  artifact: string;
  head: string;
  outcome: PrReviewOutcome;
  reason: string;
  dryRun?: boolean;
};

export type PrReviewActivityIntent = PrReviewStartIntent | PrReviewCompleteIntent | PrReviewTerminateIntent;

type PrReviewIdentity = {
  round: number;
  artifact: string;
  head: string;
  agent: string | null;
  artifactStatus: PrReviewArtifactStatus;
  note: string | null;
};

export type PrReviewActivitySnapshot = {
  nextRound: number;
  prepared: PrReviewIdentity | null;
  open: PrReviewIdentity | null;
  latestTerminal: PrReviewIdentity | null;
  latestSuccessful: PrReviewIdentity | null;
};

export type PrReviewActivityResult = {
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  intent: PrReviewActivityIntent['kind'];
  taskId: string | null;
  artifact: string | null;
  operations: readonly TaskOperationSummary[];
  error: { code: string; message: string } | null;
  warnings?: readonly { code: string; message: string }[];
};

export type PrReviewInspectionResult = {
  status: 'ready' | 'failed';
  changed: false;
  intent: 'pr-review-inspect';
  taskId: string | null;
  snapshot: PrReviewActivitySnapshot | null;
  error: { code: string; message: string } | null;
};

type ActivityIntentOptions = TaskWriteOptions;
type ArtifactRecord = { identity: ArtifactIdentity; head: string; status: PrReviewArtifactStatus };
type RoundState = ArtifactRecord & {
  startedAgent: string | null;
  terminalAgent: string | null;
  terminalNote: string | null;
};
type SnapshotFailure = { ok: false; code: string; message: string; taskId: string | null };
type SnapshotInput = {
  ok: true;
  taskId: string;
  taskDir: string;
  taskMdPath: string;
  repoRoot: string;
  content: string;
  inventory: ReturnType<typeof inspectTaskArtifacts>;
  pr: ReturnType<typeof prReviewExecution>;
};
type ActivityTransition =
  | { kind: 'ready'; step: string; note: string; linkArtifact: boolean }
  | { kind: 'no-op' }
  | { kind: 'failed'; code: string; message: string };

const HEAD_RE = /^[0-9a-f]{40}$/;
const VERDICTS: ReadonlySet<string> = new Set(['approved', 'changes-requested', 'commented']);
const OUTCOMES: ReadonlySet<string> = new Set(['aborted', 'superseded']);
const SUCCESS_STATUSES: ReadonlySet<PrReviewArtifactStatus> = new Set(['applied', 'no-op']);
const LOCAL_COMPLETION_STATUSES: ReadonlySet<PrReviewArtifactStatus> = new Set(['applied', 'no-op', 'blocked', 'failed']);
const ARTIFACT_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'applied', 'no-op', 'blocked', 'failed', 'aborted', 'superseded'
]);

function failed(
  intent: PrReviewActivityIntent,
  code: string,
  message: string,
  taskId: string | null = null
): PrReviewActivityResult {
  return {
    status: 'failed', changed: false, intent: intent.kind, taskId,
    artifact: intent.artifact, operations: [], error: { code, message }
  };
}

function inspectionFailed(code: string, message: string, taskId: string | null = null): PrReviewInspectionResult {
  return {
    status: 'failed', changed: false, intent: 'pr-review-inspect', taskId,
    snapshot: null, error: { code, message }
  };
}

function parseArtifactRecord(identity: ArtifactIdentity): ArtifactRecord | { code: string; message: string } {
  let content: string;
  try {
    content = fs.readFileSync(identity.path, 'utf8');
  } catch (error) {
    return { code: 'ACTIVITY_ARTIFACT_READ_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
  const heads = [...content.matchAll(/^- \*\*(?:被审 head SHA|Reviewed Head SHA)\*\*[:：]\s*([0-9a-f]{40})\s*$/gm)];
  if (heads.length !== 1) {
    return { code: 'ACTIVITY_ARTIFACT_INVALID', message: `${identity.name} must contain exactly one reviewed head SHA` };
  }
  const statuses = [...content.matchAll(/^- \*\*(?:正式 Review 状态|Formal Review Status)\*\*[:：][ \t]*([a-z-]+)[^\r\n]*$/gm)];
  const status = statuses[0]?.[1];
  if (statuses.length !== 1 || !status || !ARTIFACT_STATUSES.has(status)) {
    return { code: 'ACTIVITY_ARTIFACT_INVALID', message: `${identity.name} must contain exactly one supported formal review status` };
  }
  return { identity, head: heads[0]![1]!, status: status as PrReviewArtifactStatus };
}

function toIdentity(state: RoundState, terminal = false): PrReviewIdentity {
  return {
    round: state.identity.round,
    artifact: state.identity.name,
    head: state.head,
    agent: terminal ? state.terminalAgent : state.startedAgent,
    artifactStatus: state.status,
    note: terminal ? state.terminalNote : null
  };
}

function readSnapshotInput(taskRef: string, repoRoot?: string): SnapshotInput | SnapshotFailure {
  const resolved = resolveTaskRef(taskRef, { repoRoot });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, taskId: resolved.taskId };
  if (resolved.state !== 'active') {
    return { ok: false, code: 'TASK_STATE_MISMATCH', message: `task ${resolved.taskId} is ${resolved.state}, expected active`, taskId: resolved.taskId };
  }
  const inventory = inspectTaskArtifacts(taskRef, 'pr-review', { repoRoot: resolved.repoRoot });
  if (inventory.status === 'failed') {
    return { ok: false, code: inventory.error?.code ?? 'ACTIVITY_ARTIFACT_INVALID', message: inventory.error?.message ?? 'artifact inspection failed', taskId: resolved.taskId };
  }
  const topology = assertWritableInventory(inventory);
  if (topology) return { ok: false, code: topology.code, message: topology.message, taskId: resolved.taskId };

  let content: string;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  } catch (error) {
    return { ok: false, code: 'TASK_READ_FAILED', message: error instanceof Error ? error.message : String(error), taskId: resolved.taskId };
  }
  let pr;
  try { pr = prReviewExecution(content); }
  catch (error) { return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: String(error), taskId: resolved.taskId }; }
  return {
    ok: true, taskId: resolved.taskId, taskDir: resolved.taskDir, taskMdPath: resolved.taskMdPath,
    repoRoot: resolved.repoRoot, content, inventory, pr
  };
}

function terminalStatusMatches(note: string, status: PrReviewArtifactStatus): boolean {
  if (note.startsWith('Verdict: ')) return LOCAL_COMPLETION_STATUSES.has(status);
  if (note.startsWith('Outcome: Aborted, ')) return status === 'aborted';
  if (note.startsWith('Outcome: Superseded, ')) return status === 'superseded';
  if (note.startsWith('receipt ')) return SUCCESS_STATUSES.has(status);
  return false;
}

function findRoundExecution(identity: ArtifactIdentity, pr: ReturnType<typeof prReviewExecution>, taskId: string):
  | { ok: true; started: NonNullable<typeof pr.open> | null; terminal: (typeof pr.terminals)[number] | undefined }
  | SnapshotFailure {
  const started = pr.open?.artifact === identity.name ? pr.open : null;
  const terminals = pr.terminals.filter((entry) => entry.artifact === identity.name);
  if (terminals.length > 1) return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: `duplicate PR review terminal for ${identity.name}`, taskId };
  return { ok: true, started, terminal: terminals[0] };
}

function validateRoundExecution(identity: ArtifactIdentity, parsed: ArtifactRecord, started: NonNullable<ReturnType<typeof prReviewExecution>['open']> | null, terminal: ReturnType<typeof prReviewExecution>['terminals'][number] | undefined, taskId: string): SnapshotFailure | null {
  if (terminal && !terminalStatusMatches(terminal.note, parsed.status)) {
    return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: `terminal note conflicts with artifact status ${parsed.status}`, taskId };
  }
  if ((started && started.head !== parsed.head) || (terminal && terminal.head !== parsed.head)) {
    return { ok: false, code: 'ACTIVITY_IDENTITY_MISMATCH', message: `head does not match ${identity.name}`, taskId };
  }
  return null;
}

function readRoundState(identity: ArtifactIdentity, pr: ReturnType<typeof prReviewExecution>, taskId: string): RoundState | SnapshotFailure {
  const parsed = parseArtifactRecord(identity);
  if ('code' in parsed) return { ok: false, ...parsed, taskId };
  const execution = findRoundExecution(identity, pr, taskId);
  if (!execution.ok) return execution;
  const invalid = validateRoundExecution(identity, parsed, execution.started, execution.terminal, taskId);
  if (invalid) return invalid;
  return { ...parsed, startedAgent: execution.started?.agent ?? null, terminalAgent: execution.terminal?.agent ?? null, terminalNote: execution.terminal?.note ?? null };
}

function hasExecutionArtifact(pr: ReturnType<typeof prReviewExecution>, states: readonly RoundState[]): boolean {
  if (pr.open && !states.some((state) => state.identity.name === pr.open!.artifact)) return false;
  return pr.terminals.every((entry) => states.some((state) => state.identity.name === entry.artifact));
}

function buildActivitySnapshot(states: readonly RoundState[], nextRound: number | undefined, taskId: string): PrReviewActivitySnapshot | SnapshotFailure {
  const openStates = states.filter((state) => state.startedAgent !== null && state.terminalNote === null);
  const preparedStates = states.filter((state) => state.status === 'pending' && state.startedAgent === null && state.terminalNote === null);
  if (openStates.length > 1 || preparedStates.length > 1) {
    return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: 'multiple prepared or open PR review rounds exist', taskId };
  }
  const terminalStates = states.filter((state) => state.terminalNote !== null);
  const successfulStates = states.filter((state) => SUCCESS_STATUSES.has(state.status));
  const latestTerminal = terminalStates.at(-1) ?? null;
  const latestSuccessful = successfulStates.at(-1) ?? null;
  return {
    nextRound: nextRound ?? 1,
    prepared: preparedStates[0] ? toIdentity(preparedStates[0]) : null,
    open: openStates[0] ? toIdentity(openStates[0]) : null,
    latestTerminal: latestTerminal ? toIdentity(latestTerminal, true) : null,
    latestSuccessful: latestSuccessful ? toIdentity(latestSuccessful, true) : null
  };
}

function readSnapshot(taskRef: string, repoRoot?: string):
  | { ok: true; taskId: string; taskDir: string; taskMdPath: string; repoRoot: string; content: string; states: RoundState[]; snapshot: PrReviewActivitySnapshot }
  | SnapshotFailure {
  const input = readSnapshotInput(taskRef, repoRoot);
  if (!input.ok) return input;
  const states: RoundState[] = [];
  for (const identity of input.inventory.artifacts) {
    const state = readRoundState(identity, input.pr, input.taskId);
    if ('ok' in state) return state;
    states.push(state);
  }
  if (!hasExecutionArtifact(input.pr, states)) {
    return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: 'PR review execution references a missing artifact', taskId: input.taskId };
  }
  const snapshot = buildActivitySnapshot(states, input.inventory.next?.round, input.taskId);
  if ('ok' in snapshot) return snapshot;
  return { ...input, states, snapshot };
}

export function inspectPrReviewActivity(intent: PrReviewInspectIntent, options: Pick<ActivityIntentOptions, 'repoRoot'> = {}): PrReviewInspectionResult {
  const state = readSnapshot(intent.taskRef, options.repoRoot);
  if (!state.ok) return inspectionFailed(state.code, state.message, state.taskId);
  return { status: 'ready', changed: false, intent: intent.kind, taskId: state.taskId, snapshot: state.snapshot, error: null };
}

function validateIntent(intent: PrReviewActivityIntent): { agent: string; artifact: { round: number; name: string } } | { code: string; message: string } {
  const agent = normalizeAgentToken(intent.agent);
  if (!agent) return { code: 'ACTIVITY_INTENT_INVALID', message: 'agent must be a supported collaborator token' };
  const artifact = parseArtifactName(intent.artifact);
  if (!artifact || artifact.family !== 'pr-review') {
    return { code: 'ACTIVITY_ARTIFACT_INVALID', message: `artifact '${intent.artifact}' is not a canonical pr-review artifact` };
  }
  if (!HEAD_RE.test(intent.head)) return { code: 'ACTIVITY_INTENT_INVALID', message: 'head must be a lowercase 40-character SHA' };
  if (intent.kind === 'pr-review-complete') {
    if (!VERDICTS.has(intent.verdict)) return { code: 'ACTIVITY_INTENT_INVALID', message: 'verdict is invalid' };
    if (![intent.blockers, intent.major, intent.minor].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return { code: 'ACTIVITY_INTENT_INVALID', message: 'finding counts must be non-negative safe integers' };
    }
  }
  if (intent.kind === 'pr-review-terminate') {
    if (!OUTCOMES.has(intent.outcome)) return { code: 'ACTIVITY_INTENT_INVALID', message: 'outcome is invalid' };
    if (!intent.reason.trim() || /[\r\n]/.test(intent.reason) || intent.reason !== intent.reason.trim()) {
      return { code: 'ACTIVITY_INTENT_INVALID', message: 'reason must be a non-empty trimmed single-line value' };
    }
  }
  return { agent, artifact };
}

function verdictLabel(verdict: PrReviewVerdict): string {
  if (verdict === 'approved') return 'Approved';
  if (verdict === 'changes-requested') return 'Changes Requested';
  return 'Commented';
}

function outcomeLabel(outcome: PrReviewOutcome): string {
  return outcome === 'aborted' ? 'Aborted' : 'Superseded';
}

function terminalNote(intent: PrReviewCompleteIntent | PrReviewTerminateIntent): string {
  if (intent.kind === 'pr-review-complete') {
    return `Verdict: ${verdictLabel(intent.verdict)}, blockers: ${intent.blockers}, major: ${intent.major}, minor: ${intent.minor} → ${intent.artifact}`;
  }
  return `Outcome: ${outcomeLabel(intent.outcome)}, reason: ${intent.reason} → ${intent.artifact}`;
}

function decideStartTransition(roundState: RoundState, snapshot: PrReviewActivitySnapshot, base: string, artifact: string): ActivityTransition {
  if (roundState.terminalNote !== null) return { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `${base} is already terminal` };
  if (roundState.startedAgent !== null) return { kind: 'no-op' };
  if (roundState.status !== 'pending') return { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `${artifact} must be pending before start` };
  if (snapshot.open && snapshot.open.artifact !== artifact) {
    return { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `another PR review round is open: ${snapshot.open.artifact}` };
  }
  return { kind: 'ready', step: `${base} [started]`, note: 'started', linkArtifact: false };
}

function decideTerminalTransition(intent: PrReviewCompleteIntent | PrReviewTerminateIntent, roundState: RoundState, base: string): ActivityTransition {
  const note = terminalNote(intent);
  if (roundState.terminalNote !== null) {
    return roundState.terminalNote === note
      ? { kind: 'no-op' }
      : { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `${base} has a different terminal payload` };
  }
  if (roundState.startedAgent === null) return { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `${base} has no matching started row` };
  if (intent.kind === 'pr-review-complete' && !LOCAL_COMPLETION_STATUSES.has(roundState.status)) {
    return { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `${intent.artifact} must record a publication outcome before completion` };
  }
  if (intent.kind === 'pr-review-terminate' && roundState.status !== intent.outcome) {
    return { kind: 'failed', code: 'ACTIVITY_STATE_CONFLICT', message: `${intent.artifact} status must match outcome ${intent.outcome}` };
  }
  return { kind: 'ready', step: base, note, linkArtifact: true };
}

function applyActivityIntent(intent: PrReviewActivityIntent, normalizedAgent: string, options: ActivityIntentOptions): PrReviewActivityResult {
  const state = readSnapshot(intent.taskRef, options.repoRoot);
  if (!state.ok) return failed(intent, state.code, state.message, state.taskId);
  const parsed = parseArtifactName(intent.artifact)!;
  const roundState = state.states.find((item) => item.identity.name === parsed.name);
  if (!roundState) return failed(intent, 'ACTIVITY_ARTIFACT_INVALID', `artifact '${intent.artifact}' is not landed`, state.taskId);
  if (roundState.head !== intent.head) {
    return failed(intent, 'ACTIVITY_IDENTITY_MISMATCH', `head does not match ${intent.artifact}`, state.taskId);
  }
  const base = `Review PR (Round ${parsed.round})`;
  const transition = intent.kind === 'pr-review-start'
    ? decideStartTransition(roundState, state.snapshot, base, intent.artifact)
    : decideTerminalTransition(intent, roundState, base);
  if (transition.kind === 'failed') return failed(intent, transition.code, transition.message, state.taskId);
  if (transition.kind === 'no-op') {
    return { status: 'no-op', changed: false, intent: intent.kind, taskId: state.taskId, artifact: intent.artifact, operations: [], error: null };
  }

  let metadata;
  try {
    metadata = (options.metadataProvider ?? captureTaskWriteMetadata)();
  } catch (error) {
    return failed(intent, 'METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), state.taskId);
  }
  const section = locateActivityLog(state.content);
  const pr = prReviewExecution(state.content);
  if (!transition.linkArtifact) pr.open = { artifact: intent.artifact, head: intent.head, agent: normalizedAgent, startedAt: metadata.timestamp };
  else {
    pr.open = null;
    pr.terminals.push({ artifact: intent.artifact, head: intent.head, agent: normalizedAgent, note: transition.note });
  }
  const mutations: TaskMutation[] = [{ kind: 'frontmatter', lifecycleExecutionDomain: 'pr-review', set: { lifecycle_execution: serializeLifecycleExecution(lifecycleExecutions(state.content), state.content, pr) } }];
  if (section) mutations.push({ kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading, body: appendActivityEntry(section, { time: metadata.timestamp, step: transition.step, agent: normalizedAgent, note: transition.note }) });
  if (transition.linkArtifact) {
    const link = buildArtifactLinkSection(state.content, roundState.identity);
    mutations.push({ kind: 'section', aliases: link.aliases, heading: link.heading, body: link.body });
  }
  const writeResult = writeTask({
    taskRef: intent.taskRef,
    expectedState: 'active',
    mutations,
    dryRun: intent.dryRun
  }, {
    ...options,
    taskLocation: {
      repoRoot: state.repoRoot,
      taskId: state.taskId,
      taskMdPath: state.taskMdPath,
      state: 'active'
    },
    metadataProvider: () => metadata
  });
  if (writeResult.status === 'failed') {
    return failed(intent, writeResult.error.code, writeResult.error.message, writeResult.taskId);
  }
  return {
    status: writeResult.status,
    changed: writeResult.changed,
    intent: intent.kind,
    taskId: writeResult.taskId,
    artifact: intent.artifact,
    operations: writeResult.operations,
    error: null
  };
}

export function applyPrReviewActivityIntent(intent: PrReviewActivityIntent, options: ActivityIntentOptions = {}): PrReviewActivityResult {
  const validated = validateIntent(intent);
  if ('code' in validated) return failed(intent, validated.code, validated.message);
  const resolved = resolveTaskRef(intent.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failed(intent, resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') {
    return failed(intent, 'TASK_STATE_MISMATCH', `task ${resolved.taskId} is ${resolved.state}, expected active`, resolved.taskId);
  }
  let warnings: { code: string; message: string }[] = [];
  try {
    const inspected = inspectActivityLog(fs.readFileSync(resolved.taskMdPath, 'utf8'));
    warnings = !inspected.section ? [{ code: 'ACTIVITY_LOG_UNAVAILABLE', message: 'Activity Log is missing or ambiguous' }] : inspected.invalidEntries.length ? [{ code: 'ACTIVITY_LOG_INVALID_ENTRIES', message: 'Activity Log contains malformed entries' }] : [];
  } catch { /* The operation reports read errors. */ }
  const result = applyActivityIntent(intent, validated.agent, { ...options, repoRoot: resolved.repoRoot });
  if (result.status === 'failed') return result;
  return warnings.length ? { ...result, warnings } : result;
}

export type { ActivityIntentOptions };
