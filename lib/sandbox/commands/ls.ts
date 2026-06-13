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

Lists all containers for the current project. The leftmost '#' column
shows the active task short id bound to each container's branch (via
.agents/workspace/active/.short-ids.json); '-' means no active task is
bound to the branch. Use it as "ai sandbox exec N" or "ai sandbox exec
'#N'" to enter the sandbox of that task.`;

const CONTAINER_TABLE_HEADERS = ['#', 'NAMES', 'STATUS', 'BRANCH'] as const;

type ContainerTableRow = {
  index: string;
  name: string;
  status: string;
  branch: string;
};

export function formatContainerTable(rows: ContainerTableRow[]): string[] {
  return formatTable(
    CONTAINER_TABLE_HEADERS,
    rows.map((row) => [row.index, row.name, row.status, row.branch])
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
    const tableRows: ContainerTableRow[] = ordered.map((row) => {
      const shortId = row.branch ? lookupShortIdByBranch(row.branch, config.repoRoot) : null;
      return {
        index: shortId ?? '-',
        name: row.name,
        status: row.status,
        branch: row.branch
      };
    });
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
