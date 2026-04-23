import { platform } from 'node:os';
import { detectHostResources } from './constants.js';
import { run, runOk, runSafe, runVerbose } from './shell.js';

export const ENGINES = Object.freeze({
  COLIMA: 'colima',
  ORBSTACK: 'orbstack',
  DOCKER_DESKTOP: 'docker-desktop'
});

const VALID_CONFIG_ENGINES = new Set(['auto', ...Object.values(ENGINES)]);

export function validateSandboxEngine(engine) {
  if (engine === null || engine === undefined) {
    return null;
  }

  if (VALID_CONFIG_ENGINES.has(engine)) {
    return engine;
  }

  throw new Error(
    `sandbox: invalid "sandbox.engine" value "${engine}". `
    + 'Expected one of: null, auto, colima, orbstack, docker-desktop. '
    + 'This setting only affects macOS sandbox engine selection.'
  );
}

export function detectEngine(config = {}, { platformFn = platform, runOkFn = runOk } = {}) {
  const configured = validateSandboxEngine(config.engine);
  const os = platformFn();
  if (os === 'linux') {
    return 'native';
  }
  if (os === 'win32') {
    return 'wsl2';
  }
  if (os === 'darwin') {
    if (configured && configured !== 'auto') {
      return configured;
    }

    if (runOkFn('docker', ['info'])) {
      return ENGINES.DOCKER_DESKTOP;
    }

    return ENGINES.COLIMA;
  }
  return 'unsupported';
}

function colimaArgs(config, runSafeFn = runSafe) {
  const arch = runSafeFn('uname', ['-m']);
  const defaults = detectHostResources();
  const vm = config.vm ?? {};
  const cpu = vm.cpu ?? defaults.cpu;
  const memory = vm.memory ?? defaults.memory;
  const disk = vm.disk ?? 60;
  const args = ['start', '--cpu', String(cpu), '--memory', String(memory), '--disk', String(disk)];

  if (arch === 'arm64') {
    args.push('--arch', 'aarch64', '--vm-type=vz', '--mount-type=virtiofs');
  } else {
    args.push('--arch', 'x86_64');
  }

  return args;
}

export async function ensureColima(
  config,
  onMessage,
  { runOkFn = runOk, runSafeFn = runSafe, runVerboseFn = runVerbose } = {}
) {
  if (!runOkFn('which', ['colima'])) {
    onMessage?.('Installing colima + docker via Homebrew...');
    runVerboseFn('brew', ['install', 'colima', 'docker']);
  }

  if (!runOkFn('colima', ['status'])) {
    onMessage?.('Starting Colima VM...');
    runVerboseFn('colima', colimaArgs(config, runSafeFn));
  }

  if (!runOkFn('docker', ['info'])) {
    throw new Error('Docker daemon is not available after starting Colima');
  }
}

export async function ensureOrbStack(
  _config,
  onMessage,
  { runOkFn = runOk, runVerboseFn = runVerbose } = {}
) {
  if (!runOkFn('which', ['orb'])) {
    onMessage?.('Installing OrbStack via Homebrew...');
    runVerboseFn('brew', ['install', '--cask', 'orbstack']);
  }

  if (!runOkFn('docker', ['info'])) {
    onMessage?.('Starting OrbStack...');
    runVerboseFn('orb', ['start']);
  }

  if (!runOkFn('docker', ['info'])) {
    throw new Error('Docker daemon is not available after starting OrbStack');
  }
}

export async function ensureDockerDesktop(
  _config,
  onMessage,
  { runOkFn = runOk } = {}
) {
  if (!runOkFn('docker', ['info'])) {
    throw new Error('Docker Desktop is not running. Please start Docker Desktop manually.');
  }
}

export async function ensureDocker(config, onMessage) {
  const engine = detectEngine(config);

  if (engine === ENGINES.COLIMA) {
    await ensureColima(config, onMessage);
    return;
  }

  if (engine === ENGINES.ORBSTACK) {
    await ensureOrbStack(config, onMessage);
    return;
  }

  if (engine === ENGINES.DOCKER_DESKTOP) {
    await ensureDockerDesktop(config, onMessage);
    return;
  }

  if (engine === 'native') {
    if (!runOk('docker', ['info'])) {
      throw new Error('Docker daemon is not running. Please start Docker first.');
    }
    return;
  }

  if (engine === 'wsl2') {
    throw new Error('Windows sandbox support is reserved for a future WSL2 implementation.');
  }

  throw new Error(`Unsupported sandbox engine: ${engine}`);
}

export function isVmManaged(config = {}, dependencies = {}) {
  const engine = detectEngine(config, dependencies);
  return isManagedEngine(engine);
}

export function isManagedEngine(engine) {
  return engine === ENGINES.COLIMA || engine === ENGINES.ORBSTACK;
}

export function engineDisplayName(engine) {
  const names = {
    [ENGINES.COLIMA]: 'Colima',
    [ENGINES.ORBSTACK]: 'OrbStack',
    [ENGINES.DOCKER_DESKTOP]: 'Docker Desktop',
    native: 'native Docker',
    wsl2: 'WSL2'
  };
  return names[engine] ?? engine;
}

export function startManagedVm(
  config,
  { platformFn = platform, runOkFn = runOk, runVerboseFn = runVerbose } = {}
) {
  const engine = detectEngine(config, { platformFn, runOkFn });
  if (!isManagedEngine(engine)) {
    throw new Error(`VM management is unavailable for engine '${engineDisplayName(engine)}'.`);
  }

  if (engine === ENGINES.COLIMA && runOkFn('colima', ['status'])) {
    return 'already-running';
  }
  if (engine === ENGINES.ORBSTACK && runOkFn('orb', ['status'])) {
    return 'already-running';
  }

  if (engine === ENGINES.COLIMA) {
    runVerboseFn('colima', colimaArgs(config));
  } else if (engine === ENGINES.ORBSTACK) {
    runVerboseFn('orb', ['start']);
  }
  return 'started';
}

export function stopManagedVm(config, { platformFn = platform, runOkFn = runOk, runFn = run } = {}) {
  const engine = detectEngine(config, { platformFn, runOkFn });
  if (engine === ENGINES.COLIMA) {
    runFn('colima', ['stop']);
    return 'stopped';
  } else if (engine === ENGINES.ORBSTACK) {
    runFn('orb', ['stop']);
    return 'stopped';
  }
  throw new Error(`VM management is unavailable for engine '${engineDisplayName(engine)}'.`);
}
