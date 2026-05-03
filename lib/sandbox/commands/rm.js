import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  worktreeDirCandidates
} from '../constants.js';
import { ENGINES, detectEngine, engineDisplayName, isManagedEngine, stopManagedVm } from '../engine.js';
import { run, runOk, runSafe, runSafeEngine } from '../shell.js';
import { resolveTaskBranch } from '../task-resolver.js';
import { resolveTools, toolConfigDirCandidates, toolProjectDirCandidates } from '../tools.js';

const USAGE = `Usage: ai sandbox rm <branch> [--all]`;

function projectToolDirs(config, tools) {
  return tools.flatMap((tool) => toolProjectDirCandidates(tool, config.project));
}

export function assertManagedPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Refusing to remove path outside managed sandbox root: ${target}`);
}

async function rmOne(config, tools, branch) {
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
      matchedContainers[0]
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
        try {
          run('git', ['-C', config.repoRoot, 'worktree', 'remove', worktree, '--force']);
        } catch {
          assertManagedPath(config.worktreeBase, worktree);
          fs.rmSync(worktree, { recursive: true, force: true });
        }
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
      assertManagedPath(tool.sandboxBase, dir);
      fs.rmSync(dir, { recursive: true, force: true });
      p.log.success(`${tool.name} state removed: ${dir}`);
    }
  }

  p.outro(pc.green('Sandbox removed'));
}

async function rmAll(config, tools) {
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
        try {
          run('git', ['-C', config.repoRoot, 'worktree', 'remove', dir, '--force']);
        } catch {
          assertManagedPath(config.worktreeBase, dir);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
    }
  }

  for (const dir of projectToolDirs(config, tools)) {
    if (fs.existsSync(dir)) {
      assertManagedPath(path.dirname(dir), dir);
      fs.rmSync(dir, { recursive: true, force: true });
      p.log.success(`Removed tool state: ${dir}`);
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

export async function rm(args) {
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

  const branch = resolveTaskBranch(positionals[0], config.repoRoot);
  await rmOne(config, tools, branch);
}
