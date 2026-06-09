import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import { sandboxBranchLabel, sandboxLabel } from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { resolveTools, toolProjectDirCandidates } from '../tools.ts';
import { fetchSandboxRows } from './list-running.ts';

export { containerListFormat, parseLabels } from './list-running.ts';

const USAGE = `Usage: ai sandbox ls

Lists all containers for the current project. The leftmost '#' column
numbers running sandboxes; use it as "ai sandbox exec '#N'" to enter one.
Quote '#N' to avoid shell '#' comment handling.`;

const CONTAINER_TABLE_HEADERS = ['#', 'NAMES', 'STATUS', 'BRANCH'] as const;

type ContainerTableRow = {
  index: string;
  name: string;
  status: string;
  branch: string;
};

export function formatContainerTable(rows: ContainerTableRow[]): string[] {
  const columns = rows.map((row) => [row.index, row.name, row.status, row.branch] as const);
  const widths = [
    Math.max(CONTAINER_TABLE_HEADERS[0].length, ...rows.map((row) => row.index.length)),
    Math.max(CONTAINER_TABLE_HEADERS[1].length, ...rows.map((row) => row.name.length)),
    Math.max(CONTAINER_TABLE_HEADERS[2].length, ...rows.map((row) => row.status.length)),
    Math.max(CONTAINER_TABLE_HEADERS[3].length, ...rows.map((row) => row.branch.length))
  ] as const;
  const renderRow = (values: readonly [string, string, string, string]): string =>
    `${values[0].padEnd(widths[0])}  ${values[1].padEnd(widths[1])}  ${values[2].padEnd(widths[2])}  ${values[3]}`.trimEnd();

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
  const { running, nonRunning } = fetchSandboxRows(engine, label, sandboxBranchLabel(config));

  p.intro(pc.cyan(`Sandbox status for ${config.project}`));

  p.log.step('Containers');
  const ordered = [...running, ...nonRunning];
  if (ordered.length === 0) {
    p.log.warn('  No sandbox containers');
  } else {
    const tableRows: ContainerTableRow[] = ordered.map((row) => ({
      index: row.index === null ? '' : String(row.index),
      name: row.name,
      status: row.status,
      branch: row.branch
    }));
    for (const line of formatContainerTable(tableRows)) {
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
