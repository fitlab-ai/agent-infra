import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import type { SandboxConfig } from '../config.ts';
import { safeNameCandidates, sandboxBranchLabel, sandboxLabel } from '../constants.ts';
import { detectEngine } from '../engine.ts';
import { hostJoin } from '../engines/wsl2-paths.ts';
import { removeManagedDir, removeWorktreeDir } from '../managed-fs.ts';
import { parseLabels } from './ls.ts';
import { runEngine, runSafe } from '../shell.ts';
import { resolveTools } from '../tools.ts';
import type { SandboxTool } from '../tools.ts';

const USAGE = `Usage: ai sandbox prune [--dry-run]`;

type OrphanKind = 'shell' | 'worktree' | 'share' | 'tool';

export type OrphanGroup = {
  kind: OrphanKind;
  label: string;
  base: string;
  dirs: string[];
};

function listChildDirs(base: string): string[] {
  if (!fs.existsSync(base)) {
    return [];
  }

  return fs.readdirSync(base)
    .sort()
    .map((entry) => path.join(base, entry))
    .filter((entry) => {
      try {
        return fs.statSync(entry).isDirectory();
      } catch {
        return false;
      }
    });
}

function activeSafeNames(activeBranches: string[]): Set<string> {
  const names = new Set<string>();
  for (const branch of activeBranches) {
    try {
      for (const name of safeNameCandidates(branch)) {
        names.add(name);
      }
    } catch {
      names.add(branch);
    }
  }
  return names;
}

function orphanDirs(base: string, activeNames: Set<string>): string[] {
  return listChildDirs(base).filter((dir) => !activeNames.has(path.basename(dir)));
}

function addGroup(groups: OrphanGroup[], group: OrphanGroup): void {
  if (group.dirs.length > 0) {
    groups.push(group);
  }
}

export function collectOrphanGroups(
  config: SandboxConfig,
  tools: SandboxTool[],
  activeBranches: string[]
): OrphanGroup[] {
  const activeNames = activeSafeNames(activeBranches);
  const groups: OrphanGroup[] = [];
  const shareBranchesBase = hostJoin(config.shareBase, 'branches');

  addGroup(groups, {
    kind: 'shell',
    label: 'Shell config dirs',
    base: config.shellConfigBase,
    dirs: orphanDirs(config.shellConfigBase, activeNames)
  });
  addGroup(groups, {
    kind: 'worktree',
    label: 'Worktrees',
    base: config.worktreeBase,
    dirs: orphanDirs(config.worktreeBase, activeNames)
  });
  addGroup(groups, {
    kind: 'share',
    label: 'Share branch dirs',
    base: shareBranchesBase,
    dirs: orphanDirs(shareBranchesBase, activeNames)
  });

  for (const tool of tools) {
    const base = hostJoin(tool.sandboxBase, config.project);
    addGroup(groups, {
      kind: 'tool',
      label: `${tool.name} state`,
      base,
      dirs: orphanDirs(base, activeNames)
    });
  }

  return groups;
}

export function removeOrphanGroups(config: SandboxConfig, groups: OrphanGroup[]): boolean {
  let removedWorktrees = false;
  for (const group of groups) {
    for (const dir of group.dirs) {
      if (group.kind === 'worktree') {
        removeWorktreeDir(config.repoRoot, group.base, dir);
        removedWorktrees = true;
      } else {
        removeManagedDir(group.base, dir);
      }
    }
  }
  return removedWorktrees;
}

function activeBranchesFromLabels(config: SandboxConfig, labelsOutput: string): string[] {
  const branchKey = sandboxBranchLabel(config);
  return labelsOutput.split('\n')
    .map((line) => parseLabels(line)[branchKey] ?? '')
    .filter(Boolean);
}

function orphanCount(groups: OrphanGroup[]): number {
  return groups.reduce((sum, group) => sum + group.dirs.length, 0);
}

function writeGroups(groups: OrphanGroup[]): void {
  for (const group of groups) {
    p.log.step(group.label);
    for (const dir of group.dirs) {
      process.stdout.write(`  ${dir}\n`);
    }
  }
}

export async function prune(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const tools = resolveTools(config);
  const engine = detectEngine(config);
  const psArgs = [
    'ps',
    '-a',
    '--filter',
    `label=${sandboxLabel(config)}`,
    '--format',
    '{{.Labels}}'
  ];
  let labelsOutput: string;
  try {
    labelsOutput = runEngine(engine, 'docker', psArgs);
  } catch {
    throw new Error('Unable to determine active sandbox branches: docker ps failed');
  }
  const groups = collectOrphanGroups(config, tools, activeBranchesFromLabels(config, labelsOutput));
  const count = orphanCount(groups);

  p.intro(pc.cyan(`Pruning orphaned sandbox state for ${config.project}`));

  if (count === 0) {
    p.log.success('No orphaned sandbox state dirs found');
    p.outro(pc.green('Sandbox prune complete'));
    return;
  }

  writeGroups(groups);

  if (values['dry-run']) {
    p.outro(pc.green('Dry run complete'));
    return;
  }

  const shouldRemove = await p.confirm({
    message: `Remove ${count} orphaned sandbox state dirs?`,
    initialValue: true
  });

  if (p.isCancel(shouldRemove) || !shouldRemove) {
    p.outro('Cancelled');
    return;
  }

  const removedWorktrees = removeOrphanGroups(config, groups);
  if (removedWorktrees) {
    runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
  }

  p.outro(pc.green('Orphaned sandbox state dirs removed'));
}
