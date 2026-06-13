#!/usr/bin/env node
import { VERSION } from '../lib/version.ts';

// Node.js version check
const [major = 0] = process.versions.node.split('.').map((part) => parseInt(part, 10));
if (major < 22) {
  process.stderr.write(
    `agent-infra requires Node.js >= 22 (current: ${process.version})\n`
  );
  process.exit(1);
}

const USAGE = `agent-infra ${VERSION} - bootstrap AI collaboration infrastructure

Usage:
  agent-infra cp <ssh-alias>  Copy local clipboard image to a remote macOS NSPasteboard
  agent-infra help            Show this help message
  agent-infra init            Initialize a new project with update-agent-infra seed command
  agent-infra merge           Merge tasks from another workspace directory (active/blocked/completed/archive)
  agent-infra sandbox         Manage Docker-based AI sandboxes
  agent-infra task            Read-only views over .agents/workspace tasks (ls / show)
  agent-infra update          Update seed files and sync file registry for an existing project
  agent-infra version         Show version

Shorthand: ai (e.g. ai init)

Install methods:
  npm:   npm install -g @fitlab-ai/agent-infra
  npx:   npx @fitlab-ai/agent-infra init
  brew:  brew install fitlab-ai/tap/agent-infra  (macOS)
  curl:  curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh  (runs npm install -g internally)

Examples:
  cd my-project && agent-infra init
  npx @fitlab-ai/agent-infra init
`;

const command = process.argv[2] || '';

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

switch (command) {
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
  case 'update': {
    const imported = await importCommand('../lib/update.ts');
    if (!imported) break;
    const { cmdUpdate } = imported;
    await cmdUpdate().catch((e: unknown) => {
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
