import {
  preflightCodexLifecycleEvidence,
  resolveCodexSpawnedChild,
  resolveCodexTerminal,
  resolveCodexThread
} from '../agent-clients/adapters/codex-lifecycle/app-server.ts';
import { createCodexLifecycleStore } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import {
  computeLifecycleBuildIdentity,
  type LifecycleBuildIdentity,
} from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import {
  activateMatchingOrchestrationDelegation,
  hasActivatableOrchestrationDelegation,
  hasSealableOrchestrationDelegation,
  OrchestrationStateError,
  pauseMatchingOrchestrationDelegation,
  prepareOrchestrationDelegation,
  reconcileMatchingOrchestrationDelegation,
  readRun,
  sealMatchingOrchestrationDelegationWithHostEvidence
} from './orchestration.ts';
import type { OrchestrationOptions, OrchestrationResult } from './orchestration.ts';
import { managedDelegationRole } from './delegation-receipts.ts';
import {
  encodeCodexLifecycleBinding,
  resolveCodexLifecycleStoreRoot,
  parseCodexLifecycleBinding,
  verifyCodexLifecycleTaskBinding,
  type CodexLifecycleTaskBinding
} from '../agent-clients/adapters/codex-lifecycle/binding.ts';
import { reduceCodexLifecycleEvent } from '../agent-clients/adapters/codex-lifecycle/evidence.ts';
import type { CodexLifecycleEvent } from '../agent-clients/adapters/codex-lifecycle/evidence.ts';

type LifecycleStore = ReturnType<typeof createCodexLifecycleStore>;
type TaskRunWithPendingDelegation = NonNullable<ReturnType<typeof readRun>> & Readonly<{
  pendingDelegation: NonNullable<NonNullable<ReturnType<typeof readRun>>['pendingDelegation']>;
}>;
type CodexBridgeOptions = Readonly<{
  repoRoot?: string;
  store?: LifecycleStore;
  preflight?: typeof preflightCodexLifecycleEvidence;
  resolveThread?: typeof resolveCodexThread;
  resolveTerminal?: typeof resolveCodexTerminal;
  buildIdentity?: LifecycleBuildIdentity;
  orchestrationOptions?: OrchestrationOptions;
}>;

type CodexSpawnIdentity = Readonly<{
  sessionId: string;
  turnId: string;
  toolUseId: string;
  transcriptPath: string;
  nativeAgent: string;
  taskName: string;
  requestedModel?: string;
  requestedReasoningEffort?: string;
}>;

function coreOptions(options: CodexBridgeOptions): OrchestrationOptions {
  return {
    ...options.orchestrationOptions,
    repoRoot: options.repoRoot ?? options.orchestrationOptions?.repoRoot,
    taskId: options.orchestrationOptions?.taskId ?? options.store?.taskId ?? undefined
  };
}

function taskRunMatchesReceipt(
  run: ReturnType<typeof readRun>,
  binding: CodexLifecycleTaskBinding,
  nativeAgent: string
): run is TaskRunWithPendingDelegation {
  const receipt = run?.pendingDelegation;
  const role = nativeAgent.endsWith('reviewer') ? 'reviewer' : 'executor';
  return run?.status === 'running'
    && receipt?.runId === binding.runId
    && receipt.id === binding.receiptId
    && receipt.client === 'codex'
    && receipt.role === role;
}

function recordMatchesTaskReceipt(childThreadId: string, options: CodexBridgeOptions) {
  const store = requiredStore(options);
  let record: ReturnType<LifecycleStore['read']>;
  try {
    record = store.read(childThreadId);
  } catch (error) {
    throw new Error(`CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: ${error instanceof Error ? error.message : String(error)}`);
  }
  const binding = record.taskBinding;
  if (!binding) throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: lifecycle record has no receipt binding');
  const repoRoot = options.repoRoot ?? options.orchestrationOptions?.repoRoot ?? process.cwd();
  const resolved = resolveTaskRef(binding.taskId, { repoRoot });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  const run = readRun(resolved.taskDir);
  const nativeAgent = record.state.startEvidence?.nativeAgent ?? record.state.spawn?.nativeAgent ?? '';
  if (!taskRunMatchesReceipt(run, binding, nativeAgent)) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: lifecycle record does not match the current pending task receipt');
  }
  const receipt = run.pendingDelegation;
  return { store, record, binding, resolved, run, receipt };
}

