import fs from 'node:fs';
import path from 'node:path';

import {
  preflightCodexLifecycleEvidence,
  resolveCodexSpawnedChild,
  resolveCodexTerminal,
  resolveCodexThread
} from '../agent-clients/adapters/codex-lifecycle/app-server.ts';
import { createCodexLifecycleStore } from '../agent-clients/adapters/codex-lifecycle/store.ts';
import {
  createCodexCapabilityStore,
  isCodexCapabilityProvenanceDetail
} from '../agent-clients/adapters/codex-lifecycle/capability-store.ts';
import type { CodexCapabilityProvenanceDetail } from '../agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { computeLifecycleBuildIdentity, verifyLifecycleBuildIdentity } from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import type { LifecycleBuildIdentity } from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';
import {
  verifyCodexSandboxControllerContext,
  verifyCodexSandboxControllerContextWithWarnings as verifySandboxControllerWithWarnings
} from '../agent-clients/adapters/codex-lifecycle/sandbox-controller.ts';
import {
  computeLifecycleProfileProvenance,
  verifyCodexSandboxControllerContextWithWarnings as verifyControllerContextFileWithWarnings,
  verifyCodexSandboxControllerContext as verifyControllerContextFile,
  type LifecycleContextWarning,
  type LifecycleProfileProvenance
} from '../agent-clients/adapters/codex-lifecycle/controller-context.ts';
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
  sealMatchingOrchestrationDelegationWithHostEvidence
} from './orchestration.ts';
import type { OrchestrationOptions, OrchestrationResult } from './orchestration.ts';
import type { LifecycleIdentityWarning } from '../agent-clients/adapters/codex-lifecycle/build-identity.ts';

