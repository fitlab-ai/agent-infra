import { platform } from 'node:os';
import { detectHostResources } from './constants.js';
import { run, runOk, runSafe, runVerbose } from './shell.js';

export const ENGINES = Object.freeze({
  COLIMA: 'colima',
  ORBSTACK: 'orbstack',
  DOCKER_DESKTOP: 'docker-desktop'
});

export const ENGINE_DOCKER_CONTEXT = Object.freeze({
  [ENGINES.COLIMA]: 'colima',
  [ENGINES.ORBSTACK]: 'orbstack',
  [ENGINES.DOCKER_DESKTOP]: 'desktop-linux'
});

const VALID_CONFIG_ENGINES = new Set(Object.values(ENGINES));

function applyDockerContext(engine) {
  const context = ENGINE_DOCKER_CONTEXT[engine];
  if (context) {
    process.env.DOCKER_CONTEXT = context;
  }
}

export function validateSandboxEngine(engine) {
  if (engine === null || engine === undefined) {
    return null;
  }

  if (VALID_CONFIG_ENGINES.has(engine)) {
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
    return 'native';
  }
  if (os === 'win32') {
    return 'wsl2';
  }
  if (os === 'darwin') {
    if (configured) {
      return configured;
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
  applyDockerContext(ENGINES.COLIMA);

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
  applyDockerContext(ENGINES.ORBSTACK);

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
  applyDockerContext(ENGINES.DOCKER_DESKTOP);

  if (!runOkFn('docker', ['info'])) {
    throw new Error('Docker Desktop is not running. Please start Docker Desktop manually.');
  }
}

export async function ensureNativeDocker(
  _config,
  _onMessage,
  { runOkFn = runOk, runSafeFn = runSafe } = {}
) {
  if (!runOkFn('which', ['docker'])) {
    throw new Error([
      'Docker is not installed.',
      'Install Docker Engine for your distribution: https://docs.docker.com/engine/install/',
      'Then start the daemon with: sudo systemctl enable --now docker',
      'If you want to run Docker without sudo, add your user to the docker group: sudo usermod -aG docker $USER'
    ].join('\n'));
  }

  if (runOkFn('docker', ['info'])) {
    return;
  }

  const serverVersion = runSafeFn('docker', ['version', '--format', '{{.Server.Version}}']);
  if (!serverVersion) {
    throw new Error([
      'Docker daemon is not running or is unreachable.',
      'Start it with: sudo systemctl start docker',
      'Enable it on boot with: sudo systemctl enable docker',
      'If you use rootless or remote Docker, verify DOCKER_HOST points at a reachable socket.',
      'Then retry: ai sandbox create <branch>'
    ].join('\n'));
  }

  throw new Error([
    'Docker is installed, but the current user may lack permission to use the daemon.',
    'Add your user to the docker group: sudo usermod -aG docker $USER',
    'Open a new login shell or run: newgrp docker',
    'For rootless Docker, make sure DOCKER_HOST points at the rootless daemon socket.'
  ].join('\n'));
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
    await ensureNativeDocker(config, onMessage);
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
  const engine = detectEngine(config, { platformFn });
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

export function stopManagedVm(config, { platformFn = platform, runFn = run } = {}) {
  const engine = detectEngine(config, { platformFn });
  if (engine === ENGINES.COLIMA) {
    runFn('colima', ['stop']);
    return 'stopped';
  } else if (engine === ENGINES.ORBSTACK) {
    runFn('orb', ['stop']);
    return 'stopped';
  }
  throw new Error(`VM management is unavailable for engine '${engineDisplayName(engine)}'.`);
}
