import { platform } from 'node:os';
import { detectHostResources } from './constants.js';
import { run, runOk, runSafe } from './shell.js';

export function detectEngine() {
  const os = platform();
  if (os === 'darwin') {
    return 'colima';
  }
  if (os === 'linux') {
    return 'native';
  }
  if (os === 'win32') {
    return 'wsl2';
  }
  return 'unsupported';
}

function colimaArgs(config) {
  const arch = runSafe('uname', ['-m']);
  const defaults = detectHostResources();
  const cpu = config.vm.cpu ?? defaults.cpu;
  const memory = config.vm.memory ?? defaults.memory;
  const disk = config.vm.disk ?? 60;
  const args = ['start', '--cpu', String(cpu), '--memory', String(memory), '--disk', String(disk)];

  if (arch === 'arm64') {
    args.push('--arch', 'aarch64', '--vm-type=vz', '--mount-type=virtiofs');
  } else {
    args.push('--arch', 'x86_64');
  }

  return args;
}

async function ensureColima(config, onMessage) {
  if (!runOk('which', ['colima'])) {
    onMessage?.('Installing colima + docker via Homebrew...');
    run('brew', ['install', 'colima', 'docker']);
  }

  if (!runOk('colima', ['status'])) {
    onMessage?.('Starting Colima VM...');
    run('colima', colimaArgs(config));
  }

  if (!runOk('docker', ['info'])) {
    throw new Error('Docker daemon is not available after starting Colima');
  }
}

export async function ensureDocker(config, onMessage) {
  const engine = detectEngine();

  if (engine === 'colima') {
    await ensureColima(config, onMessage);
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

export function isVmManaged() {
  return detectEngine() === 'colima';
}

export function startManagedVm(config) {
  if (!isVmManaged()) {
    throw new Error('VM management is only available on macOS with Colima.');
  }

  if (runOk('colima', ['status'])) {
    return 'already-running';
  }

  run('colima', colimaArgs(config));
  return 'started';
}
