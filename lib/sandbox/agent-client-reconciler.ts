import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAgentClientId } from '../agent-clients/types.ts';
import {
  listAgentClientAdapters,
  listInstalledAgentClientAdapters
} from '../agent-clients/registry.ts';
import { hostJoin } from './engines/wsl2-paths.ts';
import type { AgentClientAdapter } from '../agent-clients/adapter.ts';
import type { AgentClientState } from '../agent-clients/types.ts';
import type {
  AgentClientSandboxRecoveryCheck,
  AgentClientSandboxHook,
  AgentClientSandboxHookContext,
  AgentClientSandboxHookResult,
  SandboxAlias,
  SandboxHookCommand,
  SandboxHookCommandResult,
  SandboxHookPhase,
  SandboxHookStatus,
  SandboxTool
} from './tool-types.ts';

const DEFAULT_SANDBOX_HOOK_TIMEOUT_MS = 30_000;

type SandboxCapabilityConfig = Readonly<{
  home: string;
  project: string;
  tools: readonly string[];
  customTools?: readonly SandboxTool[];
  agentClientState: AgentClientState;
}>;

type SandboxRuntimeCapabilityProjection = Readonly<{
  tools: readonly Readonly<Record<string, unknown>>[];
  selectedAgentClients: readonly string[];
  hooks: readonly Readonly<{
    adapterId: string;
    id: string;
    phase: SandboxHookPhase;
    timeoutMs: number;
  }>[];
  recoveryChecks: readonly Readonly<{
    adapterId: string;
    id: string;
    when?: AgentClientSandboxRecoveryCheck['when'];
    probe: AgentClientSandboxRecoveryCheck['probe'];
    finding: Readonly<{
      repairKind: AgentClientSandboxRecoveryCheck['finding']['repairKind'];
      path?: string;
    }>;
    repair?: AgentClientSandboxRecoveryCheck['repair'];
  }>[];
  image: SandboxImageContribution;
}>;

type SandboxImageContribution = Readonly<{
  dockerfileFragments: readonly string[];
  dotfilesExclusions: readonly string[];
}>;

type PlannedAgentClientRecoveryCheck = Readonly<{
  adapterId: string;
  check: AgentClientSandboxRecoveryCheck;
}>;

type SandboxCapabilityPlan = Readonly<{
  tools: readonly SandboxTool[];
  selectedAgentClients: readonly AgentClientAdapter[];
  hooksByPhase: Readonly<Record<SandboxHookPhase, readonly AgentClientSandboxHook[]>>;
  recoveryChecks: readonly PlannedAgentClientRecoveryCheck[];
  aliases: readonly SandboxAlias[];
  image: SandboxImageContribution;
  imageSignature: string;
  runtimeSignature: string;
  runtimeProjection: SandboxRuntimeCapabilityProjection;
  cleanupInventory: readonly SandboxTool[];
}>;

type HookExecutionResult = Readonly<{
  hookId: string;
  phase: SandboxHookPhase;
  status: SandboxHookStatus;
  message?: string;
}>;

type TimerHandle = ReturnType<typeof setTimeout> | unknown;

function agentInfraTool(home: string): SandboxTool {
  return {
    id: 'agent-infra',
    name: 'agent-infra CLI',
    install: { type: 'npm', cmd: '@fitlab-ai/agent-infra@latest' },
    sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'agent-infra'),
    containerMount: '/home/devuser/.agent-infra-cli',
    versionCmd: 'ai version --raw',
    setupHint: 'Provides the ai and agent-infra CLI commands inside the sandbox.'
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function runtimeToolProjection(tool: SandboxTool): Readonly<Record<string, unknown>> {
  return stableValue({
    id: tool.id,
    install: tool.install,
    containerMount: tool.containerMount,
    versionCmd: tool.versionCmd,
    envVars: tool.envVars ?? {},
    hostPreSeedFiles: (tool.hostPreSeedFiles ?? []).map(({ sandboxName }) => ({ sandboxName })),
    hostPreSeedDirs: (tool.hostPreSeedDirs ?? []).map(({ sandboxSubdir }) => ({ sandboxSubdir })),
    pathRewriteFiles: tool.pathRewriteFiles ?? [],
    hostLiveMounts: (tool.hostLiveMounts ?? []).map(({ containerSubpath }) => ({ containerSubpath })),
    postSetupCmds: tool.postSetupCmds ?? [],
    tmpfs: tool.tmpfs ?? null
  }) as Readonly<Record<string, unknown>>;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function assertUniqueTools(tools: readonly SandboxTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.id)) {
      throw new Error(`Duplicate sandbox tool id "${tool.id}"`);
    }
    seen.add(tool.id);
  }
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function sandboxImageContribution(
  adapters: readonly AgentClientAdapter[],
  tools: readonly SandboxTool[]
): SandboxImageContribution {
  const homePrefix = '/home/devuser/';
  const derivedExclusions = tools.map((tool) => {
    if (!tool.containerMount.startsWith(homePrefix)) {
      throw new Error(
        `Agent Client '${tool.id}' container mount must be below ${homePrefix.slice(0, -1)}`
      );
    }
    return tool.containerMount.slice(homePrefix.length);
  });
  return Object.freeze({
    dockerfileFragments: unique(adapters.flatMap((adapter) =>
      adapter.sandbox.image?.dockerfileFragment
        ? [adapter.sandbox.image.dockerfileFragment]
        : []
    )),
    dotfilesExclusions: unique([
      ...derivedExclusions,
      ...adapters.flatMap((adapter) => adapter.sandbox.image?.dotfilesExclusions ?? [])
    ])
  });
}

