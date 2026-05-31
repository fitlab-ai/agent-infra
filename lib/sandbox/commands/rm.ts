import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import type { SandboxConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  shareBranchDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from '../constants.ts';
import { ENGINES, detectEngine, engineDisplayName, isManagedEngine, stopManagedVm } from '../engine.ts';
import { removeManagedDir, removeWorktreeDir } from '../managed-fs.ts';
import { runOk, runSafe, runSafeEngine } from '../shell.ts';
import { resolveTaskBranch } from '../task-resolver.ts';
import { resolveTools, toolConfigDirCandidates, toolProjectDirCandidates } from '../tools.ts';
import type { SandboxTool } from '../tools.ts';

const USAGE = `Usage: ai sandbox rm <branch> [--all]`;
export { assertManagedPath } from '../managed-fs.ts';

function projectToolDirs(config: SandboxConfig, tools: SandboxTool[]): string[] {
  return tools.flatMap((tool) => toolProjectDirCandidates(tool, config.project));
}

async function rmOne(config: SandboxConfig, tools: SandboxTool[], branch: string): Promise<void> {
  assertValidBranchName(branch);
  const engine = detectEngine(config);
  let effectiveBranch = branch;
  let worktreeCandidates = worktreeDirCandidates(config, branch);
  let toolCandidates = tools.map((tool) => ({
    tool,
    candidates: toolConfigDirCandidates(tool, config.project, branch)
  }));

  p.intro(pc.cyan(`Removing sandbox for ${branch}`));

  const existing = runSafeEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const matchedContainers = containerNameCandidates(config, branch)
    .filter((name) => existing.includes(name));

  if (matchedContainers.length > 0) {
    const resolvedBranch = runSafeEngine(engine, 'docker', [
      'inspect',
      '-f',
      `{{ index .Config.Labels "${sandboxBranchLabel(config)}" }}`,
      matchedContainers[0] ?? ''
    ]);
    if (resolvedBranch) {
      effectiveBranch = resolvedBranch;
      worktreeCandidates = worktreeDirCandidates(config, effectiveBranch);
      toolCandidates = tools.map((tool) => ({
        tool,
        candidates: toolConfigDirCandidates(tool, config.project, effectiveBranch)
      }));
    }

    const spinner = p.spinner();
    spinner.start(`Stopping container(s): ${matchedContainers.join(', ')}`);
    for (const name of matchedContainers) {
      runSafeEngine(engine, 'docker', ['stop', name]);
      runSafeEngine(engine, 'docker', ['rm', name]);
    }
    spinner.stop(pc.green(`Removed container(s): ${matchedContainers.join(', ')}`));
  } else {
    p.log.warn(`No sandbox container found for '${branch}'`);
  }

  const existingWorktrees = worktreeCandidates.filter((candidate) => fs.existsSync(candidate));
  if (existingWorktrees.length > 0) {
    const shouldRemoveWorktree = await p.confirm({
      message: `Remove worktree(s): ${existingWorktrees.join(', ')}?`,
      initialValue: true
    });

    if (p.isCancel(shouldRemoveWorktree)) {
      p.outro('Cancelled');
      return;
    }

    if (shouldRemoveWorktree) {
      for (const worktree of existingWorktrees) {
        removeWorktreeDir(config.repoRoot, config.worktreeBase, worktree);
      }

      const shouldDeleteBranch = await p.confirm({
        message: `Also delete local branch '${effectiveBranch}'?`,
        initialValue: true
      });

      if (!p.isCancel(shouldDeleteBranch) && shouldDeleteBranch) {
        if (!runOk('git', ['-C', config.repoRoot, 'branch', '-D', effectiveBranch])) {
          p.log.warn(`Local branch '${effectiveBranch}' was not deleted`);
        }
      }
    }
  }

  for (const { tool, candidates } of toolCandidates) {
    for (const dir of candidates.filter((candidate) => fs.existsSync(candidate))) {
      removeManagedDir(tool.sandboxBase, dir);
      p.log.success(`${tool.name} state removed: ${dir}`);
    }
  }

  for (const dir of shellConfigDirCandidates(config, effectiveBranch).filter((candidate) => fs.existsSync(candidate))) {
    removeManagedDir(config.shellConfigBase, dir);
    p.log.success(`Shell config removed: ${dir}`);
  }

  const shareBranch = shareBranchDir(config, effectiveBranch);
  if (fs.existsSync(shareBranch)) {
    const shouldRemoveShare = await p.confirm({
      message: `Remove share dir for branch '${effectiveBranch}' (${shareBranch})?`,
      initialValue: true
    });
    if (!p.isCancel(shouldRemoveShare) && shouldRemoveShare) {
      removeManagedDir(config.shareBase, shareBranch);
      p.log.success(`Share dir removed: ${shareBranch}`);
    }
  }

  p.outro(pc.green('Sandbox removed'));
}

async function rmAll(config: SandboxConfig, tools: SandboxTool[]): Promise<void> {
  const engine = detectEngine(config);
  p.intro(pc.cyan(`Removing all sandboxes for ${config.project}`));

  const containers = runSafeEngine(engine, 'docker', [
    'ps',
    '-a',
    '--filter',
    `label=${sandboxLabel(config)}`,
    '--format',
    '{{.Names}}'
  ]);
  if (containers) {
    const spinner = p.spinner();
    spinner.start('Stopping project sandbox containers...');
    for (const name of containers.split('\n').filter(Boolean)) {
      runSafeEngine(engine, 'docker', ['stop', name]);
      runSafeEngine(engine, 'docker', ['rm', name]);
    }
    spinner.stop(pc.green('Project sandbox containers removed'));
  } else {
    p.log.warn('No project sandbox containers found');
  }

  if (fs.existsSync(config.worktreeBase) && fs.readdirSync(config.worktreeBase).length > 0) {
    const shouldRemoveWorktrees = await p.confirm({
      message: `Remove all worktrees in ${config.worktreeBase}?`,
      initialValue: true
    });

    if (!p.isCancel(shouldRemoveWorktrees) && shouldRemoveWorktrees) {
      for (const entry of fs.readdirSync(config.worktreeBase)) {
        const dir = path.join(config.worktreeBase, entry);
        removeWorktreeDir(config.repoRoot, config.worktreeBase, dir);
      }
      runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
    }
  }

  for (const dir of projectToolDirs(config, tools)) {
    if (fs.existsSync(dir)) {
      removeManagedDir(path.dirname(dir), dir);
      p.log.success(`Removed tool state: ${dir}`);
    }
  }

  if (fs.existsSync(config.shellConfigBase) && fs.readdirSync(config.shellConfigBase).length > 0) {
    const shouldRemoveShellConfigs = await p.confirm({
      message: `Remove all shell config dirs in ${config.shellConfigBase}?`,
      initialValue: true
    });

    if (!p.isCancel(shouldRemoveShellConfigs) && shouldRemoveShellConfigs) {
      for (const entry of fs.readdirSync(config.shellConfigBase)) {
        const dir = path.join(config.shellConfigBase, entry);
        removeManagedDir(config.shellConfigBase, dir);
      }
      p.log.success(`Project shell config dirs removed: ${config.shellConfigBase}`);
    }
  }

  if (fs.existsSync(config.shareBase) && fs.readdirSync(config.shareBase).length > 0) {
    const shouldRemoveAllShares = await p.confirm({
      message: `Remove all share dirs for project (${config.shareBase})?`,
      initialValue: true
    });
    if (!p.isCancel(shouldRemoveAllShares) && shouldRemoveAllShares) {
      removeManagedDir(path.dirname(config.shareBase), config.shareBase);
      p.log.success(`Project share dirs removed: ${config.shareBase}`);
    }
  }

  const shouldRemoveImage = await p.confirm({
    message: `Remove image ${config.imageName}?`,
    initialValue: false
  });
  if (!p.isCancel(shouldRemoveImage) && shouldRemoveImage) {
    runSafeEngine(engine, 'docker', ['rmi', config.imageName]);
  }

  if (isManagedEngine(engine)) {
    if (engine === ENGINES.WSL2) {
      p.log.warn('Windows uses Docker Desktop with WSL2. Stop it from Docker Desktop or run "wsl --shutdown" manually.');
      p.outro(pc.green('All project sandboxes removed'));
      return;
    }

    const name = engineDisplayName(engine);
    const shouldStopVm = await p.confirm({
      message: `Stop ${name} VM?`,
      initialValue: false
    });
    if (!p.isCancel(shouldStopVm) && shouldStopVm) {
      stopManagedVm(config);
    }
  }

  p.outro(pc.green('All project sandboxes removed'));
}

export async function rm(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (!values.all && positionals.length !== 1) {
    throw new Error(USAGE);
  }

  const config = loadConfig();
  const tools = resolveTools(config);

  if (values.all) {
    await rmAll(config, tools);
    return;
  }

  const branch = resolveTaskBranch(positionals[0] ?? '', config.repoRoot);
  await rmOne(config, tools, branch);
}