type LifecycleStore = ReturnType<typeof createCodexLifecycleStore>;
type CapabilityStore = ReturnType<typeof createCodexCapabilityStore>;
type CodexBridgeOptions = Readonly<{
  repoRoot?: string;
  store?: LifecycleStore;
  preflight?: typeof preflightCodexLifecycleEvidence;
  resolveThread?: typeof resolveCodexThread;
  resolveTerminal?: typeof resolveCodexTerminal;
  capabilityStore?: CapabilityStore;
  buildIdentity?: LifecycleBuildIdentity;
  verifyControllerContextWithWarnings?: typeof verifySandboxControllerWithWarnings;
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

function bridgeFailure(code: string, message: string, detail?: CodexCapabilityProvenanceDetail): OrchestrationResult {
  return {
    status: 'failed', changed: false, taskId: null, run: null, next: null,
    error: { code, message, ...(detail ? { detail } : {}) }
  };
}

function capabilityFailure(error: unknown): NonNullable<OrchestrationResult['error']> {
  const detailValue = error instanceof Error
    ? (error as Error & { detail?: unknown }).detail
    : undefined;
  return {
    code: error instanceof Error && error.name.startsWith('CODEX_CAPABILITY_')
      ? error.name
      : 'ORCHESTRATION_CLIENT_PREFLIGHT_FAILED',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error
      && error.name === 'CODEX_CAPABILITY_PROVENANCE_MISMATCH'
      && isCodexCapabilityProvenanceDetail(detailValue)
      ? { detail: detailValue }
      : {})
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

function controllerContext(
  repoRoot: string,
  brokerController: Readonly<{ instanceDigest: string; controlGeneration: string }> | null
) {
  const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  if (!contextPath) return null;
  if (brokerController) {
    return verifyControllerContextFile(contextPath, {
      repoRoot,
      generation: process.env.AGENT_INFRA_CONTROL_GENERATION ?? brokerController.controlGeneration
    });
  }
  return verifyCodexSandboxControllerContext(contextPath, { repoRoot });
}

function controllerContextWithWarnings(
  repoRoot: string,
  brokerController: Readonly<{ instanceDigest: string; controlGeneration: string }> | null
): Readonly<{ context: ReturnType<typeof verifyControllerContextFile>; warnings: readonly LifecycleContextWarning[] }> | null {
  const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  if (!contextPath) return null;
  if (!brokerController) {
    return verifySandboxControllerWithWarnings(contextPath, { repoRoot });
  }
  const result = verifyControllerContextFileWithWarnings(contextPath, {
    repoRoot,
    generation: process.env.AGENT_INFRA_CONTROL_GENERATION ?? brokerController.controlGeneration
  });
  return result as Readonly<{ context: ReturnType<typeof verifyControllerContextFile>; warnings: readonly LifecycleContextWarning[] }>;
}

function profileProvenanceForRoot(repoRoot: string, packageVersion: string): LifecycleProfileProvenance | undefined {
  const executor = path.join(repoRoot, '.codex', 'agents', 'agent-infra-lifecycle-executor.toml');
  const reviewer = path.join(repoRoot, '.codex', 'agents', 'agent-infra-lifecycle-reviewer.toml');
  if (!fs.existsSync(executor) || !fs.existsSync(reviewer)) {
    throw new Error('CODEX_LIFECYCLE_PROFILE_PROVENANCE_INVALID');
  }
  return computeLifecycleProfileProvenance(repoRoot, packageVersion);
}

function brokerBindingConflictsWithContext(
  repoRoot: string,
  brokerController: Readonly<{ instanceDigest: string; controlGeneration: string }> | null
): boolean {
  const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
  if (!contextPath || !brokerController) return false;
  const context = verifyControllerContextFile(contextPath, {
    repoRoot,
    generation: process.env.AGENT_INFRA_CONTROL_GENERATION ?? brokerController.controlGeneration
  });
  return context.controllerInstanceDigest !== brokerController.instanceDigest
    || context.controlGeneration !== brokerController.controlGeneration;
}

function brokerControllerBinding(): Readonly<{ instanceDigest: string; controlGeneration: string }> | null {
  const raw = process.env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING;
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_BINDING_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_BINDING_INVALID');
  }
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).sort().join(',') !== 'controlGeneration,instanceDigest'
    || typeof binding.instanceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.instanceDigest)
    || typeof binding.controlGeneration !== 'string' || binding.controlGeneration.length === 0) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_BINDING_INVALID');
  }
  return binding as { instanceDigest: string; controlGeneration: string };
}

function controllerWarningsFromEnvironment(): readonly LifecycleIdentityWarning[] {
  const raw = process.env.AGENT_INFRA_CONTROL_CONTROLLER_WARNINGS;
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_WARNINGS_INVALID');
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_WARNINGS_INVALID');
  }
  const codes = new Set<string>();
  for (const warning of value) {
    if (!warning || typeof warning !== 'object' || Array.isArray(warning)) {
      throw new Error('CODEX_SANDBOX_CONTROLLER_WARNINGS_INVALID');
    }
    const row = warning as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'action,code,message'
      || (row.code !== 'CODEX_LIFECYCLE_BUILD_MISMATCH' && row.code !== 'CODEX_LIFECYCLE_CONTRACT_MISMATCH')
      || codes.has(row.code as string)
      || typeof row.message !== 'string'
      || !/^[^\r\n\0]{1,512}$/u.test(row.message)
      || /(?:^|\s)(?:\/|[A-Za-z]:[\\/])/u.test(row.message)
      || row.action !== 'rebuild-sandbox') {
      throw new Error('CODEX_SANDBOX_CONTROLLER_WARNINGS_INVALID');
    }
    codes.add(row.code as string);
  }
  return Object.freeze(value as LifecycleIdentityWarning[]);
}

