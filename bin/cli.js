#!/usr/bin/env node
import { VERSION } from '../lib/version.js';

// Node.js version check
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  process.stderr.write(
    `agent-infra requires Node.js >= 18 (current: ${process.version})\n`
  );
  process.exit(1);
}

const USAGE = `agent-infra - bootstrap AI collaboration infrastructure

Usage:
  agent-infra init        Initialize a new project with update-agent-infra seed command
  agent-infra update      Update seed files and sync file registry for an existing project
  agent-infra sandbox     Manage Docker-based AI sandboxes
  agent-infra version     Show version
  agent-infra help        Show this help message

Shorthand: ai (e.g. ai init)

Install methods:
  npm:   npm install -g @fitlab-ai/agent-infra
  npx:   npx @fitlab-ai/agent-infra init
  curl:  curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh  (runs npm install -g internally)

Examples:
  cd my-project && agent-infra init
  npx @fitlab-ai/agent-infra init
`;

const command = process.argv[2] || '';

switch (command) {
  case 'init': {
    const { cmdInit } = await import('../lib/init.js');
    await cmdInit().catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'update': {
    const { cmdUpdate } = await import('../lib/update.js');
    await cmdUpdate().catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exitCode = 1;
    });
    break;
  }
  case 'sandbox': {
    const { runSandbox } = await import('../lib/sandbox/index.js');
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
