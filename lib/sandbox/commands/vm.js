import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { parsePositiveIntegerOption } from '../constants.js';
import {
  ENGINES,
  detectEngine,
  engineDisplayName,
  ensureDocker,
  isManagedEngine,
  startManagedVm,
  stopManagedVm
} from '../engine.js';
import { runOk, runSafe } from '../shell.js';

const USAGE = `Usage: ai sandbox vm <status|start|stop> [--cpu <n>] [--memory <n>]`;

export function ensureManagedVm(engine) {
  if (engine === ENGINES.NATIVE) {
    throw new Error(
      "Linux native Docker does not use a managed VM. Use 'ai sandbox create' directly."
    );
  }

  if (!isManagedEngine(engine)) {
    throw new Error(
      `VM management is unavailable for engine '${engineDisplayName(engine)}'. `
      + (engine === ENGINES.DOCKER_DESKTOP
        ? 'Docker Desktop is managed via its GUI (Settings -> Resources).'
        : '')
    );
  }
}

export function wsl2BackendStatus({ runOkFn = runOk } = {}) {
  const wslAvailable = runOkFn('wsl.exe', ['--status']) || runOkFn('wsl.exe', ['--', 'true']);
  const dockerAvailable = wslAvailable && runOkFn('wsl.exe', ['--', 'docker', 'info']);

  return { wslAvailable, dockerAvailable };
}

function status() {
  const config = loadConfig();
  const engine = detectEngine(config);
  const name = engineDisplayName(engine);
  ensureManagedVm(engine);
  p.intro(pc.cyan('Sandbox VM status'));

  if (engine === ENGINES.WSL2) {
    const backend = wsl2BackendStatus();
    if (backend.wslAvailable) {
      p.log.info('WSL2 is available');
    } else {
      p.log.warn('WSL2 is not available. Install WSL2 and configure a default Linux distribution.');
    }

    if (backend.dockerAvailable) {
      p.log.info('Docker Desktop WSL integration is available');
    } else {
      p.log.warn('Docker is not available inside WSL2. Start Docker Desktop and enable WSL integration.');
    }
    return;
  }

  if (engine === ENGINES.COLIMA) {
    if (runOk('colima', ['status'])) {
      process.stdout.write(`${runSafe('colima', ['status'])}\n`);
    } else {
      p.log.warn('Colima VM is not running');
    }
    return;
  }

  if (!runOk('orb', ['status'])) {
    p.log.warn(`${name} VM is not running`);
    return;
  }

  process.stdout.write(`${runSafe('orb', ['status'])}\n`);
}

async function start(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      cpu: { type: 'string' },
      memory: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const engine = detectEngine(config);
  ensureManagedVm(engine);
  const effectiveConfig = {
    ...config,
    vm: {
      ...config.vm,
      cpu: parsePositiveIntegerOption(values.cpu, '--cpu') ?? config.vm.cpu,
      memory: parsePositiveIntegerOption(values.memory, '--memory') ?? config.vm.memory
    }
  };

  p.intro(pc.cyan('Starting sandbox VM'));
  const onMessage = (detail) => {
    p.log.info(detail);
  };

  if (engine === ENGINES.WSL2) {
    await ensureDocker(effectiveConfig, onMessage);
    p.outro(pc.green('WSL2 Docker backend ready'));
    return;
  }

  startManagedVm(effectiveConfig, { onMessage });
  p.outro(pc.green('VM ready'));
}

function stop() {
  const config = loadConfig();
  const engine = detectEngine(config);
  const name = engineDisplayName(engine);
  ensureManagedVm(engine);
  p.intro(pc.cyan('Stopping sandbox VM'));

  if (engine === ENGINES.WSL2) {
    p.log.warn('Windows uses Docker Desktop with WSL2. Stop it from Docker Desktop or run "wsl --shutdown" manually.');
    return;
  }

  if (engine === ENGINES.COLIMA && !runOk('colima', ['status'])) {
    p.log.warn(`${name} VM is not running`);
    return;
  }
  if (engine === ENGINES.ORBSTACK && !runOk('orb', ['status'])) {
    p.log.warn(`${name} VM is not running`);
    return;
  }

  stopManagedVm(config);
  p.outro(pc.green('VM stopped'));
}

export async function vm(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (!subcommand) {
      process.exitCode = 1;
    }
    return;
  }

  switch (subcommand) {
    case 'status':
      status();
      break;
    case 'start':
      await start(rest);
      break;
    case 'stop':
      stop();
      break;
    default:
      throw new Error(USAGE);
  }
}
