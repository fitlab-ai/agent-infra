type CodexEvidenceSource =
  | 'codex-hook'
  | 'codex-app-server-thread'
  | 'codex-app-server-settings'
  | 'codex-app-server-turn'
  | 'codex-app-server-reroute';

type CodexLifecycleEvent =
  | Readonly<{
      type: 'hook-spawn';
      sessionId: string;
      turnId: string;
      toolUseId: string;
      nativeAgent: string;
      requestedModel?: string;
      requestedReasoningEffort?: string;
      hookDefinitionHash: string;
    }>
  | Readonly<{
      type: 'hook-child';
      sessionId: string;
      turnId: string;
      childThreadId: string;
      parentThreadId: string;
      nativeAgent: string;
    }>
  | Readonly<{
      type: 'app-thread';
      childThreadId: string;
      parentThreadId: string;
      forkedFromId: string | null;
      sourceParentThreadId: string;
      nativeAgent: string;
    }>
  | Readonly<{
      type: 'app-settings';
      childThreadId: string;
      model: string;
      reasoningEffort: string;
    }>
  | Readonly<{
      type: 'app-reroute';
      childThreadId: string;
      turnId: string;
      fromModel: string;
      toModel: string;
      reason: string;
    }>
  | Readonly<{
      type: 'app-terminal';
      childThreadId: string;
      turnId: string;
      status: 'completed' | 'interrupted' | 'failed';
    }>
  | Readonly<{
      type: 'hook-stop';
      sessionId: string;
      turnId: string;
      childThreadId: string;
      nativeAgent: string;
    }>;

type CodexStartEvidence = Readonly<{
  schemaVersion: 1;
  cliVersion: string;
  parentThreadId: string;
  parentTurnId: string;
  spawnToolUseId: string;
  childThreadId: string;
  nativeAgent: string;
  spawnMode: 'fresh';
  actualModel: Readonly<{ value: string; source: CodexEvidenceSource }>;
  actualReasoningEffort: Readonly<{ value: string; source: CodexEvidenceSource }>;
  modelFallbackReason: string | null;
  reasoningEffortFallbackReason: string | null;
  hookDefinitionHash: string;
}>;

type CodexStopEvidence = Readonly<{
  schemaVersion: 1;
  childThreadId: string;
  turnId: string;
  terminalStatus: 'completed';
  hookStopObserved: true;
}>;

type CodexLifecycleStatus =
  | 'empty'
  | 'observed-spawn'
  | 'observed-child'
  | 'start-ready'
  | 'observed-terminal'
  | 'stop-ready'
  | 'invalid'
  | 'expired';

type CodexEvidenceError = Readonly<{ code: string; message: string }>;

type CodexLifecycleState = Readonly<{
  schemaVersion: 1;
  cliVersion: string;
  status: CodexLifecycleStatus;
  spawn: Extract<CodexLifecycleEvent, { type: 'hook-spawn' }> | null;
  child: Extract<CodexLifecycleEvent, { type: 'hook-child' }> | null;
  thread: Extract<CodexLifecycleEvent, { type: 'app-thread' }> | null;
  settings: Extract<CodexLifecycleEvent, { type: 'app-settings' }> | null;
  reroute: Extract<CodexLifecycleEvent, { type: 'app-reroute' }> | null;
  terminal: Extract<CodexLifecycleEvent, { type: 'app-terminal' }> | null;
  stop: Extract<CodexLifecycleEvent, { type: 'hook-stop' }> | null;
  startEvidence: CodexStartEvidence | null;
  stopEvidence: CodexStopEvidence | null;
  error: CodexEvidenceError | null;
}>;

function createCodexLifecycleState(cliVersion: string): CodexLifecycleState {
  if (!cliVersion.trim()) throw new Error('Codex CLI version is required');
  return Object.freeze({
    schemaVersion: 1,
    cliVersion,
    status: 'empty',
    spawn: null,
    child: null,
    thread: null,
    settings: null,
    reroute: null,
    terminal: null,
    stop: null,
    startEvidence: null,
    stopEvidence: null,
    error: null
  });
}

