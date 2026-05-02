import { platform } from 'node:os';
import { detectHostResources } from './constants.js';
import { getAdapter } from './engines/index.js';
import { run, runOk, runSafe, runVerbose } from './shell.js';

export const ENGINES = Object.freeze({
  COLIMA: 'colima',
  ORBSTACK: 'orbstack',
  DOCKER_DESKTOP: 'docker-desktop',
  NATIVE: 'native',
  WSL2: 'wsl2'
});

const CONFIG_ENGINES = new Set([
  ENGINES.COLIMA,
  ENGINES.ORBSTACK,
  ENGINES.DOCKER_DESKTOP
]);

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

export function validateSandboxEngine(engine) {
  if (engine === null || engine === undefined) {
    return null;
  }

  if (CONFIG_ENGINES.has(engine)) {
    return engine;
  }

  throw new Error(
    `sandbox: invalid "sandbox.engine" value "${engine}". `
    + 'Expected one of: null, colima, orbstack, docker-desktop. '
    + 'This setting only affects macOS sandbox engine selection.'
  );
}

export function detectEngine(config = {}, { platformFn = platform } = {}) {
  const configured = validateSandboxEngine(config.engine);
  const os = platformFn();
  if (os === 'linux') {
    return ENGINES.NATIVE;
  }
  if (os === 'win32') {
    return ENGINES.WSL2;
  }
  if (os === 'darwin') {
    if (configured) {
      return configured;
    }

    return ENGINES.COLIMA;
  }
  return 'unsupported';
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
  const engine = detectEngine(config, dependencies);
  return isManagedEngine(engine);
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
