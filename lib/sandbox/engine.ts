// @ts-nocheck
import { platform } from 'node:os';
import { detectHostResources } from './constants.ts';
import { ADAPTERS, enginesForPlatform, getAdapter } from './engines/index.ts';
import { run, runOk, runSafe, runVerbose } from './shell.ts';

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

function runFns({
  runFn = run,
  runOkFn = runOk,
  runSafeFn = runSafe,
  runVerboseFn = runVerbose
} = {}) {
  return {
    run: runFn,
    runOk: runOkFn,
    runSafe: runSafeFn,
    runVerbose: runVerboseFn
  };
}

function applyDockerContext(adapter) {
  if (adapter.dockerContext) {
    process.env.DOCKER_CONTEXT = adapter.dockerContext;
  }
}

export function validateSandboxEngine(engine, { platformFn = platform } = {}) {
  if (engine === null || engine === undefined) {
    return null;
  }

  const os = platformFn();
  if (!(engine in ADAPTERS)) {
    const known = Object.keys(ADAPTERS).join(', ');
    throw new Error(
      `sandbox: invalid "sandbox.engine" value "${engine}" (unknown sandbox engine). `
      + `Valid engines: ${known}.`
    );
  }

  const adapter = ADAPTERS[engine];
  if (!adapter.supportedPlatforms.includes(os)) {
    const supported = enginesForPlatform(os);
    const supportedList = supported.length > 0 ? supported.join(', ') : 'none';
    throw new Error(
      `sandbox: "sandbox.engine" value "${engine}" is not supported on ${os}. `
      + `Supported engines on ${os}: ${supportedList}.`
    );
  }

  return engine;
}

export function detectEngine(config = {}, { platformFn = platform } = {}) {
  const configured = validateSandboxEngine(config.engine, { platformFn });
  if (configured) {
    return configured;
  }

  const os = platformFn();
  const fallback = PLATFORM_DEFAULTS[os];
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

export function hasUserVmConfig(vm = {}) {
  return vm.cpu != null || vm.memory != null || vm.disk != null;
}

export function resolveEffectiveVm(
  adapter,
  userVm = {},
  { detectHostResourcesFn = detectHostResources } = {}
) {
  let host = null;
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

function effectiveConfigFor(adapter, config) {
  const userVm = config.vm ?? {};
  return {
    ...config,
    userVm,
    hasUserVmConfig,
    vm: resolveEffectiveVm(adapter, userVm)
  };
}

export async function ensureDocker(config, onMessage, dependencies = {}) {
  const engine = detectEngine(config, dependencies);
  const adapter = getAdapter(engine);
  const effectiveConfig = effectiveConfigFor(adapter, config);

  applyDockerContext(adapter);
  const vmJustStarted = await adapter.ensure(effectiveConfig, onMessage, runFns(dependencies));
  adapter.syncResources(effectiveConfig, onMessage, runFns(dependencies), { vmJustStarted });
}

export function isVmManaged(config = {}, dependencies = {}) {
  try {
    const engine = detectEngine(config, dependencies);
    return isManagedEngine(engine);
  } catch (error) {
    const message = error?.message ?? '';
    if (
      message.startsWith('sandbox: platform "')
      || / is not supported on [^.]+\. Supported engines on [^:]+: none\./.test(message)
    ) {
      return false;
    }

    throw error;
  }
}

export function isManagedEngine(engine) {
  try {
    return getAdapter(engine).managed;
  } catch {
    return false;
  }
}

export function engineDisplayName(engine) {
  try {
    return getAdapter(engine).displayName;
  } catch {
    return engine;
  }
}

export function startManagedVm(
  config,
  { platformFn = platform, runOkFn = runOk, runSafeFn = runSafe, runVerboseFn = runVerbose, onMessage } = {}
) {
  const engine = detectEngine(config, { platformFn });
  const adapter = getAdapter(engine);
  if (!adapter.managed) {
    throw new Error(`VM management is unavailable for engine '${adapter.displayName}'.`);
  }

  const effectiveConfig = effectiveConfigFor(adapter, config);
  applyDockerContext(adapter);
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

export function stopManagedVm(config, { platformFn = platform, runFn = run } = {}) {
  const engine = detectEngine(config, { platformFn });
  const adapter = getAdapter(engine);
  if (!adapter.managed) {
    throw new Error(`VM management is unavailable for engine '${adapter.displayName}'.`);
  }

  // Stop commands do not read Docker context or VM resource values; keep the
  // previous environment unchanged and pass the original config intentionally.
  return adapter.stopVm(config, null, runFns({ runFn }));
}