function sameTaskReceipt(
  left: Readonly<{ taskId: string; runId: string; id: string }>,
  right: Readonly<{ taskId: string; runId: string; id: string }>
): boolean {
  return left.runId === right.runId && left.id === right.id;
}

function sameLifecycleRevision(
  left: Readonly<{ revision: number; taskBinding: CodexLifecycleTaskBinding | null }>,
  right: Readonly<{ revision: number; taskBinding: CodexLifecycleTaskBinding | null }>
): boolean {
  return left.revision === right.revision
    && sameTaskBinding(left.taskBinding, right.taskBinding);
}

function sameTaskBinding(
  left: CodexLifecycleTaskBinding | null,
  right: CodexLifecycleTaskBinding | null
): boolean {
  return left?.runId === right?.runId
    && left?.receiptId === right?.receiptId;
}

function isBindingFailure(message: string): boolean {
  return /CODEX_LIFECYCLE_TASK_BINDING_MISMATCH|CODEX_EVIDENCE_(?:IDENTITY_MISMATCH|PARENT_MISMATCH|REPLAY_CONFLICT)|task binding|identity mismatch|ambiguous active children/iu.test(message);
}

function codexSealFailure(
  error: unknown,
  options: CodexBridgeOptions,
  source: 'child' | 'parent'
): OrchestrationResult {
  if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'CODEX_TURN_NOT_TERMINAL') {
    return source === 'parent'
      ? bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'The matching Codex child has not completed')
      : pauseBridge('ORCHESTRATION_CODEX_STOP_FAILED', message, options);
  }
  if (isBindingFailure(message)) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', message);
  return pauseBridge('ORCHESTRATION_CODEX_STOP_FAILED', message, options);
}

function sameBoundLifecycleRecord(
  bound: ReturnType<typeof recordMatchesTaskReceipt>,
  current: ReturnType<typeof recordMatchesTaskReceipt>
): boolean {
  return sameTaskReceipt(bound.receipt, current.receipt)
    && sameLifecycleRevision(bound.record, current.record);
}

function candidateActivationState(
  state: ReturnType<typeof reduceCodexLifecycleEvent>,
  events: readonly CodexLifecycleEvent[]
) {
  return events.reduce((current, event) => reduceCodexLifecycleEvent(current, event), state);
}

function candidateActivationFailure(
  state: ReturnType<typeof reduceCodexLifecycleEvent>,
  options: CodexBridgeOptions
): OrchestrationResult | null {
  if (state.status === 'invalid') {
    return bridgeFailure(state.error?.code ?? 'CODEX_EVIDENCE_IDENTITY_MISMATCH', state.error?.message ?? 'Codex lifecycle identity does not match');
  }
  if (state.status !== 'start-ready' || !state.startEvidence) {
    return pauseBridge('ORCHESTRATION_CODEX_START_EVIDENCE_INVALID', 'Codex lifecycle start evidence is not ready', options);
  }
  return null;
}

async function collectActivationEvidence(
  childThreadId: string,
  options: CodexBridgeOptions,
  bound: ReturnType<typeof recordMatchesTaskReceipt>
): Promise<Readonly<{
  preflight: Awaited<ReturnType<typeof preflightCodexLifecycleEvidence>>;
  events: readonly CodexLifecycleEvent[];
  evidence: NonNullable<ReturnType<typeof reduceCodexLifecycleEvent>['startEvidence']>;
}> | OrchestrationResult> {
  const resolved = await (options.resolveThread ?? resolveCodexThread)(childThreadId);
  const current = recordMatchesTaskReceipt(childThreadId, options);
  if (!sameBoundLifecycleRecord(bound, current)) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt or lifecycle revision changed while resolving Codex child evidence');
  }
  const candidateEvents = [resolved.resolution.thread, ...resolved.reroutes, resolved.resolution.settings];
  const candidateState = candidateActivationState(bound.record.state, candidateEvents);
  const candidateFailure = candidateActivationFailure(candidateState, options);
  if (candidateFailure) return candidateFailure;
  const evidence = candidateState.startEvidence!;
  const repoRoot = options.repoRoot ?? process.cwd();
  const preflight = await (options.preflight ?? preflightCodexLifecycleEvidence)(repoRoot, {
    sessionId: evidence.parentThreadId,
    turnId: evidence.parentTurnId,
    toolUseId: evidence.spawnToolUseId
  });
  const afterPreflight = recordMatchesTaskReceipt(childThreadId, options);
  if (!sameBoundLifecycleRecord(bound, afterPreflight)) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt or lifecycle revision changed while validating Codex host evidence');
  }
  return { preflight, events: candidateEvents, evidence };
}

