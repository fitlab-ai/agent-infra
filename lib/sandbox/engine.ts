import { platform } from 'node:os';
import { detectHostResources } from './constants.ts';
import { ADAPTERS, enginesForPlatform, getAdapter } from './engines/index.ts';
import type { EffectiveSandboxConfig, OnMessage, RunFns, SandboxAdapter, SandboxVmConfig } from './engines/index.ts';
import { run, runOk, runOkEngine, runSafe, runVerbose } from './shell.ts';

export const ENGINES = Object.freeze({
  COLIMA: 'colima',
  ORBSTACK: 'orbstack',
  DOCKER_DESKTOP: 'docker-desktop',
  NATIVE: 'native',
  WSL2: 'wsl2'
});

const PLATFORM_DEFAULTS = Object.freeze({
  linux: ENGINES.NATIVE,
  darwin: ENGINES.COLIMA,
  win32: ENGINES.WSL2
});

export type SandboxEngineInput = string | Record<string, string | null | undefined> | null | undefined;

type EngineConfig = EffectiveSandboxConfig & {
  engine?: SandboxEngineInput;
};

function isPerPlatformEngine(engine: SandboxEngineInput): engine is Record<string, string | null | undefined> {
  return typeof engine === 'object' && engine !== null;
}

function resolveEngineForPlatform(engine: SandboxEngineInput, os: string): string | null | undefined {
  return isPerPlatformEngine(engine) ? engine[os] : engine;
}

type EngineDependencies = {
  platformFn?: typeof platform;
  runFn?: RunFns['run'];
  runOkFn?: RunFns['runOk'];
  runOkEngineFn?: typeof runOkEngine;
  runSafeFn?: RunFns['runSafe'];
  runVerboseFn?: RunFns['runVerbose'];
};

function runFns({
  runFn = run,
  runOkFn = runOk,
  runSafeFn = runSafe,
  runVerboseFn = runVerbose
}: EngineDependencies = {}): RunFns {
  return {
    run: runFn,
    runOk: runOkFn,
    runSafe: runSafeFn,
    runVerbose: runVerboseFn
  };
}

function applyDockerContext(adapter: SandboxAdapter): void {
  if (adapter.dockerContext) {
    process.env.DOCKER_CONTEXT = adapter.dockerContext;
  }
}

function buildKitError(engine: string): Error {
  let repair: string;
  switch (engine) {
    case ENGINES.COLIMA:
      repair = 'Install the Docker Buildx plugin with: brew install docker-buildx';
      break;
    case ENGINES.DOCKER_DESKTOP:
    case ENGINES.WSL2:
      repair = 'Upgrade or repair Docker Desktop so Docker Buildx and BuildKit are available.';
      break;
    case ENGINES.NATIVE:
      repair = 'Install the Docker Buildx plugin for your Docker Engine installation.';
      break;
    default:
      repair = `Upgrade or repair ${engineDisplayName(engine)} so Docker Buildx and BuildKit are available.`;
  }

  return new Error([
    `Docker BuildKit is not available for ${engineDisplayName(engine)}.`,
    repair,
    'Verify the builder with: docker buildx inspect --bootstrap',
    'Then retry the sandbox create or rebuild command.'
  ].join('\n'));
}

function ensureBuildKit(engine: string, runOkEngineFn: typeof runOkEngine): void {
  if (!runOkEngineFn(engine, 'docker', ['buildx', 'inspect', '--bootstrap'])) {
    throw buildKitError(engine);
  }
}

export function validateSandboxEngine(
  engine: SandboxEngineInput,
  { platformFn = platform }: Pick<EngineDependencies, 'platformFn'> = {}
): string | null {
  const os = platformFn();
  const resolved = resolveEngineForPlatform(engine, os);
  if (resolved === null || resolved === undefined) {
    return null;
  }

  if (!(resolved in ADAPTERS)) {
    const known = Object.keys(ADAPTERS).join(', ');
    throw new Error(
      `sandbox: invalid "sandbox.engine" value "${resolved}" (unknown sandbox engine). `
      + `Valid engines: ${known}.`
    );
  }

  const adapter = ADAPTERS[resolved as keyof typeof ADAPTERS];
  if (!adapter.supportedPlatforms.includes(os)) {
    const supported = enginesForPlatform(os);
    const supportedList = supported.length > 0 ? supported.join(', ') : 'none';
    throw new Error(
      `sandbox: "sandbox.engine" value "${resolved}" is not supported on ${os}. `
      + `Supported engines on ${os}: ${supportedList}.`
    );
  }

  return resolved;
}

