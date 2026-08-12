import fs from 'node:fs';

import { normalizeAgentToken } from '../agent-clients/tokens.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { locateActivityLog, appendActivityEntry } from './activity-log.ts';
import {
  assertWritableInventory,
  buildArtifactLinkSection,
  inspectTaskArtifacts,
  parseArtifactName
} from './artifact-lifecycle.ts';
import type { ArtifactIdentity } from './artifact-lifecycle.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import type { TaskExecutionLockOptions } from './task-execution-lock.ts';
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
};

export type PrReviewInspectionResult = {
  status: 'ready' | 'failed';
  changed: false;
  intent: 'pr-review-inspect';
  taskId: string | null;
  snapshot: PrReviewActivitySnapshot | null;
  error: { code: string; message: string } | null;
};

type ActivityIntentOptions = TaskWriteOptions & { lockOptions?: TaskExecutionLockOptions };
type ArtifactRecord = { identity: ArtifactIdentity; head: string; status: PrReviewArtifactStatus };
type RoundState = ArtifactRecord & {
  startedAgent: string | null;
  terminalAgent: string | null;
  terminalNote: string | null;
};

const HEAD_RE = /^[0-9a-f]{40}$/;
const REVIEW_ACTION_RE = /^Review PR \(Round ([1-9]\d*)\)( \[started\])?$/;
const VERDICTS: ReadonlySet<string> = new Set(['approved', 'changes-requested', 'commented']);
const OUTCOMES: ReadonlySet<string> = new Set(['aborted', 'superseded']);
const SUCCESS_STATUSES: ReadonlySet<PrReviewArtifactStatus> = new Set(['applied', 'no-op']);
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

function readSnapshot(taskRef: string, repoRoot?: string):
  | { ok: true; taskId: string; taskDir: string; taskMdPath: string; repoRoot: string; content: string; states: RoundState[]; snapshot: PrReviewActivitySnapshot }
  | { ok: false; code: string; message: string; taskId: string | null } {
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
  const activity = locateActivityLog(content);
  if (!activity) return { ok: false, code: 'ACTIVITY_SECTION_MISSING', message: 'task has no unique Activity Log section', taskId: resolved.taskId };

  const knownRounds = new Set(inventory.artifacts.map((artifact) => artifact.round));
  for (const entry of activity.entries) {
    const match = REVIEW_ACTION_RE.exec(entry.step);
    if (match && !knownRounds.has(Number(match[1]))) {
      return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: `Activity Log round ${match[1]} has no canonical pr-review artifact`, taskId: resolved.taskId };
    }
  }

  const states: RoundState[] = [];
  for (const identity of inventory.artifacts) {
    const parsed = parseArtifactRecord(identity);
    if ('code' in parsed) return { ok: false, ...parsed, taskId: resolved.taskId };
    const base = `Review PR (Round ${identity.round})`;
    const started = activity.entries.filter((entry) => entry.step === `${base} [started]`);
    const terminal = activity.entries.filter((entry) => entry.step === base);
    if (started.length > 1 || terminal.length > 1) {
      return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: `${base} has duplicate started or terminal rows`, taskId: resolved.taskId };
    }
    if (terminal.length === 1 && started.length === 0 && !terminal[0]!.note.startsWith('receipt ')) {
      return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: `${base} has a terminal row without a matching started row`, taskId: resolved.taskId };
    }
    if (terminal.length === 1) {
      const note = terminal[0]!.note;
      const terminalMatchesStatus =
        (note.startsWith('Verdict: ') && SUCCESS_STATUSES.has(parsed.status))
        || (note.startsWith('Outcome: Aborted, ') && parsed.status === 'aborted')
        || (note.startsWith('Outcome: Superseded, ') && parsed.status === 'superseded')
        || (note.startsWith('receipt ') && SUCCESS_STATUSES.has(parsed.status));
      if (!terminalMatchesStatus) {
        return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: `${base} terminal note conflicts with artifact status ${parsed.status}`, taskId: resolved.taskId };
      }
    }
    states.push({
      ...parsed,
      startedAgent: started[0]?.agent ?? null,
      terminalAgent: terminal[0]?.agent ?? null,
      terminalNote: terminal[0]?.note ?? null
    });
  }

  const openStates = states.filter((state) => state.startedAgent !== null && state.terminalNote === null);
  const preparedStates = states.filter((state) => state.status === 'pending' && state.startedAgent === null && state.terminalNote === null);
  if (openStates.length > 1 || preparedStates.length > 1) {
    return { ok: false, code: 'ACTIVITY_STATE_CONFLICT', message: 'multiple prepared or open PR review rounds exist', taskId: resolved.taskId };
  }
  const terminalStates = states.filter((state) => state.terminalNote !== null);
  const successfulStates = states.filter((state) => SUCCESS_STATUSES.has(state.status));
  const latestTerminal = terminalStates.at(-1) ?? null;
  const latestSuccessful = successfulStates.at(-1) ?? null;
  return {
    ok: true,
    taskId: resolved.taskId,
    taskDir: resolved.taskDir,
    taskMdPath: resolved.taskMdPath,
    repoRoot: resolved.repoRoot,
    content,
    states,
    snapshot: {
      nextRound: inventory.next?.round ?? 1,
      prepared: preparedStates[0] ? toIdentity(preparedStates[0]) : null,
      open: openStates[0] ? toIdentity(openStates[0]) : null,
      latestTerminal: latestTerminal ? toIdentity(latestTerminal, true) : null,
      latestSuccessful: latestSuccessful ? toIdentity(latestSuccessful, true) : null
    }
  };
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

