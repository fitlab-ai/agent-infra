import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { sandboxLabel } from '../constants.js';
import { runSafe } from '../shell.js';
import { resolveTools, toolProjectDirCandidates } from '../tools.js';

const USAGE = 'Usage: ai sandbox ls';

function listChildren(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir).sort().map((entry) => path.join(dir, entry));
}

export function ls(args = []) {
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const tools = resolveTools(config);
  const label = sandboxLabel(config);
  const containers = runSafe('docker', [
    'ps',
    '-a',
    '--filter',
    `label=${label}`,
    '--format',
    'table {{.Names}}\t{{.Status}}\t{{.Label "' + `${label}.branch` + '"}}'
  ]);

  p.intro(pc.cyan(`Sandbox status for ${config.project}`));

  p.log.step('Containers');
  if (!containers || containers.split('\n').length <= 1) {
    p.log.warn('  No sandbox containers');
  } else {
    for (const line of containers.split('\n')) {
      process.stdout.write(`  ${line}\n`);
    }
  }

  p.log.step('Worktrees');
  const worktrees = listChildren(config.worktreeBase);
  if (worktrees.length === 0) {
    p.log.warn('  No sandbox worktrees');
  } else {
    for (const worktree of worktrees) {
      process.stdout.write(`  ${worktree}\n`);
    }
  }

  for (const tool of tools) {
    p.log.step(`${tool.name} state`);
    const entries = toolProjectDirCandidates(tool, config.project)
      .flatMap((dir) => listChildren(dir));
    if (entries.length === 0) {
      p.log.warn(`  No ${tool.name} sandbox state`);
      continue;
    }
    for (const entry of entries) {
      process.stdout.write(`  ${entry}\n`);
    }
  }
}