export function detectEngine(
  config: EngineConfig = {},
  { platformFn = platform }: Pick<EngineDependencies, 'platformFn'> = {}
): string {
  const configured = validateSandboxEngine(config.engine, { platformFn });
  if (configured) {
    return configured;
  }

  const os = platformFn();
  const fallback = PLATFORM_DEFAULTS[os as keyof typeof PLATFORM_DEFAULTS];
  if (fallback) {
    return fallback;
  }

  throw new Error(
    `sandbox: platform "${os}" is not supported. `
    + 'Supported platforms: linux (native), darwin (colima/orbstack/docker-desktop), win32 (wsl2). '
    + 'Please open an issue at https://github.com/fitlab-ai/agent-infra/issues/new '
    + 'with your platform details if you need this added.'
  );
}

export function hasUserVmConfig(vm: SandboxVmConfig = {}): boolean {
  return vm.cpu != null || vm.memory != null || vm.disk != null;
}

export function resolveEffectiveVm(
  adapter: SandboxAdapter,
  userVm: SandboxVmConfig = {},
  { detectHostResourcesFn = detectHostResources }: { detectHostResourcesFn?: typeof detectHostResources } = {}
): SandboxVmConfig {
  let host: ReturnType<typeof detectHostResources> | null = null;
  const getHost = () => {
    host ??= detectHostResourcesFn();
    return host;
  };
  const defaults = adapter.defaultResources?.(getHost) ?? {};

  return {
    cpu: userVm.cpu ?? defaults.cpu ?? null,
    memory: userVm.memory ?? defaults.memory ?? null,
    disk: userVm.disk ?? defaults.disk ?? null
  };
}

function effectiveConfigFor(adapter: SandboxAdapter, config: EngineConfig): EffectiveSandboxConfig {
  const userVm = config.vm ?? {};
  return {
    ...config,
    userVm,
    hasUserVmConfig,
    vm: resolveEffectiveVm(adapter, userVm)
  };
}

export async function ensureDocker(
  config: EngineConfig,
  onMessage: OnMessage,
  dependencies: EngineDependencies = {}
): Promise<void> {
  const engine = detectEngine(config, dependencies);
  const adapter = getAdapter(engine);
  const effectiveConfig = effectiveConfigFor(adapter, config);
  const fns = runFns(dependencies);

  applyDockerContext(adapter);
  const vmJustStarted = await adapter.ensure(effectiveConfig, onMessage, fns);
  ensureBuildKit(engine, dependencies.runOkEngineFn ?? runOkEngine);
  adapter.syncResources(effectiveConfig, onMessage, fns, { vmJustStarted });
}

export function isVmManaged(config: EngineConfig = {}, dependencies: EngineDependencies = {}): boolean {
  try {
    const engine = detectEngine(config, dependencies);
    return isManagedEngine(engine);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      message.startsWith('sandbox: platform "')
      || / is not supported on [^.]+\. Supported engines on [^:]+: none\./.test(message)
    ) {
      return false;
    }

    throw error;
  }
}

export function isManagedEngine(engine: string): boolean {
  try {
    return getAdapter(engine).managed;
  } catch {
    return false;
  }
}

export function engineDisplayName(engine: string): string {
  try {
    return getAdapter(engine).displayName;
  } catch {
    return engine;
  }
}

export function startManagedVm(
  config: EngineConfig,
  { platformFn = platform, runOkFn = runOk, runSafeFn = runSafe, runVerboseFn = runVerbose, onMessage }: EngineDependencies & { onMessage?: OnMessage } = {}
): 'already-running' | 'started' {
  const engine = detectEngine(config, { platformFn });
  const adapter = getAdapter(engine);
  if (!adapter.managed) {
    throw new Error(`VM management is unavailable for engine '${adapter.displayName}'.`);
  }

  const effectiveConfig = effectiveConfigFor(adapter, config);
  applyDockerContext(adapter);
  if (!adapter.startVm) {
    throw new Error(`VM management is unavailable for engine '${adapter.displayName}'.`);
  }
  const result = adapter.startVm(
    effectiveConfig,
    onMessage,
    runFns({ runOkFn, runSafeFn, runVerboseFn })
  );
  adapter.syncResources(
    effectiveConfig,
    onMessage,
    runFns({ runOkFn, runSafeFn, runVerboseFn }),
    { vmJustStarted: result === 'started' }
  );
  return result;
}

export function stopManagedVm(
  config: EngineConfig,
  { platformFn = platform, runFn = run }: Pick<EngineDependencies, 'platformFn' | 'runFn'> = {}
): 'stopped' {
  const engine = detectEngine(config, { platformFn });
  const adapter = getAdapter(engine);
  if (!adapter.managed) {
    throw new Error(`VM management is unavailable for engine '${adapter.displayName}'.`);
  }
  if (!adapter.stopVm) {
    throw new Error(`VM management is unavailable for engine '${adapter.displayName}'.`);
  }

  // Stop commands do not read Docker context or VM resource values; keep the
  // previous environment unchanged and pass the original config intentionally.
  return adapter.stopVm(config, null, runFns({ runFn }));
}
