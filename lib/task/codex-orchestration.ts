import {
  preflightCodexLifecycleEvidence,
  resolveCodexSpawnedChild,
  resolveCodexTerminal,
  resolveCodexThread
} from '../agent-clients/adapters/codex-lifecycle/app-server.ts';
import { createCodexLifecycleStore } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import {
  activateMatchingOrchestrationDelegation,
  pauseMatchingOrchestrationDelegation,
  prepareOrchestrationDelegation,
  reconcileMatchingOrchestrationDelegation,
  sealMatchingOrchestrationDelegationWithHostEvidence
} from './orchestration.ts';
import type { OrchestrationOptions, OrchestrationResult } from './orchestration.ts';

type LifecycleStore = ReturnType<typeof createCodexLifecycleStore>;
type CodexBridgeOptions = Readonly<{
  repoRoot?: string;
  store?: LifecycleStore;
  preflight?: typeof preflightCodexLifecycleEvidence;
  resolveThread?: typeof resolveCodexThread;
  resolveTerminal?: typeof resolveCodexTerminal;
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
  return { ...options.orchestrationOptions, repoRoot: options.repoRoot ?? options.orchestrationOptions?.repoRoot };
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
    await (options.preflight ?? preflightCodexLifecycleEvidence)(options.repoRoot ?? process.cwd());
  } catch (error) {
    return bridgeFailure(
      'ORCHESTRATION_CLIENT_PREFLIGHT_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  return prepareOrchestrationDelegation(taskRef, input, coreOptions(options));
}

async function activateCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const resolved = await (options.resolveThread ?? resolveCodexThread)(childThreadId);
    store.apply(resolved.resolution.thread);
    for (const reroute of resolved.reroutes) store.apply(reroute);
    store.apply(resolved.resolution.settings);
    const record = store.read(childThreadId);
    const evidence = record.state.startEvidence;
    if (record.state.status !== 'start-ready' || !evidence) {
      return pauseBridge('ORCHESTRATION_CODEX_START_EVIDENCE_INVALID', 'Codex lifecycle start evidence is not ready', options);
    }
    return activateMatchingOrchestrationDelegation('codex', {
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
        kind: 'codex-lifecycle-v1',
        hookDefinitionHash: evidence.hookDefinitionHash,
        startRevision: record.revision
      }
    }, coreOptions(options));
  } catch (error) {
    return pauseBridge('ORCHESTRATION_CODEX_START_FAILED', error instanceof Error ? error.message : String(error), options);
  }
}

async function activateCodexSpawnDelegation(
  spawn: CodexSpawnIdentity,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const childThreadId = resolveCodexSpawnedChild(spawn.transcriptPath, spawn);
    const resolved = await (options.resolveThread ?? resolveCodexThread)(childThreadId);
    store.applyToSpawn(spawn, {
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
    return pauseBridge('ORCHESTRATION_CODEX_START_FAILED', error instanceof Error ? error.message : String(error), options);
  }
}

async function sealCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const existing = store.read(childThreadId);
    if (!existing.consumer) {
      store.apply(await (options.resolveTerminal ?? resolveCodexTerminal)(childThreadId));
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
        const consumed = store.consume(childThreadId, receipt.id, receipt.hostEvidence?.hookDefinitionHash);
        return {
          stopRevision: consumed.revision,
          consumer: consumed.consumer!,
          consumedAt: consumed.consumedAt!
        };
      },
      coreOptions(options)
    );
  } catch (error) {
    return pauseBridge('ORCHESTRATION_CODEX_STOP_FAILED', error instanceof Error ? error.message : String(error), options);
  }
}

async function sealCodexParentDelegation(
  parentThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    const store = requiredStore(options);
    const candidates = store.findByParent(parentThreadId);
    if (!candidates.length) return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    for (const consumed of candidates.filter((record) => record.consumer)) {
      const replayed = await sealCodexOrchestrationDelegation(consumed.state.startEvidence!.childThreadId, options);
      if (replayed.error?.code !== 'ORCHESTRATION_DELEGATION_MISSING') return replayed;
    }
    const active = candidates.find((record) => !record.consumer);
    if (!active) return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    const start = active.state.startEvidence!;
    const child = active.state.child!;
    if (!active.state.terminal) {
      store.apply(await (options.resolveTerminal ?? resolveCodexTerminal)(start.childThreadId));
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
