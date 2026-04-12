import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { parsePositiveIntegerOption } from '../constants.js';
import { detectEngine, ensureDocker, isVmManaged } from '../engine.js';
import { run, runOk, runSafe } from '../shell.js';

const USAGE = `Usage: ai sandbox vm <status|start|stop> [--cpu <n>] [--memory <n>]`;

function ensureManagedVm() {
  if (!isVmManaged()) {
    if (detectEngine() === 'wsl2') {
      throw new Error('VM management is unavailable on Windows. Use Docker Desktop and WSL tools to manage the WSL2 backend.');
    }
    throw new Error(`VM management is unavailable on ${detectEngine()}.`);
  }
}

function status() {
  ensureManagedVm();
  p.intro(pc.cyan('Sandbox VM status'));

  if (runOk('colima', ['status'])) {
    process.stdout.write(`${runSafe('colima', ['status'])}\n`);
  } else {
    p.log.warn('Colima VM is not running');
  }
}

async function start(args) {
  ensureManagedVm();

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
  await ensureDocker(effectiveConfig, (detail) => {
    p.log.info(detail);
  });
  p.outro(pc.green('VM ready'));
}

function stop() {
  ensureManagedVm();
  p.intro(pc.cyan('Stopping sandbox VM'));

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