function hooksByPhase(
  adapters: readonly AgentClientAdapter[]
): SandboxCapabilityPlan['hooksByPhase'] {
  const phases: SandboxHookPhase[] = [
    'prepare',
    'before-container-create',
    'after-container-start',
    'before-enter'
  ];
  return Object.freeze(Object.fromEntries(
    phases.map((phase) => [
      phase,
      Object.freeze(adapters.flatMap((adapter) =>
        adapter.sandbox.hooks.filter((hook) => hook.phase === phase)
      ))
    ])
  ) as Record<SandboxHookPhase, readonly AgentClientSandboxHook[]>);
}

function createSandboxCapabilityPlan(
  config: SandboxCapabilityConfig
): SandboxCapabilityPlan {
  const state = config.agentClientState;
  const selectedAgentClients = listInstalledAgentClientAdapters(state);
  const context = { home: config.home, project: config.project };
  const selectedTools = selectedAgentClients.map((adapter) =>
    adapter.sandbox.createTool(context)
  );
  const allClientTools = listAgentClientAdapters().map((adapter) =>
    adapter.sandbox.createTool(context)
  );
  const customById = new Map((config.customTools ?? []).map((tool) => [tool.id, tool]));
  if (customById.size !== (config.customTools ?? []).length) {
    throw new Error('Duplicate sandbox tool id in customTools');
  }
  for (const id of customById.keys()) {
    if (id === 'agent-infra' || isAgentClientId(id)) {
      throw new Error(`Custom sandbox tool id "${id}" collides with a built-in tool`);
    }
  }

  const nonClientTools: SandboxTool[] = [];
  const selectedCustomTools: SandboxTool[] = [];
  for (const id of config.tools) {
    if (isAgentClientId(id)) {
      throw new Error(`Agent Client '${id}' must be provided by agentClientState`);
    }
    if (id === 'agent-infra') {
      if (!nonClientTools.some((tool) => tool.id === id)) {
        nonClientTools.push(agentInfraTool(config.home));
      }
      continue;
    }
    const custom = customById.get(id);
    if (!custom) {
      throw new Error(`Unknown sandbox tool: ${id}`);
    }
    selectedCustomTools.push(custom);
  }

  const tools = Object.freeze([...nonClientTools, ...selectedTools, ...selectedCustomTools]);
  assertUniqueTools(tools);
  const image = sandboxImageContribution(selectedAgentClients, selectedTools);
  const phaseHooks = hooksByPhase(selectedAgentClients);
  const hookProjection = selectedAgentClients.flatMap((adapter) =>
    adapter.sandbox.hooks.map((hook) => ({
      adapterId: adapter.id,
      id: hook.id,
      phase: hook.phase,
      timeoutMs: hook.timeoutMs ?? DEFAULT_SANDBOX_HOOK_TIMEOUT_MS
    }))
  );
  const recoveryChecks = Object.freeze(selectedAgentClients.flatMap((adapter) =>
    (adapter.sandbox.recoveryChecks ?? []).map((check) => Object.freeze({
      adapterId: adapter.id,
      check
    }))
  ));
  const recoveryCheckProjection = Object.freeze(recoveryChecks.map(({ adapterId, check }) =>
    Object.freeze({
      adapterId,
      id: check.id,
      ...(check.when === undefined ? {} : { when: check.when }),
      probe: check.probe,
      finding: Object.freeze({
        repairKind: check.finding.repairKind,
        ...(check.finding.path === undefined ? {} : { path: check.finding.path })
      }),
      ...(check.repair === undefined ? {} : { repair: check.repair })
    })
  ));
  const runtimeProjection = Object.freeze({
    tools: Object.freeze(tools.map(runtimeToolProjection)),
    selectedAgentClients: Object.freeze(selectedAgentClients.map((adapter) => adapter.id)),
    hooks: Object.freeze(hookProjection),
    recoveryChecks: recoveryCheckProjection,
    image
  });
  const cleanupInventory = Object.freeze([
    agentInfraTool(config.home),
    ...allClientTools,
    ...customById.values()
  ]);
  assertUniqueTools(cleanupInventory);

  return Object.freeze({
    tools,
    selectedAgentClients,
    hooksByPhase: phaseHooks,
    recoveryChecks,
    aliases: Object.freeze(
      listAgentClientAdapters().flatMap((adapter) => adapter.sandbox.aliases)
    ),
    image,
    imageSignature: hash(tools.map(({ id, install }) => ({ id, install }))),
    runtimeSignature: hash(runtimeProjection),
    runtimeProjection,
    cleanupInventory
  });
}

