#!/usr/bin/env node
import { VERSION } from '../lib/version.js';

// Node.js version check
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  process.stderr.write(
    `agent-orchestrator requires Node.js >= 18 (current: ${process.version})\n`
  );
  process.exit(1);
}

const USAGE = `agent-orchestrator - bootstrap AI collaboration infrastructure

Usage:
  agent-orchestrator init        Initialize a new project with update-agent-orchestrator seed command
  agent-orchestrator update      Update seed files and sync file registry for an existing project
  agent-orchestrator version     Show version
  agent-orchestrator help        Show this help message

Shorthand: ao (e.g. ao init)

Install methods:
  npm:   npm install -g @fitlab-ai/agent-orchestrator
  npx:   npx @fitlab-ai/agent-orchestrator init
  curl:  curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-orchestrator/main/install.sh | sh

Examples:
  cd my-project && agent-orchestrator init
  npx @fitlab-ai/agent-orchestrator init
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
  case 'version': {
    console.log(`agent-orchestrator ${VERSION}`);
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
