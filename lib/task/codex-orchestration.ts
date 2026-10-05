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
import {
  encodeCodexLifecycleBinding,
  resolveCodexLifecycleStoreRoot,
  parseCodexLifecycleBinding,
  verifyCodexLifecycleTaskBinding
} from '../agent-clients/adapters/codex-lifecycle/binding.ts';
import { reduceCodexLifecycleEvent } from '../agent-clients/adapters/codex-lifecycle/evidence.ts';

type LifecycleStore = ReturnType<typeof createCodexLifecycleStore>;
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

function recordMatchesTaskReceipt(childThreadId: string, options: CodexBridgeOptions) {
  const store = requiredStore(options);
  let record: ReturnType<LifecycleStore['read']>;
  try {
    record = store.read(childThreadId);
  } catch (error) {
    throw new Error(`CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: ${error instanceof Error ? error.message : String(error)}`);
  }
  const binding = record.taskBinding;
  if (!binding || (store.taskId && binding.taskId !== store.taskId)) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: lifecycle record task does not match its store');
  }
  const repoRoot = options.repoRoot ?? options.orchestrationOptions?.repoRoot ?? process.cwd();
  const resolved = resolveTaskRef(binding.taskId, { repoRoot });
  if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
  const run = readRun(resolved.taskDir);
  const receipt = run?.pendingDelegation;
  const nativeAgent = record.state.startEvidence?.nativeAgent ?? record.state.spawn?.nativeAgent ?? '';
  const role = nativeAgent.endsWith('reviewer') ? 'reviewer' : 'executor';
  if (run?.status !== 'running' || !receipt
    || receipt.taskId !== binding.taskId
    || receipt.runId !== binding.runId
    || receipt.id !== binding.receiptId
    || receipt.client !== 'codex'
    || receipt.role !== role) {
    throw new Error('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH: lifecycle record does not match the current pending task receipt');
  }
  return { store, record, binding, resolved, run, receipt };
}

function sameTaskReceipt(
  left: Readonly<{ taskId: string; runId: string; id: string }>,
  right: Readonly<{ taskId: string; runId: string; id: string }>
): boolean {
  return left.taskId === right.taskId && left.runId === right.runId && left.id === right.id;
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
      lifecycleBindingMarker: encodeCodexLifecycleBinding({
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
    const resolved = await (options.resolveThread ?? resolveCodexThread)(childThreadId);
    const current = recordMatchesTaskReceipt(childThreadId, options);
    if (!sameTaskReceipt(bound.receipt, current.receipt)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt changed while resolving Codex child evidence');
    }
    const candidateEvents = [resolved.resolution.thread, ...resolved.reroutes, resolved.resolution.settings];
    let candidateState = bound.record.state;
    for (const event of candidateEvents) candidateState = reduceCodexLifecycleEvent(candidateState, event);
    if (candidateState.status === 'invalid') {
      return bridgeFailure(candidateState.error?.code ?? 'CODEX_EVIDENCE_IDENTITY_MISMATCH', candidateState.error?.message ?? 'Codex lifecycle identity does not match');
    }
    const evidence = candidateState.status === 'start-ready' ? candidateState.startEvidence : null;
    if (!evidence) {
      return pauseBridge('ORCHESTRATION_CODEX_START_EVIDENCE_INVALID', 'Codex lifecycle start evidence is not ready', options);
    }
    const repoRoot = options.repoRoot ?? process.cwd();
    const preflight = await (options.preflight ?? preflightCodexLifecycleEvidence)(repoRoot, {
      sessionId: evidence.parentThreadId,
      turnId: evidence.parentTurnId,
      toolUseId: evidence.spawnToolUseId
    });
    const afterPreflight = recordMatchesTaskReceipt(childThreadId, options);
    if (!sameTaskReceipt(bound.receipt, afterPreflight.receipt)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt changed while validating Codex host evidence');
    }
    store.apply(resolved.resolution.thread);
    for (const reroute of resolved.reroutes) store.apply(reroute);
    store.apply(resolved.resolution.settings);
    const record = store.read(childThreadId);
    if (record.state.status !== 'start-ready' || !record.state.startEvidence) {
      return bridgeFailure('CODEX_EVIDENCE_IDENTITY_MISMATCH', 'Codex lifecycle identity changed before activation');
    }
    const currentBeforeActivation = recordMatchesTaskReceipt(childThreadId, options);
    if (!sameTaskReceipt(bound.receipt, currentBeforeActivation.receipt)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt changed before Codex activation');
    }
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
    if (/CODEX_LIFECYCLE_TASK_BINDING_MISMATCH|task binding|identity mismatch/iu.test(message)) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', message);
    }
    return pauseBridge('ORCHESTRATION_CODEX_START_FAILED', message, options);
  }
}