function invalid(state: CodexLifecycleState, code: string, message: string): CodexLifecycleState {
  return Object.freeze({
    ...state,
    status: 'invalid',
    startEvidence: null,
    stopEvidence: null,
    error: Object.freeze({ code, message })
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredStrings(event: CodexLifecycleEvent): boolean {
  return Object.entries(event).every(([key, value]) =>
    key === 'forkedFromId'
    || (typeof value !== 'string' || value.trim() !== '')
  );
}

function derive(state: CodexLifecycleState): CodexLifecycleState {
  const { spawn, child, thread, settings, reroute, terminal, stop } = state;
  if (spawn && child && (
    spawn.sessionId !== child.parentThreadId
    || spawn.nativeAgent !== child.nativeAgent
  )) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'hook spawn and child identity do not match');
  }
  if (child && child.sessionId !== child.childThreadId) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'hook child session does not match the child thread');
  }
  if (child && thread && child.childThreadId !== thread.childThreadId) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'hook and App Server child identity do not match');
  }
  if (child && thread && child.nativeAgent !== thread.nativeAgent) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'hook and App Server agent roles do not match');
  }
  if (child && thread && child.parentThreadId !== thread.parentThreadId) {
    return invalid(state, 'CODEX_EVIDENCE_PARENT_MISMATCH', 'hook and App Server parent identity do not match');
  }
  if (spawn && thread && (
    thread.parentThreadId !== spawn.sessionId
    || thread.sourceParentThreadId !== spawn.sessionId
  )) {
    return invalid(state, 'CODEX_EVIDENCE_PARENT_MISMATCH', 'App Server parent identity does not match the spawning session');
  }
  if (spawn && thread && spawn.nativeAgent !== thread.nativeAgent) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'spawn and App Server agent roles do not match');
  }
  if (thread?.forkedFromId !== null && thread?.forkedFromId !== undefined) {
    return invalid(state, 'CODEX_EVIDENCE_FORK_FORBIDDEN', 'forked child threads are not fresh lifecycle evidence');
  }
  if (settings && child && settings.childThreadId !== child.childThreadId) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'resolved settings belong to a different child');
  }
  if (reroute && child && reroute.childThreadId !== child.childThreadId) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'model reroute belongs to a different child');
  }
  if (spawn?.requestedModel && settings && spawn.requestedModel !== settings.model) {
    if (
      !reroute
      || reroute.fromModel !== spawn.requestedModel
      || reroute.toModel !== settings.model
      || !reroute.reason.trim()
    ) {
      return invalid(state, 'CODEX_EVIDENCE_MODEL_UNEXPLAINED', 'resolved model differs without a matching host reroute');
    }
  }
  if (
    spawn?.requestedReasoningEffort
    && settings
    && spawn.requestedReasoningEffort !== settings.reasoningEffort
  ) {
    return invalid(state, 'CODEX_EVIDENCE_EFFORT_UNEXPLAINED', 'resolved reasoning effort differs without structured host evidence');
  }
  if (terminal && terminal.status !== 'completed') {
    return invalid(state, 'CODEX_EVIDENCE_TERMINAL_INVALID', `child turn ended as '${terminal.status}'`);
  }
  if (terminal && child && terminal.childThreadId !== child.childThreadId) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'terminal event belongs to a different child');
  }
  if (stop && child && (
    stop.sessionId !== child.sessionId
    || stop.turnId !== child.turnId
    || stop.childThreadId !== child.childThreadId
    || stop.nativeAgent !== child.nativeAgent
  )) {
    return invalid(state, 'CODEX_EVIDENCE_IDENTITY_MISMATCH', 'hook stop identity does not match the child');
  }

  let startEvidence: CodexStartEvidence | null = null;
  if (spawn && child && thread && settings) {
    startEvidence = Object.freeze({
      schemaVersion: 1,
      cliVersion: state.cliVersion,
      parentThreadId: spawn.sessionId,
      parentTurnId: spawn.turnId,
      spawnToolUseId: spawn.toolUseId,
      childThreadId: child.childThreadId,
      nativeAgent: child.nativeAgent,
      spawnMode: 'fresh',
      actualModel: Object.freeze({ value: settings.model, source: 'codex-app-server-settings' }),
      actualReasoningEffort: Object.freeze({ value: settings.reasoningEffort, source: 'codex-app-server-settings' }),
      modelFallbackReason: reroute?.reason ?? null,
      reasoningEffortFallbackReason: null,
      hookDefinitionHash: spawn.hookDefinitionHash
    });
  }
  let stopEvidence: CodexStopEvidence | null = null;
  if (startEvidence && terminal?.status === 'completed' && stop) {
    stopEvidence = Object.freeze({
      schemaVersion: 1,
      childThreadId: startEvidence.childThreadId,
      turnId: terminal.turnId,
      terminalStatus: 'completed',
      hookStopObserved: true
    });
  }
  const status: CodexLifecycleStatus = stopEvidence
    ? 'stop-ready'
    : terminal
      ? 'observed-terminal'
      : startEvidence
        ? 'start-ready'
        : child
          ? 'observed-child'
          : spawn
            ? 'observed-spawn'
            : 'empty';
  return Object.freeze({ ...state, status, startEvidence, stopEvidence, error: null });
}

function reduceCodexLifecycleEvent(
  state: CodexLifecycleState,
  event: CodexLifecycleEvent
): CodexLifecycleState {
  if (state.status === 'invalid' || state.status === 'expired') return state;
  if (!requiredStrings(event)) {
    return invalid(state, 'CODEX_EVIDENCE_FIELD_MISSING', 'lifecycle event contains an empty required field');
  }
  const key = ({
    'hook-spawn': 'spawn',
    'hook-child': 'child',
    'app-thread': 'thread',
    'app-settings': 'settings',
    'app-reroute': 'reroute',
    'app-terminal': 'terminal',
    'hook-stop': 'stop'
  } as const)[event.type];
  const existing = state[key];
  if (existing) {
    if (same(existing, event)) return state;
    return invalid(state, 'CODEX_EVIDENCE_REPLAY_CONFLICT', `conflicting '${event.type}' event`);
  }
  return derive(Object.freeze({ ...state, [key]: Object.freeze({ ...event }) }));
}

function expireCodexLifecycleState(state: CodexLifecycleState): CodexLifecycleState {
  if (!['observed-spawn', 'observed-child', 'start-ready', 'observed-terminal'].includes(state.status)) {
    return state;
  }
  return Object.freeze({
    ...state,
    status: 'expired',
    startEvidence: null,
    stopEvidence: null,
    error: Object.freeze({
      code: 'CODEX_EVIDENCE_EXPIRED',
      message: 'Codex lifecycle evidence expired before completion'
    })
  });
}

export {
  createCodexLifecycleState,
  expireCodexLifecycleState,
  reduceCodexLifecycleEvent
};
export type {
  CodexEvidenceError,
  CodexEvidenceSource,
  CodexLifecycleEvent,
  CodexLifecycleState,
  CodexLifecycleStatus,
  CodexStartEvidence,
  CodexStopEvidence
};