function applyCollectedActivationEvidence(
  childThreadId: string,
  options: CodexBridgeOptions,
  store: LifecycleStore,
  bound: ReturnType<typeof recordMatchesTaskReceipt>,
  events: readonly CodexLifecycleEvent[]
): ReturnType<LifecycleStore['read']> | OrchestrationResult {
  const current = recordMatchesTaskReceipt(childThreadId, options);
  if (!sameBoundLifecycleRecord(bound, current)) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt or lifecycle revision changed before Codex activation');
  }
  for (const event of events) store.apply(event);
  const record = store.read(childThreadId);
  return record.state.status === 'start-ready' && record.state.startEvidence
    ? record
    : bridgeFailure('CODEX_EVIDENCE_IDENTITY_MISMATCH', 'Codex lifecycle identity changed before activation');
}

function bridgeFailure(code: string, message: string): OrchestrationResult {
  return {
    status: 'failed', changed: false, taskId: null, run: null, next: null,
    error: { code, message }
  };
}

function pauseBridge(code: string, message: string, options: CodexBridgeOptions): OrchestrationResult {
  const paused = pauseMatchingOrchestrationDelegation('codex', code, message, coreOptions(options));
  return paused.error?.code === 'ORCHESTRATION_DELEGATION_MISSING'
    ? bridgeFailure(code, message)
    : paused;
}

function requiredStore(options: CodexBridgeOptions): LifecycleStore {
  if (!options.store) throw new Error('Codex lifecycle store is required for orchestration bridge events');
  return options.store;
}

async function prepareCodexOrchestrationDelegation(
  taskRef: string,
  input: Readonly<{
    client: AgentClientId;
    requestedModel?: string;
    requestedReasoningEffort?: string;
  }>,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  if (input.client !== 'codex') return prepareOrchestrationDelegation(taskRef, input, coreOptions(options));
  try {
    const repoRoot = options.repoRoot ?? process.cwd();
    const resolved = resolveTaskRef(taskRef, { repoRoot });
    if (!resolved.ok) return bridgeFailure(resolved.code, resolved.message);
    await (options.preflight ?? preflightCodexLifecycleEvidence)(
      repoRoot,
      undefined,
      resolveCodexLifecycleStoreRoot(resolved.taskId, { repoRoot })
    );
    const prepared = prepareOrchestrationDelegation(taskRef, input, coreOptions(options));
    const receipt = prepared.run?.pendingDelegation;
    if (prepared.status !== 'running' || !receipt) return prepared;
    return Object.freeze({
      ...prepared,
      adapterContext: encodeCodexLifecycleBinding({
        taskId: receipt.taskId,
        runId: receipt.runId,
        receiptId: receipt.id
      })
    });
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    return bridgeFailure('ORCHESTRATION_CLIENT_PREFLIGHT_FAILED', error instanceof Error ? error.message : String(error));
  }
}