async function prepareCodexOrchestrationDelegation(
  taskRef: string,
  input: Readonly<{
    client: AgentClientId;
    requestedModel?: string;
    requestedReasoningEffort?: string;
    capabilityToken?: string;
  }>,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  if (input.client !== 'codex') return prepareOrchestrationDelegation(taskRef, input, coreOptions(options));
  try {
    const repoRoot = options.repoRoot ?? process.cwd();
    const resolved = resolveTaskRef(taskRef, { repoRoot });
    if (!resolved.ok) return bridgeFailure(resolved.code, resolved.message);
    const preflight = await (options.preflight ?? preflightCodexLifecycleEvidence)(repoRoot);
    if (!input.capabilityToken) {
      return bridgeFailure(
        'ORCHESTRATION_CODEX_CAPABILITY_REQUIRED',
        'Codex prepare requires a current-session capability token'
      );
    }
    const buildIdentity = options.buildIdentity ?? computeLifecycleBuildIdentity(repoRoot);
    const brokerController = brokerControllerBinding();
    const contextVerification = controllerContextWithWarnings(repoRoot, brokerController);
    const identityWarnings: Array<LifecycleIdentityWarning | LifecycleContextWarning> = [
      ...controllerWarningsFromEnvironment(),
      ...(contextVerification?.warnings ?? [])
    ];
    if (brokerBindingConflictsWithContext(repoRoot, brokerController)) {
      return bridgeFailure(
        'CODEX_SANDBOX_CONTROLLER_BINDING_MISMATCH',
        'broker and local controller bindings do not match'
      );
    }
    const localController = contextVerification?.context ?? controllerContext(repoRoot, brokerController);
    if (localController && brokerController
      && (localController.controllerInstanceDigest !== brokerController.instanceDigest
        || localController.controlGeneration !== brokerController.controlGeneration)) {
      return bridgeFailure(
        'CODEX_SANDBOX_CONTROLLER_BINDING_MISMATCH',
        'broker and local controller bindings do not match'
      );
    }
    const controller = brokerController ?? (localController ? {
      instanceDigest: localController.controllerInstanceDigest,
      controlGeneration: localController.controlGeneration
    } : null);
    const capabilityStore = options.capabilityStore ?? createCodexCapabilityStore();
    const attested = capabilityStore.inspect(input.capabilityToken);
    const capabilityIdentity = verifyLifecycleBuildIdentity(attested.buildIdentity, buildIdentity);
    if (!capabilityIdentity.ok) {
      return bridgeFailure(capabilityIdentity.code!, capabilityIdentity.message!);
    }
    identityWarnings.push(...capabilityIdentity.warnings);
    const profileProvenance = localController?.profileProvenance
      ?? profileProvenanceForRoot(repoRoot, buildIdentity.packageVersion);
    const lifecycleProvenance = {
      ...attested.buildIdentity,
      hookDefinitionHash: preflight.hookDefinitionHash,
      ...preflight.hookProvenance,
      capabilitySessionId: attested.sessionId!,
      capabilityTurnId: attested.turnId!,
      capabilityToolUseId: attested.toolUseId!,
      controllerInstanceDigest: controller?.instanceDigest ?? null,
      controlGeneration: controller?.controlGeneration ?? null,
      ...(profileProvenance ? { profileProvenance } : {})
    };
    const capabilityExpected = {
      taskId: resolved.taskId,
      hookDefinitionHash: preflight.hookDefinitionHash,
      buildIdentity,
      ...(controller ? { controller: {
        instanceDigest: controller.instanceDigest,
        controlGeneration: controller.controlGeneration
      } } : {})
    };
    const prepared = prepareOrchestrationDelegation(taskRef, {
      ...input,
      lifecycleProvenance
    }, {
      ...coreOptions(options),
      validateLifecycleCapability: () => {
        try {
          const validated = capabilityStore.validate(input.capabilityToken!, capabilityExpected);
          if (validated.sessionId !== attested.sessionId
            || validated.turnId !== attested.turnId
            || validated.toolUseId !== attested.toolUseId) {
            return {
              code: 'CODEX_CAPABILITY_IDENTITY_CHANGED',
              message: 'capability identity changed during validation'
            };
          }
          return null;
        } catch (error) {
          return capabilityFailure(error);
        }
      },
      consumeLifecycleCapability: () => {
        try {
          const consumed = capabilityStore.consume(input.capabilityToken!, capabilityExpected);
          if (consumed.sessionId !== attested.sessionId
            || consumed.turnId !== attested.turnId
            || consumed.toolUseId !== attested.toolUseId) {
            return {
              code: 'CODEX_CAPABILITY_IDENTITY_CHANGED',
              message: 'capability identity changed during consumption'
            };
          }
          return null;
        } catch (error) {
          return capabilityFailure(error);
        }
      }
    });
    return identityWarnings.length > 0 && prepared.status !== 'failed'
      ? { ...prepared, warnings: Object.freeze(identityWarnings) }
      : prepared;
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    const detailValue = error instanceof Error
      ? (error as Error & { detail?: unknown }).detail
      : undefined;
    const detail = error instanceof Error
      && error.name === 'CODEX_CAPABILITY_PROVENANCE_MISMATCH'
      && isCodexCapabilityProvenanceDetail(detailValue)
      ? detailValue
      : undefined;
    return bridgeFailure(
      error instanceof Error && error.name.startsWith('CODEX_CAPABILITY_')
        ? error.name
        : 'ORCHESTRATION_CLIENT_PREFLIGHT_FAILED',
      error instanceof Error ? error.message : String(error),
      detail
    );
  }
}

