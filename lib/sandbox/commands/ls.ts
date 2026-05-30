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
const CONTAINER_TABLE_HEADERS = ['NAMES', 'STATUS', 'BRANCH'] as const;

type ContainerTableRow = {
  name: string;
  status: string;
  branch: string;
};

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

export function formatContainerTable(rows: ContainerTableRow[]): string[] {
  const columns = rows.map((row) => [row.name, row.status, row.branch] as const);
  const widths = [
    Math.max(CONTAINER_TABLE_HEADERS[0].length, ...rows.map((row) => row.name.length)),
    Math.max(CONTAINER_TABLE_HEADERS[1].length, ...rows.map((row) => row.status.length)),
    Math.max(CONTAINER_TABLE_HEADERS[2].length, ...rows.map((row) => row.branch.length))
  ] as const;
  const renderRow = (values: readonly [string, string, string]): string =>
    `${values[0].padEnd(widths[0])}  ${values[1].padEnd(widths[1])}  ${values[2]}`.trimEnd();

  return [
    renderRow(CONTAINER_TABLE_HEADERS),
    ...columns.map((column) => renderRow(column))
  ];
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
    const rows = containers.split('\n').map((line) => {
      const [name = '', status = '', labelsCsv = ''] = line.split('\t');
      const branch = parseLabels(labelsCsv)[branchKey] ?? '';
      return { name, status, branch };
    });
    for (const line of formatContainerTable(rows)) {
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