async function activateCodexSpawnDelegation(
  spawn: CodexSpawnIdentity,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const parsed = parseCodexLifecycleBinding(spawn.taskName);
    if (!parsed) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISSING', 'Codex spawn task_name has no valid task binding');
    const resolvedTask = resolveTaskRef(parsed.binding.taskId, { repoRoot: options.repoRoot ?? process.cwd() });
    if (!resolvedTask.ok) return bridgeFailure(resolvedTask.code, resolvedTask.message);
    const pendingRun = readRun(resolvedTask.taskDir);
    if (!pendingRun) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'Codex task has no current orchestration run');
    verifyCodexLifecycleTaskBinding(parsed.binding, pendingRun, spawn.nativeAgent, {
      requestedModel: spawn.requestedModel,
      requestedReasoningEffort: spawn.requestedReasoningEffort
    });
    if (store.taskId && store.taskId !== parsed.binding.taskId) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'Codex lifecycle store task does not match spawn binding');
    }
    const childThreadId = resolveCodexSpawnedChild(spawn.transcriptPath, spawn);
    const resolved = await (options.resolveThread ?? resolveCodexThread)(childThreadId);
    const currentTask = resolveTaskRef(parsed.binding.taskId, { repoRoot: options.repoRoot ?? process.cwd() });
    if (!currentTask.ok) return bridgeFailure(currentTask.code, currentTask.message);
    const currentRun = readRun(currentTask.taskDir);
    if (!currentRun) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'Codex task run disappeared while resolving its child');
    verifyCodexLifecycleTaskBinding(parsed.binding, currentRun, spawn.nativeAgent, {
      requestedModel: spawn.requestedModel,
      requestedReasoningEffort: spawn.requestedReasoningEffort
    });
    if (resolved.resolution.thread.childThreadId !== childThreadId
      || resolved.resolution.thread.parentThreadId !== spawn.sessionId
      || resolved.resolution.thread.nativeAgent !== spawn.nativeAgent) {
      return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'resolved Codex child does not match the native spawn identity');
    }
    store.applyToSpawn({ ...spawn, taskBinding: parsed.binding }, {
      type: 'hook-child',
      sessionId: spawn.sessionId,
      turnId: spawn.turnId,
      childThreadId,
      parentThreadId: resolved.resolution.thread.parentThreadId,
      nativeAgent: spawn.nativeAgent,
      source: 'parent-rollout'
    });
    return activateCodexOrchestrationDelegation(childThreadId, {
      ...options,
      store,
      resolveThread: async () => resolved
    });
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (/CODEX_LIFECYCLE_TASK_BINDING_MISMATCH|task binding|task_name|identity does not match|does not match the current pending receipt/iu.test(message)) {
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
      if (!sameTaskReceipt(bound.receipt, current.receipt)) {
        return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt changed while resolving Codex terminal evidence');
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
        if (!sameTaskReceipt(bound.receipt, current.receipt) || !sameTaskReceipt(receipt, current.receipt)) {
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
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (/CODEX_LIFECYCLE_TASK_BINDING_MISMATCH|task binding|identity mismatch/iu.test(message)) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', message);
    return pauseBridge('ORCHESTRATION_CODEX_STOP_FAILED', message, options);
  }
}

async function sealCodexParentDelegation(
  parentThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const candidates = store.findByParent(parentThreadId);
    if (!store.taskId) return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISSING', 'parent seal requires a task-scoped lifecycle store');
    const repoRoot = options.repoRoot ?? options.orchestrationOptions?.repoRoot ?? process.cwd();
    const resolved = resolveTaskRef(store.taskId, { repoRoot });
    if (!resolved.ok) return bridgeFailure(resolved.code, resolved.message);
    const pending = readRun(resolved.taskDir)?.pendingDelegation;
    if (!pending || pending.taskId !== store.taskId || pending.client !== 'codex') {
      return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    }
    const scopedCandidates = candidates.filter((record) => record.taskBinding?.taskId === pending.taskId
      && record.taskBinding.runId === pending.runId
      && record.taskBinding.receiptId === pending.id);
    if (!scopedCandidates.length) return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    for (const consumed of scopedCandidates.filter((record) => record.consumer)) {
      const replayed = await sealCodexOrchestrationDelegation(consumed.state.startEvidence!.childThreadId, options);
      if (replayed.error?.code !== 'ORCHESTRATION_DELEGATION_MISSING') return replayed;
    }
    const active = scopedCandidates.find((record) => !record.consumer);
    if (!active) return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    const start = active.state.startEvidence!;
    const child = active.state.child!;
    if (!active.state.terminal) {
      const resolveTerminal = options.resolveTerminal ?? resolveCodexTerminal;
      const terminal = active.state.stop
        ? await resolveTerminal(start.childThreadId, active.state.stop.turnId)
        : await resolveTerminal(start.childThreadId);
      const current = recordMatchesTaskReceipt(start.childThreadId, options);
      if (!sameTaskReceipt(pending, current.receipt)) {
        return bridgeFailure('CODEX_LIFECYCLE_TASK_BINDING_MISMATCH', 'task receipt changed while resolving parent terminal evidence');
      }
      store.apply(terminal);
    }
    if (!store.read(start.childThreadId).state.stop) {
      store.apply({
        type: 'hook-stop',
        sessionId: parentThreadId,
        turnId: child.turnId,
        childThreadId: start.childThreadId,
        nativeAgent: start.nativeAgent,
        source: 'parent-rollout'
      });
    }
    return sealCodexOrchestrationDelegation(start.childThreadId, options);
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    if (error instanceof Error && error.message === 'CODEX_TURN_NOT_TERMINAL') {
      return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'The matching Codex child has not completed');
    }
    return pauseBridge('ORCHESTRATION_CODEX_STOP_FAILED', error instanceof Error ? error.message : String(error), options);
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
