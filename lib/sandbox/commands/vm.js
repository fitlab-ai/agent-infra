import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { parsePositiveIntegerOption } from '../constants.js';
import { detectEngine, ensureDocker, ensureWsl2Docker } from '../engine.js';
import { run, runOk, runOkEngine, runSafe } from '../shell.js';

const USAGE = `Usage: ai sandbox vm <status|start|stop> [--cpu <n>] [--memory <n>]`;

export function wsl2BackendStatus({ runOkFn = runOk, runOkEngineFn = runOkEngine } = {}) {
  const wslAvailable = runOkFn('wsl.exe', ['--status']) || runOkFn('wsl.exe', ['--', 'true']);
  const dockerAvailable = wslAvailable && runOkEngineFn('wsl2', 'docker', ['info']);

  return { wslAvailable, dockerAvailable };
}

function ensureManagedVm(engine) {
  if (engine !== 'colima' && engine !== 'wsl2') {
    throw new Error(`VM management is unavailable on ${engine}.`);
  }
}

function status() {
  const engine = detectEngine();
  ensureManagedVm(engine);
  p.intro(pc.cyan('Sandbox VM status'));

  if (engine === 'wsl2') {
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

  if (runOk('colima', ['status'])) {
    process.stdout.write(`${runSafe('colima', ['status'])}\n`);
  } else {
    p.log.warn('Colima VM is not running');
  }
}

async function start(args) {
  const engine = detectEngine();
  ensureManagedVm(engine);

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
  const effectiveConfig = {
    ...config,
    vm: {
      ...config.vm,
      cpu: parsePositiveIntegerOption(values.cpu, '--cpu') ?? config.vm.cpu,
      memory: parsePositiveIntegerOption(values.memory, '--memory') ?? config.vm.memory
    }
  };

  p.intro(pc.cyan('Starting sandbox VM'));
  if (engine === 'wsl2') {
    await ensureWsl2Docker(effectiveConfig, (detail) => {
      p.log.info(detail);
    });
    p.outro(pc.green('WSL2 Docker backend ready'));
    return;
  }

  await ensureDocker(effectiveConfig, (detail) => {
    p.log.info(detail);
  });
  p.outro(pc.green('VM ready'));
}

function stop() {
  const engine = detectEngine();
  ensureManagedVm(engine);
  p.intro(pc.cyan('Stopping sandbox VM'));

  if (engine === 'wsl2') {
    p.log.warn('Windows uses Docker Desktop with WSL2. Stop it from Docker Desktop or run "wsl --shutdown" manually.');
    return;
  }

  if (!runOk('colima', ['status'])) {
    p.log.warn('Colima VM is not running');
    return;
  }

  run('colima', ['stop']);
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
