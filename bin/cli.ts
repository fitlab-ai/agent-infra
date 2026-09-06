#!/usr/bin/env node
import { VERSION } from '../lib/version.ts';
import {
  formatTaskViewDiagnostic,
  guardTaskOperation,
  TaskViewOperationError
} from '../lib/internal/task-operation-registry.ts';

// Node.js version check
const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 9)) {
  process.stderr.write(
    `agent-infra requires Node.js >= 22.9.0 (current: ${process.version})\n`
  );
  process.exit(1);
}

const USAGE = `agent-infra ${VERSION} - bootstrap AI collaboration infrastructure

Usage: ai <command> [options]

Commands:
  agent-client    List, status, enable, disable, or configure Agent Clients
  cp <ssh-alias>  Copy local clipboard image to a remote macOS clipboard or Linux sandbox over SSH
  data            Capture, verify, audit, repair, and export process data
  decide          Record a ruling; code-stage decisions require explicit implementation intent
  help            Show this help message
  init            Initialize a new project with update-agent-infra seed command
  merge           Merge tasks from another current workspace directory (active/blocked/completed/archive)
  run             Schedule a lifecycle skill in the task sandbox tmux session
  sandbox, s      Manage Docker-based AI sandboxes
  server          Run the local AI collaboration daemon (start/stop/status/logs)
  task, t         Read-only views of .agents/workspace tasks
  sync            Update seed files and sync file registry for an existing project
  update          Update the agent-infra CLI itself
  version         Show version

'ai' and 'agent-infra' are interchangeable; 'ai' is the shorter form.

Install methods:
  npm:   npm install -g @fitlab-ai/agent-infra
  npx:   npx @fitlab-ai/agent-infra init
  brew:  brew install fitlab-ai/tap/agent-infra  (macOS)
  curl:  curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh  (runs npm install -g internally)

Examples:
  cd my-project && ai init
  npx @fitlab-ai/agent-infra init
`;

const COMMAND_ALIASES: Record<string, string> = {
  s: 'sandbox',
  t: 'task'
};

const rawCommand = process.argv[2] || '';
const command = Object.hasOwn(COMMAND_ALIASES, rawCommand)
  ? COMMAND_ALIASES[rawCommand]
  : rawCommand;

let taskViewGuardFailed = false;
try {
  const guard = guardTaskOperation('public', command ?? '', process.argv.slice(3));
  if (guard.taskView && guard.descriptor.effect === 'diagnostic') {
    process.stderr.write(formatTaskViewDiagnostic(guard.taskView));
  }
} catch (error) {
  taskViewGuardFailed = true;
  if (error instanceof TaskViewOperationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function importCommand(importPath: string) {
  try {
    return await import(importPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      process.stderr.write(
        'Error: Missing npm dependency. Run npm install before using agent-infra from a development checkout.\n'
      );
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}

if (!taskViewGuardFailed) switch (command) {
  case 'agent-client': {
    const imported = await importCommand('../lib/agent-client.ts');
    if (!imported) break;
    const { cmdAgentClient } = imported;
    const code = await cmdAgentClient(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      return 1;
    });
    if (code) process.exitCode = code;
    break;
  }
  case 'cp': {
    const imported = await importCommand('../lib/cp.ts');
    if (!imported) break;
    const { cmdCp } = imported;
    const code = await cmdCp(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      return 1;
    });
    if (code) process.exitCode = code;
    break;
  }
  case 'data': {
    const imported = await importCommand('../lib/process-data/index.ts');
    if (!imported) break;
    const { cmdData } = imported;
    const code = await cmdData(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      return 1;
    });
    if (code) process.exitCode = code;
    break;
  }
  case 'decide': {
    const imported = await importCommand('../lib/decide.ts');
    if (!imported) break;
    const { cmdDecide } = imported;
    await cmdDecide(process.argv.slice(3));
    break;
  }
  case 'init': {
    const imported = await importCommand('../lib/init.ts');
    if (!imported) break;
    const { cmdInit } = imported;
    await cmdInit().catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'merge': {
    const imported = await importCommand('../lib/merge.ts');
    if (!imported) break;
    const { cmdMerge } = imported;
    await cmdMerge(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'run': {
    const imported = await importCommand('../lib/run/index.ts');
    if (!imported) break;
    const { cmdRun } = imported;
    await cmdRun(process.argv.slice(3));
    break;
  }
  case 'sandbox': {
    const imported = await importCommand('../lib/sandbox/index.ts');
    if (!imported) break;
    const { runSandbox } = imported;
    await runSandbox(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exit(1);
    });
    break;
  }
  case 'server': {
    const imported = await importCommand('../lib/server/index.ts');
    if (!imported) break;
    const { runServer } = imported;
    await runServer(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exit(1);
    });
    break;
  }
  case 'task': {
    const imported = await importCommand('../lib/task/index.ts');
    if (!imported) break;
    const { runTask } = imported;
    await runTask(process.argv.slice(3)).catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exit(1);
    });
    break;
  }
  case 'update': {
    const imported = await importCommand('../lib/self-update.ts');
    if (!imported) break;
    const { cmdUpdate } = imported;
    const code = await cmdUpdate().catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exitCode = 1;
      return 1;
    });
    if (code !== 0) process.exitCode = code;
    break;
  }
  case 'sync': {
    const imported = await importCommand('../lib/update.ts');
    if (!imported) break;
    const { cmdSync } = imported;
    await cmdSync().catch((e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'version': {
    if (process.argv[3] === '--raw') {
      console.log(VERSION);
    } else {
      console.log(`agent-infra ${VERSION}`);
    }
    break;
  }
  case '--version':
  case '-v': {
    console.log(`agent-infra ${VERSION}`);
    break;
  }
  case 'help':
  case '':
    process.stdout.write(USAGE);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n`);
    process.stdout.write(USAGE);
    process.exitCode = 1;
    break;
}
