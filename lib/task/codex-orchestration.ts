import {
  preflightCodexLifecycleEvidence,
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

function reconcileCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): OrchestrationResult {
  return reconcileMatchingOrchestrationDelegation('codex', childThreadId, coreOptions(options));
}

export {
  activateCodexOrchestrationDelegation,
  prepareCodexOrchestrationDelegation,
  reconcileCodexOrchestrationDelegation,
  sealCodexOrchestrationDelegation
};
export type { CodexBridgeOptions };