async function activateCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const bound = recordMatchesTaskReceipt(childThreadId, options);
    if (!['prepared', 'activated', 'stage-completed'].includes(bound.receipt.status)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'lifecycle task receipt is not in an activatable state');
    }
    if (!hasActivatableOrchestrationDelegation('codex', childThreadId, coreOptions(options))) {
      return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    }
    const activationEvidence = await collectActivationEvidence(childThreadId, options, bound);
    if ('status' in activationEvidence) return activationEvidence;
    const { evidence, events, preflight } = activationEvidence;
    const repoRoot = options.repoRoot ?? process.cwd();
    const record = applyCollectedActivationEvidence(childThreadId, options, store, bound, events);
    if ('status' in record) return record;
    const buildIdentity = options.buildIdentity ?? computeLifecycleBuildIdentity(repoRoot);
    const activated = activateMatchingOrchestrationDelegation('codex', {
      nativeAgent: evidence.nativeAgent,
      childId: evidence.childThreadId,
      parentId: evidence.parentThreadId,
      spawnMode: evidence.spawnMode,
      actualModel: evidence.actualModel.value,
      actualReasoningEffort: evidence.actualReasoningEffort.value,
      ...(evidence.modelFallbackReason ? { modelFallbackReason: evidence.modelFallbackReason } : {}),
      ...(evidence.reasoningEffortFallbackReason
        ? { reasoningEffortFallbackReason: evidence.reasoningEffortFallbackReason }
        : {}),
      hostEvidence: {
        kind: 'codex-lifecycle-v2',
        hookDefinitionHash: evidence.hookDefinitionHash,
        startRevision: record.revision,
        ...buildIdentity,
        ...preflight.hookProvenance,
        capabilitySessionId: evidence.parentThreadId,
        capabilityTurnId: evidence.parentTurnId,
        spawnToolUseId: evidence.spawnToolUseId,
        spawnObservedAt: record.spawnObservedAt ?? undefined,
        controllerInstanceDigest: null,
        controlGeneration: null
      }
    }, coreOptions(options));
    return activated;
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (isBindingFailure(message)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', message);
    }
    return pauseBridge('ORCHESTRATION_CODEX_START_FAILED', message, options);
  }
}

function matchingSpawnRecords(
  store: LifecycleStore,
  binding: CodexLifecycleTaskBinding,
  spawn: CodexSpawnIdentity
) {
  return store.findByTaskBinding(binding).filter((record) =>
    record.state.spawn?.sessionId === spawn.sessionId
    && record.state.spawn?.turnId === spawn.turnId
    && record.state.spawn?.toolUseId === spawn.toolUseId
    && record.state.spawn?.nativeAgent === spawn.nativeAgent
  );
}

function verifySpawnTask(
  binding: CodexLifecycleTaskBinding,
  spawn: CodexSpawnIdentity,
  store: LifecycleStore,
  options: CodexBridgeOptions
) {
  const resolved = resolveTaskRef(binding.taskId, { repoRoot: options.repoRoot ?? process.cwd() });
  if (!resolved.ok) return bridgeFailure(resolved.code, resolved.message);
  const run = readRun(resolved.taskDir);
  if (!run) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'Codex task has no current orchestration run');
  verifyCodexLifecycleTaskBinding(binding, run, spawn.nativeAgent, {
    requestedModel: spawn.requestedModel,
    requestedReasoningEffort: spawn.requestedReasoningEffort
  });
  return { taskDir: resolved.taskDir };
}

async function resolveCurrentSpawnChild(
  childThreadId: string,
  spawn: CodexSpawnIdentity,
  options: CodexBridgeOptions
) {
  const resolved = await (options.resolveThread ?? resolveCodexThread)(childThreadId);
  if (resolved.resolution.thread.childThreadId !== childThreadId
    || resolved.resolution.thread.parentThreadId !== spawn.sessionId
    || resolved.resolution.thread.nativeAgent !== spawn.nativeAgent) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'resolved Codex child does not match the native spawn identity');
  }
  return { resolved };
}

async function activateCodexSpawnDelegation(
  spawn: CodexSpawnIdentity,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const parsed = parseCodexLifecycleBinding(spawn.taskName);
    if (!parsed) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISSING', 'Codex spawn task_name has no valid task binding');
    const task = verifySpawnTask(parsed.binding, spawn, store, options);
    if ('status' in task) return task;
    const candidates = matchingSpawnRecords(store, parsed.binding, spawn);
    if (candidates.length !== 1) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'Codex spawn does not identify one current task lifecycle record');
    }
    const childThreadId = resolveCodexSpawnedChild(spawn.transcriptPath, spawn);
    const current = await resolveCurrentSpawnChild(
      childThreadId, spawn, options
    );
    if ('status' in current) return current;
    const latestTask = verifySpawnTask(parsed.binding, spawn, store, options);
    if ('status' in latestTask) return latestTask;
    const latestCandidates = matchingSpawnRecords(store, parsed.binding, spawn);
    if (latestCandidates.length !== 1 || latestCandidates[0]!.revision !== candidates[0]!.revision) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'Codex spawn record changed while resolving its child');
    }
    store.applyToSpawn({ ...spawn, taskBinding: parsed.binding }, {
      type: 'hook-child',
      sessionId: spawn.sessionId,
      turnId: spawn.turnId,
      childThreadId,
      parentThreadId: current.resolved.resolution.thread.parentThreadId,
      nativeAgent: spawn.nativeAgent,
      source: 'parent-rollout'
    }, latestCandidates[0]!.revision);
    return activateCodexOrchestrationDelegation(childThreadId, {
      ...options,
      store,
      resolveThread: async () => current.resolved
    });
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (/CODEX_LIFECYCLE_TASK_BINDING_MISMATCH|task binding|task_name|identity does not match|does not match the current pending receipt|ambiguous/iu.test(message)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', message);
    }
    return pauseBridge('ORCHESTRATION_CODEX_START_FAILED', message, options);
  }
}

