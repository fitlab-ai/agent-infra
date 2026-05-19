import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import { sandboxBranchLabel, sandboxLabel } from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { runSafeEngine } from '../shell.ts';
import { resolveTools, toolProjectDirCandidates } from '../tools.ts';

const USAGE = 'Usage: ai sandbox ls';
const CONTAINER_LIST_HEADER = 'NAMES\tSTATUS\tBRANCH';

// Exported to lock the docker/podman-compatible format in unit tests.
export function containerListFormat(): string {
  return '{{.Names}}\t{{.Status}}\t{{.Labels}}';
}

export function parseLabels(csv: string): Record<string, string> {
  if (!csv) {
    return {};
  }

  const labels: Record<string, string> = {};
  for (const pair of csv.split(',')) {
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf('=');
    if (eq < 0) {
      continue;
    }
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

function listChildren(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir).sort().map((entry) => path.join(dir, entry));
}

export function ls(args: string[] = []): void {
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const engine = detectEngine(config);
  const tools = resolveTools(config);
  const label = sandboxLabel(config);
  const containers = runSafeEngine(engine, 'docker', [
    'ps',
    '-a',
    '--filter',
    `label=${label}`,
    '--format',
    containerListFormat()
  ]);

  p.intro(pc.cyan(`Sandbox status for ${config.project}`));

  p.log.step('Containers');
  if (!containers) {
    p.log.warn('  No sandbox containers');
  } else {
    const branchKey = sandboxBranchLabel(config);
    process.stdout.write(`  ${CONTAINER_LIST_HEADER}\n`);
    for (const line of containers.split('\n')) {
      const [name = '', status = '', labelsCsv = ''] = line.split('\t');
      const branch = parseLabels(labelsCsv)[branchKey] ?? '';
      process.stdout.write(`  ${name}\t${status}\t${branch}\n`);
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