function applyLocked(intent: PrReviewActivityIntent, normalizedAgent: string, options: ActivityIntentOptions): PrReviewActivityResult {
  const state = readSnapshot(intent.taskRef, options.repoRoot);
  if (!state.ok) return failed(intent, state.code, state.message, state.taskId);
  const parsed = parseArtifactName(intent.artifact)!;
  const roundState = state.states.find((item) => item.identity.name === parsed.name);
  if (!roundState) return failed(intent, 'ACTIVITY_ARTIFACT_INVALID', `artifact '${intent.artifact}' is not landed`, state.taskId);
  if (roundState.head !== intent.head) {
    return failed(intent, 'ACTIVITY_IDENTITY_MISMATCH', `head does not match ${intent.artifact}`, state.taskId);
  }
  const base = `Review PR (Round ${parsed.round})`;
  let step: string;
  let note: string;
  let linkArtifact = false;

  if (intent.kind === 'pr-review-start') {
    if (roundState.terminalNote !== null) {
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `${base} is already terminal`, state.taskId);
    }
    if (roundState.startedAgent !== null) {
      return { status: 'no-op', changed: false, intent: intent.kind, taskId: state.taskId, artifact: intent.artifact, operations: [], error: null };
    }
    if (roundState.status !== 'pending') {
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `${intent.artifact} must be pending before start`, state.taskId);
    }
    if (state.snapshot.open && state.snapshot.open.artifact !== intent.artifact) {
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `another PR review round is open: ${state.snapshot.open.artifact}`, state.taskId);
    }
    step = `${base} [started]`;
    note = 'started';
  } else {
    note = terminalNote(intent);
    if (roundState.terminalNote !== null) {
      if (roundState.terminalNote === note) {
        return { status: 'no-op', changed: false, intent: intent.kind, taskId: state.taskId, artifact: intent.artifact, operations: [], error: null };
      }
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `${base} has a different terminal payload`, state.taskId);
    }
    if (roundState.startedAgent === null) {
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `${base} has no matching started row`, state.taskId);
    }
    if (intent.kind === 'pr-review-complete' && !SUCCESS_STATUSES.has(roundState.status)) {
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `${intent.artifact} must be applied or no-op before completion`, state.taskId);
    }
    if (intent.kind === 'pr-review-terminate' && roundState.status !== intent.outcome) {
      return failed(intent, 'ACTIVITY_STATE_CONFLICT', `${intent.artifact} status must match outcome ${intent.outcome}`, state.taskId);
    }
    step = base;
    linkArtifact = true;
  }

  let metadata;
  try {
    metadata = (options.metadataProvider ?? captureTaskWriteMetadata)();
  } catch (error) {
    return failed(intent, 'METADATA_CAPTURE_FAILED', error instanceof Error ? error.message : String(error), state.taskId);
  }
  const section = locateActivityLog(state.content)!;
  const mutations: TaskMutation[] = [{
    kind: 'section', aliases: ['活动日志', 'Activity Log'], heading: section.heading,
    body: appendActivityEntry(section, { time: metadata.timestamp, step, agent: normalizedAgent, note })
  }];
  if (linkArtifact) {
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
  try {
    return withTaskExecutionLock(
      resolved.repoRoot,
      resolved.taskId,
      `task-activity:${intent.kind}`,
      () => applyLocked(intent, validated.agent, { ...options, repoRoot: resolved.repoRoot }),
      options.lockOptions
    );
  } catch (error) {
    if (error instanceof TaskExecutionLockError) return failed(intent, error.code, error.message, resolved.taskId);
    return failed(intent, 'ACTIVITY_LOCK_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId);
  }
}

export type { ActivityIntentOptions };