async function sealCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const bound = recordMatchesTaskReceipt(childThreadId, options);
    if (!hasSealableOrchestrationDelegation('codex', childThreadId, coreOptions(options))) {
      return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    }
    const store = requiredStore(options);
    const existing = store.read(childThreadId);
    if (!existing.consumer) {
      const stopTurnId = existing.state.stop?.turnId;
      if (!stopTurnId) {
        return pauseBridge('ORCHESTRATION_CODEX_STOP_EVIDENCE_INVALID', 'Codex lifecycle stop hook is not available', options);
      }
      const terminal = await (options.resolveTerminal ?? resolveCodexTerminal)(childThreadId, stopTurnId);
      const current = recordMatchesTaskReceipt(childThreadId, options);
      if (!sameTaskReceipt(bound.receipt, current.receipt) || !sameLifecycleRevision(existing, current.record)) {
        return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt or lifecycle revision changed while resolving Codex terminal evidence');
      }
      store.apply(terminal);
    }
    const record = store.read(childThreadId);
    const evidence = record.state.stopEvidence;
    if (record.state.status !== 'stop-ready' || !evidence || !record.state.startEvidence) {
      return pauseBridge('ORCHESTRATION_CODEX_STOP_EVIDENCE_INVALID', 'Codex lifecycle stop evidence is not ready', options);
    }
    return sealMatchingOrchestrationDelegationWithHostEvidence(
      'codex',
      { nativeAgent: record.state.startEvidence.nativeAgent, childId: childThreadId },
      (receipt) => {
        const current = recordMatchesTaskReceipt(childThreadId, options);
        const latest = store.read(childThreadId);
        if (!sameTaskReceipt(bound.receipt, current.receipt) || !sameTaskReceipt(receipt, current.receipt)
          || !sameLifecycleRevision(record, latest) || !sameTaskBinding(latest.taskBinding, current.binding)) {
          throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: task receipt changed before lifecycle evidence consumption');
        }
        const consumed = store.consume(
          childThreadId,
          receipt.id,
          receipt.hostEvidence?.hookDefinitionHash,
          existing.taskBinding ?? undefined
        );
        return {
          stopRevision: consumed.revision,
          consumer: consumed.consumer!,
          consumedAt: consumed.consumedAt!
        };
      },
      coreOptions(options)
    );
  } catch (error) {
    return codexSealFailure(error, options, 'child');
  }
}

function findCurrentParentReceipt(store: LifecycleStore, repoRoot: string) {
  if (!store.taskId) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISSING', 'parent seal requires a task-scoped lifecycle store');
  const resolved = resolveTaskRef(store.taskId, { repoRoot });
  if (!resolved.ok) return bridgeFailure(resolved.code, resolved.message);
  const pending = readRun(resolved.taskDir)?.pendingDelegation;
  if (!pending || pending.client !== 'codex') {
    return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
  }
  return { pending };
}