async function activateCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
    if (!hasActivatableOrchestrationDelegation('codex', childThreadId, coreOptions(options))) {
      return bridgeFailure('ORCHESTRATION_DELEGATION_MISSING', 'No matching Codex delegation is active');
    }
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
    const repoRoot = options.repoRoot ?? process.cwd();
    const preflight = await (options.preflight ?? preflightCodexLifecycleEvidence)(repoRoot, {
      sessionId: evidence.parentThreadId,
      turnId: evidence.parentTurnId,
      toolUseId: evidence.spawnToolUseId
    });
    const buildIdentity = options.buildIdentity ?? computeLifecycleBuildIdentity(repoRoot);
    const contextPath = process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
    const contextVerification = contextPath
      ? (options.verifyControllerContextWithWarnings ?? verifySandboxControllerWithWarnings)(contextPath, { repoRoot })
      : null;
    const controller = contextVerification?.context ?? null;
    const profileProvenance = controller?.profileProvenance
      ?? profileProvenanceForRoot(repoRoot, buildIdentity.packageVersion);
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
        controllerInstanceDigest: controller?.controllerInstanceDigest ?? null,
        controlGeneration: controller?.controlGeneration ?? null,
        ...(profileProvenance ? { profileProvenance } : {})
      }
    }, coreOptions(options));
    const warnings = [...(activated.warnings ?? []), ...(contextVerification?.warnings ?? [])];
    const dedupedWarnings = [...new Map(warnings.map((warning) => [warning.code, warning])).values()];
    return dedupedWarnings.length > 0 && activated.status !== 'failed'
      ? { ...activated, warnings: Object.freeze(dedupedWarnings) }
      : activated;
  } catch (error) {
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
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
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
    return pauseBridge('ORCHESTRATION_CODEX_START_FAILED', error instanceof Error ? error.message : String(error), options);
  }
}

async function sealCodexOrchestrationDelegation(
  childThreadId: string,
  options: CodexBridgeOptions = {}
): Promise<OrchestrationResult> {
  try {
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
      store.apply(await (options.resolveTerminal ?? resolveCodexTerminal)(childThreadId, stopTurnId));
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
    if (error instanceof OrchestrationStateError) return bridgeFailure(error.code, error.message);
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
      const resolveTerminal = options.resolveTerminal ?? resolveCodexTerminal;
      store.apply(active.state.stop
        ? await resolveTerminal(start.childThreadId, active.state.stop.turnId)
        : await resolveTerminal(start.childThreadId));
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