function timeoutStatus(phase: SandboxHookPhase): SandboxHookStatus {
  if (phase === 'before-enter') return 'warning';
  return 'fatal';
}

async function runSandboxHooks({
  hooks,
  phase,
  context,
  runCommand = async () => {
    throw new Error('Sandbox hook command runner is unavailable');
  },
  scheduleTimeout = (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearScheduledTimeout = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}: {
  hooks: readonly AgentClientSandboxHook[];
  phase: SandboxHookPhase;
  context: Omit<AgentClientSandboxHookContext, 'signal' | 'runCommand'>;
  runCommand?: (
    command: SandboxHookCommand,
    options: { signal: AbortSignal; timeoutMs: number }
  ) => Promise<SandboxHookCommandResult>;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => TimerHandle;
  clearScheduledTimeout?: (handle: TimerHandle) => void;
}): Promise<HookExecutionResult[]> {
  const results: HookExecutionResult[] = [];
  for (const hook of hooks) {
    if (hook.phase !== phase) continue;
    const timeoutMs = hook.timeoutMs ?? DEFAULT_SANDBOX_HOOK_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let timer: TimerHandle;
    const timeout = new Promise<AgentClientSandboxHookResult>((resolve) => {
      timer = scheduleTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({
          status: timeoutStatus(phase),
          message: `Sandbox hook '${hook.id}' timed out after ${timeoutMs}ms.`
        });
      }, timeoutMs);
    });
    let result: AgentClientSandboxHookResult;
    try {
      const execution = Promise.resolve().then(() => hook.run({
        ...context,
        signal: controller.signal,
        runCommand: (command) => runCommand(command, {
          signal: controller.signal,
          timeoutMs
        })
      }));
      result = await Promise.race([execution, timeout]);
    } catch (error) {
      result = {
        status: timeoutStatus(phase),
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearScheduledTimeout(timer!);
    }
    results.push({
      hookId: hook.id,
      phase,
      status: result.status,
      ...(result.message ? { message: result.message } : {})
    });
    if (timedOut || result.status === 'fatal' || result.status === 'hard-failure') {
      break;
    }
  }
  return results;
}

function runBoundedSandboxHookCommand(
  command: SandboxHookCommand,
  options: { signal: AbortSignal; timeoutMs: number }
): Promise<SandboxHookCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      [...(command.args ?? [])],
      {
        cwd: command.cwd,
        env: command.env,
        encoding: 'utf8',
        signal: options.signal,
        timeout: options.timeoutMs
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout.trim() });
      }
    );
  });
}

export {
  DEFAULT_SANDBOX_HOOK_TIMEOUT_MS,
  createSandboxCapabilityPlan,
  runBoundedSandboxHookCommand,
  runSandboxHooks,
  sandboxImageContribution
};
export type {
  HookExecutionResult,
  SandboxCapabilityConfig,
  SandboxCapabilityPlan,
  SandboxImageContribution,
  PlannedAgentClientRecoveryCheck,
  SandboxRuntimeCapabilityProjection
};