function findParentLifecycleRecord(
  parentThreadId: string,
  store: LifecycleStore,
  pending: NonNullable<NonNullable<ReturnType<typeof readRun>>['pendingDelegation']>
) {
  const binding = { taskId: pending.taskId, runId: pending.runId, receiptId: pending.id };
  const candidates = store.findByTaskBinding(binding).filter((record) =>
    record.state.startEvidence?.parentThreadId === parentThreadId
  );
  if (!candidates.length) return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
  if (candidates.length !== 1) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'parent seal has multiple lifecycle records for the current task receipt');
  }
  const active = candidates[0]!;
  const start = active.state.startEvidence;
  const child = active.state.child;
  if (!start || !child || start.childThreadId !== child.childThreadId
    || start.parentThreadId !== parentThreadId
    || active.state.spawn?.sessionId !== parentThreadId
    || active.state.spawn.nativeAgent !== start.nativeAgent
    || managedDelegationRole(start.nativeAgent) !== pending.role) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'parent lifecycle record does not match the current native delegation identity');
  }
  return { active, start, child };
}

async function collectParentTerminalIfNeeded(
  active: ReturnType<LifecycleStore['read']>,
  start: NonNullable<ReturnType<typeof reduceCodexLifecycleEvent>['startEvidence']>,
  options: CodexBridgeOptions
): Promise<Awaited<ReturnType<typeof resolveCodexTerminal>> | null> {
  if (active.state.terminal) return null;
  const resolveTerminal = options.resolveTerminal ?? resolveCodexTerminal;
  return active.state.stop
    ? resolveTerminal(start.childThreadId, active.state.stop.turnId)
    : resolveTerminal(start.childThreadId);
}

function applyParentTerminalCandidate(
  parentThreadId: string,
  repoRoot: string,
  store: LifecycleStore,
  pending: NonNullable<NonNullable<ReturnType<typeof readRun>>['pendingDelegation']>,
  active: ReturnType<LifecycleStore['read']>,
  start: NonNullable<ReturnType<typeof reduceCodexLifecycleEvent>['startEvidence']>,
  child: NonNullable<ReturnType<typeof reduceCodexLifecycleEvent>['child']>,
  terminal: Awaited<ReturnType<typeof resolveCodexTerminal>> | null
): OrchestrationResult | null {
  const latestReceipt = findCurrentParentReceipt(store, repoRoot);
  if ('status' in latestReceipt) return latestReceipt;
  if (!sameTaskReceipt(pending, latestReceipt.pending)) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt changed while resolving parent terminal evidence');
  }
  const latestMatch = findParentLifecycleRecord(parentThreadId, store, latestReceipt.pending);
  if ('status' in latestMatch) return latestMatch;
  if (!sameLifecycleRevision(active, latestMatch.active)
    || !sameTaskBinding(active.taskBinding, latestMatch.active.taskBinding)) {
    return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt or lifecycle revision changed while resolving parent terminal evidence');
  }
  if (terminal) store.apply(terminal);
  if (!store.read(start.childThreadId).state.stop) {
    store.apply({
      type: 'hook-stop', sessionId: parentThreadId, turnId: child.turnId,
      childThreadId: start.childThreadId, nativeAgent: start.nativeAgent, source: 'parent-rollout'
    });
  }
  return null;
}

async function sealCodexParentDelegation(
  parentThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const repoRoot = options.repoRoot ?? options.orchestrationOptions?.repoRoot ?? process.cwd();
    const current = findCurrentParentReceipt(store, repoRoot);
    if ('status' in current) return current;
    const pending = current.pending;
    const match = findParentLifecycleRecord(parentThreadId, store, pending);
    if ('status' in match) return match;
    const { active, start, child } = match;
    if (active.consumer) return sealCodexOrchestrationDelegation(start.childThreadId, options);
    const terminal = await collectParentTerminalIfNeeded(active, start, options);
    const failure = applyParentTerminalCandidate(parentThreadId, repoRoot, store, pending, active, start, child, terminal);
    if (failure) return failure;
    return sealCodexOrchestrationDelegation(start.childThreadId, options);
  } catch (error) {
    return codexSealFailure(error, options, 'parent');
  }
}

function reconcileCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): OrchestrationResult {
  return reconcileMatchingOrchestrationDelegation('codex', childThreadId, coreOptions(options));
}

export {
  activateCodexOrchestrationDelegation,
  activateCodexSpawnDelegation,
  prepareCodexOrchestrationDelegation,
  reconcileCodexOrchestrationDelegation,
  sealCodexParentDelegation,
  sealCodexOrchestrationDelegation
};
export type { CodexBridgeOptions };
