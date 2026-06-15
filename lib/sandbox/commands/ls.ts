import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import { sandboxBranchLabel, sandboxLabel } from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { resolveTools, toolProjectDirCandidates } from '../tools.ts';
import { formatTable } from '../../table.ts';
import { lookupShortIdByBranch } from '../../task/short-id.ts';
import { fetchSandboxRows } from './list-running.ts';

export { containerListFormat, parseLabels } from './list-running.ts';

const USAGE = `Usage: ai sandbox ls

Lists all containers for the current project. The '#' column is a
display-only row number; the 'SHORT' column shows the active task short
id bound to each container's branch (via
.agents/workspace/active/.short-ids.json), or '-' if no active task is
bound. Pass the SHORT value to "ai sandbox exec" (e.g. 'ai sandbox exec 11').
A '-' means no active task is bound to that branch, so the sandbox is free
to remove with "ai sandbox rm <branch>".`;

const CONTAINER_TABLE_HEADERS = ['#', 'SHORT', 'NAMES', 'STATUS', 'BRANCH'] as const;

type ContainerTableRow = {
  row: string;
  shortId: string;
  name: string;
  status: string;
  branch: string;
};

export function formatContainerTable(rows: ContainerTableRow[]): string[] {
  return formatTable(
    CONTAINER_TABLE_HEADERS,
    rows.map((r) => [r.row, r.shortId, r.name, r.status, r.branch])
  );
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
    const tableRows: ContainerTableRow[] = ordered.map((container, i) => {
      const shortId = container.branch ? lookupShortIdByBranch(container.branch, config.repoRoot) : null;
      return {
        row: String(i + 1),
        shortId: shortId ?? '-',
        name: container.name,
        status: container.status,
        branch: container.branch
      };
    });
    for (const line of formatContainerTable(tableRows)) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write(`  Total: ${ordered.length} containers\n`);
    if (tableRows.some((r) => r.shortId === '-')) {
      process.stdout.write(
        `  SHORT '-' = no active task bound; that sandbox is free to remove with 'ai sandbox rm <branch>'.\n`
      );
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
