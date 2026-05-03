#!/usr/bin/env node
import { VERSION } from '../lib/version.js';

// Node.js version check
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  process.stderr.write(
    `agent-infra requires Node.js >= 22 (current: ${process.version})\n`
  );
  process.exit(1);
}

const USAGE = `agent-infra - bootstrap AI collaboration infrastructure

Usage:
  agent-infra init        Initialize a new project with update-agent-infra seed command
  agent-infra merge       Merge tasks from another workspace directory (active/blocked/completed/archive)
  agent-infra update      Update seed files and sync file registry for an existing project
  agent-infra sandbox     Manage Docker-based AI sandboxes
  agent-infra version     Show version
  agent-infra help        Show this help message

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

async function importCommand(importPath) {
  try {
    return await import(importPath);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      process.stderr.write(
        'Error: Missing npm dependency. Run npm install before using agent-infra from a development checkout.\n'
      );
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}

switch (command) {
  case 'init': {
    const imported = await importCommand('../lib/init.js');
    if (!imported) break;
    const { cmdInit } = imported;
    await cmdInit().catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'update': {
    const imported = await importCommand('../lib/update.js');
    if (!imported) break;
    const { cmdUpdate } = imported;
    await cmdUpdate().catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'merge': {
    const imported = await importCommand('../lib/merge.js');
    if (!imported) break;
    const { cmdMerge } = imported;
    await cmdMerge(process.argv.slice(3)).catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'sandbox': {
    const imported = await importCommand('../lib/sandbox/index.js');
    if (!imported) break;
    const { runSandbox } = imported;
    await runSandbox(process.argv.slice(3)).catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'version': {
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
