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
import { pruneSandboxDanglingImages } from '../image-prune.ts';
import { assertManagedPath, removeManagedDir, removeWorktreeDir } from '../managed-fs.ts';
import { runEngine, runOk, runOkEngine, runSafe, runSafeEngine } from '../shell.ts';
import { resolveSandboxTarget, type SandboxWorkspaceIdentity } from '../workspace-identity.ts';
import { sandboxControlPaths, sandboxWorkspaceViewPaths } from '../workspace-view.ts';
import { quiesceSandboxControlRoot, readSandboxControlManifest } from '../control/lifecycle.ts';
import { toolConfigDirCandidates, toolProjectDirCandidates } from '../tools.ts';
import { createSandboxCapabilityPlan } from '../agent-client-reconciler.ts';
import type { SandboxTool } from '../tools.ts';
import { fetchSandboxRows } from './list-running.ts';
import { lookupShortIdByBranch } from '../../task/short-id.ts';
import {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectWorktrees,
  verifyWorktreePermit
} from '../worktree-safety.ts';
import type { WorktreeInspection, WorktreeRemovalPermit } from '../worktree-safety.ts';

const USAGE = `Usage:
  ai sandbox rm <branch>                    Remove one sandbox (branch | TASK-id | short id)
  ai sandbox rm --unbound [--dry-run] [--yes] Remove every sandbox not bound to an active task
  ai sandbox rm --purge                     Tear down ALL sandboxes for the project (containers, worktrees, image, VM)`;
export { assertManagedPath } from '../managed-fs.ts';

function projectToolDirs(config: SandboxConfig, tools: SandboxTool[]): string[] {
  return tools.flatMap((tool) => toolProjectDirCandidates(tool, config.project));
}

type RmTarget = {
  branch: string;
  effectiveBranch: string;
  engine: string;
  matchedContainers: string[];
  existingWorktrees: string[];
  toolCandidates: Array<{ tool: SandboxTool; candidates: string[] }>;
  workspace: SandboxWorkspaceIdentity;
  controlRoots: string[];
  workspaceViewRoots: string[];
};

type RmOneOptions = {
  assumeYes?: boolean;
  quiet?: boolean;
  target?: RmTarget;
  permits?: ReadonlyMap<string, WorktreeRemovalPermit>;
  allowDirtyDiscard?: boolean;
  prompt?: PromptDependencies;
};

type PromptDependencies = {
  confirm?: typeof p.confirm;
  isCancel?: typeof p.isCancel;
};

function resolveRmTarget(config: SandboxConfig, tools: SandboxTool[], branch: string): RmTarget {
  assertValidBranchName(branch);
  const engine = detectEngine(config);
  let effectiveBranch = branch;
  let worktreeCandidates = worktreeDirCandidates(config, branch);
  let toolCandidates = tools.map((tool) => ({
    tool,
    candidates: toolConfigDirCandidates(tool, config.project, branch)
  }));
  const existing = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const matchedContainers = containerNameCandidates(config, branch).filter((name) => existing.includes(name));

  if (matchedContainers.length > 0) {
    const resolvedBranch = runEngine(engine, 'docker', [
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
  }

  const workspace = resolveSandboxTarget(effectiveBranch, config.repoRoot).workspace;
  const identities: SandboxWorkspaceIdentity[] = workspace.mode === 'task-bound'
    ? [workspace, { mode: 'branch-only' }]
    : [workspace];
  const containers = [...new Set([...containerNameCandidates(config, effectiveBranch), ...matchedContainers])];
  const controlRoots = containers.flatMap((container) => identities.map((identity) => sandboxControlPaths({
    base: config.controlBase, project: config.project, container, identity
  }).root));
  const workspaceViewRoots = containers.flatMap((container) => identities.map((identity) => sandboxWorkspaceViewPaths({
    base: config.workspaceViewBase, project: config.project, container, identity
  }).root));

  return {
    branch,
    effectiveBranch,
    engine,
    matchedContainers,
    existingWorktrees: worktreeCandidates.filter((candidate) => fs.existsSync(candidate)),
    toolCandidates,
    workspace,
    controlRoots: [...new Set(controlRoots)],
    workspaceViewRoots: [...new Set(workspaceViewRoots)]
  };
}

function assertControlRootMatchesTarget(root: string, effectiveBranch: string, workspace: SandboxWorkspaceIdentity): void {
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = readSandboxControlManifest(manifestPath);
  const identityMatches = workspace.mode === 'task-bound'
    ? manifest.mode === 'task-bound' && manifest.taskId === workspace.taskId
    : manifest.mode === 'branch-only';
  const branchOnlyFallback = workspace.mode === 'task-bound' && manifest.mode === 'branch-only';
  if (manifest.branch !== effectiveBranch || (!identityMatches && !branchOnlyFallback)) {
    throw new Error(`SANDBOX_CONTROL_TARGET_MISMATCH: ${root}`);
  }
}

function assertLegacyCandidateEvidence(
  candidate: string,
  base: string,
  config: SandboxConfig,
  effectiveBranch: string,
  matchedContainers: readonly string[]
): void {
  const relative = path.relative(path.join(base, config.project), candidate);
  const [container, identity] = relative.split(path.sep);
  const [canonical, legacy] = containerNameCandidates(config, effectiveBranch);
  if (!container || !identity || legacy === canonical || container !== legacy || matchedContainers.includes(container)) return;
  const manifestPath = path.join(config.controlBase, config.project, container, identity, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: ${candidate}`);
  }
}

function assertRemoved(target: string, label: string): void {
  if (fs.existsSync(target)) throw new Error(`${label} still exists after removal: ${target}`);
}

function removeEmptyManagedParent(base: string, directory: string): void {
  const parent = path.dirname(directory);
  if (path.resolve(parent) === path.resolve(base)) return;
  assertManagedPath(base, parent);
  try {
    fs.rmdirSync(parent);
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  assertRemoved(parent, 'Empty sandbox container directory');
}

async function quiesceProjectControlRoots(config: SandboxConfig): Promise<void> {
  const projectRoot = path.join(config.controlBase, config.project);
  if (!fs.existsSync(projectRoot)) return;
  assertManagedPath(config.controlBase, projectRoot);
  const projectStat = fs.lstatSync(projectRoot);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  for (const container of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!container.isDirectory() || container.isSymbolicLink()) continue;
    const containerRoot = path.join(projectRoot, container.name);
    for (const identity of fs.readdirSync(containerRoot, { withFileTypes: true })) {
      if (!identity.isDirectory() || identity.isSymbolicLink()) continue;
      await quiesceSandboxControlRoot(path.join(containerRoot, identity.name));
    }
  }
}

function inspectionBlockers(inspections: readonly WorktreeInspection[]): WorktreeInspection[] {
  return inspections.filter((inspection) => inspection.status !== 'clean');
}

function blockerMessage(blockers: readonly WorktreeInspection[]): string {
  return blockers.map((blocker) => {
    if (blocker.status === 'failed') return `${JSON.stringify(blocker.worktree)}: ${blocker.message}`;
    return `${formatWorktreeSnapshot(blocker.snapshot)}\n  Action: commit, stash, clean, or remove this sandbox interactively.`;
  }).join('\n');
}

function cleanPermits(inspections: readonly WorktreeInspection[]): Map<string, WorktreeRemovalPermit> {
  const permits = new Map<string, WorktreeRemovalPermit>();
  for (const inspection of inspections) {
    if (inspection.status === 'clean') permits.set(inspection.snapshot.worktree, createCleanPermit(inspection.snapshot));
  }
  return permits;
}

async function authorizeWorktrees(
  worktrees: readonly string[],
  { allowDirtyDiscard, assumeYes }: { allowDirtyDiscard: boolean; assumeYes: boolean },
  {
    interactive = Boolean(process.stdin.isTTY),
    confirm = p.confirm,
    isCancel = p.isCancel
  }: PromptDependencies & { interactive?: boolean } = {}
): Promise<Map<string, WorktreeRemovalPermit>> {
  const inspections = inspectWorktrees(worktrees);
  const failures = inspections.filter((inspection) => inspection.status === 'failed');
  if (failures.length > 0) throw new Error(`Unable to inspect worktree(s):\n${blockerMessage(failures)}`);
  const permits = cleanPermits(inspections);
  for (const inspection of inspections) {
    if (inspection.status !== 'dirty') continue;
    if (!allowDirtyDiscard || assumeYes || !interactive) {
      throw new Error(`Refusing to remove dirty worktree(s):\n${blockerMessage([inspection])}`);
    }
    p.log.warn(formatWorktreeSnapshot(inspection.snapshot));
    const confirmed = await confirm({
      message: 'Discard these exact uncommitted changes?',
      initialValue: false
    });
    if (isCancel(confirmed) || !confirmed) throw new Error('Dirty worktree removal cancelled; nothing was deleted');
    permits.set(inspection.snapshot.worktree, createDiscardPermit(inspection.snapshot));
  }
  return permits;
}

async function rmOne(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<void> {
  const target = options.target ?? resolveRmTarget(config, tools, branch);
  const { effectiveBranch, engine, matchedContainers, existingWorktrees, toolCandidates } = target;
  const { workspace, controlRoots, workspaceViewRoots } = target;
  const confirm = options.prompt?.confirm ?? p.confirm;
  const isCancel = options.prompt?.isCancel ?? p.isCancel;

  if (!options.quiet) {
    p.intro(pc.cyan(`Removing sandbox for ${branch}`));
  }

  const permits = options.permits
    ? new Map(options.permits)
    : await authorizeWorktrees(existingWorktrees, {
        allowDirtyDiscard: options.allowDirtyDiscard ?? true,
        assumeYes: Boolean(options.assumeYes)
      }, options.prompt);
  for (const worktree of existingWorktrees) {
    const permit = permits.get(path.resolve(worktree));
    if (!permit) throw new Error(`Missing worktree removal permit: ${worktree}`);
    verifyWorktreePermit(permit);
  }

  const shouldRemoveWorktree = existingWorktrees.length === 0
    ? false
    : options.assumeYes
      ? true
      : await confirm({
          message: `Remove worktree(s): ${existingWorktrees.join(', ')}?`,
          initialValue: true
        });
  if (isCancel(shouldRemoveWorktree)) {
    p.outro('Cancelled');
    return;
  }

  for (const root of controlRoots.filter((candidate) => fs.existsSync(candidate))) {
    assertLegacyCandidateEvidence(root, config.controlBase, config, effectiveBranch, matchedContainers);
    assertControlRootMatchesTarget(root, effectiveBranch, workspace);
    await quiesceSandboxControlRoot(root);
  }

  if (matchedContainers.length > 0) {
    const spinner = p.spinner();
    spinner.start(`Stopping container(s): ${matchedContainers.join(', ')}`);
    for (const name of matchedContainers) {
      if (!runOkEngine(engine, 'docker', ['stop', name])) throw new Error(`Failed to stop sandbox container: ${name}`);
      if (!runOkEngine(engine, 'docker', ['rm', name])) throw new Error(`Failed to remove sandbox container: ${name}`);
    }
    const remaining = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
    const leftovers = matchedContainers.filter((name) => remaining.includes(name));
    if (leftovers.length > 0) throw new Error(`Sandbox container(s) still exist after removal: ${leftovers.join(', ')}`);
    spinner.stop(pc.green(`Removed container(s): ${matchedContainers.join(', ')}`));
  } else {
    p.log.warn(`No sandbox container found for '${branch}'`);
  }

  for (const [roots, base, label] of [
    [workspaceViewRoots, path.join(config.workspaceViewBase, config.project), 'Workspace view'],
    [controlRoots, path.join(config.controlBase, config.project), 'Control channel']
  ] as const) {
    for (const directory of roots.filter((candidate) => fs.existsSync(candidate))) {
      assertLegacyCandidateEvidence(directory, base === path.join(config.controlBase, config.project)
        ? config.controlBase : config.workspaceViewBase, config, effectiveBranch, matchedContainers);
      removeManagedDir(base, directory);
      assertRemoved(directory, label);
      removeEmptyManagedParent(base, directory);
      if (!options.quiet) p.log.success(`${label} removed: ${directory}`);
    }
  }

  if (shouldRemoveWorktree) {
    for (const worktree of existingWorktrees) {
      const permit = permits.get(path.resolve(worktree));
      if (!permit) throw new Error(`Missing worktree removal permit: ${worktree}`);
      removeWorktreeDir(config.repoRoot, config.worktreeBase, worktree, permit, {
        allowRegisteredPathFallback: engine === ENGINES.WSL2
      });
      assertRemoved(worktree, 'Worktree');
      const registered = runSafe('git', ['-C', config.repoRoot, 'worktree', 'list', '--porcelain'])
        .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice(9)));
      if (registered.includes(path.resolve(worktree))) throw new Error(`Worktree is still registered after removal: ${worktree}`);
    }

    const shouldDeleteBranch = options.assumeYes
      ? true
      : await confirm({
          message: `Also delete local branch '${effectiveBranch}'?`,
          initialValue: true
        });

    if (!isCancel(shouldDeleteBranch) && shouldDeleteBranch) {
      if (!runOk('git', ['-C', config.repoRoot, 'branch', '-D', effectiveBranch])) {
        throw new Error(`Local branch '${effectiveBranch}' was not deleted`);
      }
      if (runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', `refs/heads/${effectiveBranch}`])) {
        throw new Error(`Local branch '${effectiveBranch}' still exists after removal`);
      }
    }
  }

  for (const { tool, candidates } of toolCandidates) {
    for (const dir of candidates.filter((candidate) => fs.existsSync(candidate))) {
      removeManagedDir(tool.sandboxBase, dir);
      assertRemoved(dir, `${tool.name} state`);
      p.log.success(`${tool.name} state removed: ${dir}`);
    }
  }

  for (const dir of shellConfigDirCandidates(config, effectiveBranch).filter((candidate) => fs.existsSync(candidate))) {
    removeManagedDir(config.shellConfigBase, dir);
    assertRemoved(dir, 'Shell config');
    p.log.success(`Shell config removed: ${dir}`);
  }

  const shareBranch = shareBranchDir(config, effectiveBranch);
  if (fs.existsSync(shareBranch)) {
    const shouldRemoveShare = options.assumeYes
      ? true
      : await confirm({
          message: `Remove share dir for branch '${effectiveBranch}' (${shareBranch})?`,
          initialValue: true
        });
    if (!isCancel(shouldRemoveShare) && shouldRemoveShare) {
      removeManagedDir(config.shareBase, shareBranch);
      assertRemoved(shareBranch, 'Share dir');
      p.log.success(`Share dir removed: ${shareBranch}`);
    }
  }

  if (!options.quiet) {
    p.outro(pc.green('Sandbox removed'));
  }
}

async function rmPurge(
  config: SandboxConfig,
  tools: SandboxTool[],
  prompt: PromptDependencies = {}
): Promise<void> {
  const engine = detectEngine(config);
  const confirm = prompt.confirm ?? p.confirm;
  const isCancel = prompt.isCancel ?? p.isCancel;
  p.intro(pc.cyan(`Removing all sandboxes for ${config.project}`));

  const worktrees = fs.existsSync(config.worktreeBase)
    ? fs.readdirSync(config.worktreeBase)
        .map((entry) => path.join(config.worktreeBase, entry))
        .filter((entry) => {
          try { return fs.statSync(entry).isDirectory(); } catch { return false; }
        })
    : [];
  const inspections = inspectWorktrees(worktrees);
  const blockers = inspectionBlockers(inspections);
  if (blockers.length > 0) {
    throw new Error(`Refusing to purge because worktree preflight found blocker(s):\n${blockerMessage(blockers)}`);
  }
  const permits = cleanPermits(inspections);

  await quiesceProjectControlRoots(config);

  const containers = runEngine(engine, 'docker', [
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
      if (!runOkEngine(engine, 'docker', ['stop', name])) throw new Error(`Failed to stop sandbox container: ${name}`);
      if (!runOkEngine(engine, 'docker', ['rm', name])) throw new Error(`Failed to remove sandbox container: ${name}`);
    }
    const remaining = runEngine(engine, 'docker', [
      'ps', '-a', '--filter', `label=${sandboxLabel(config)}`, '--format', '{{.Names}}'
    ]);
    if (remaining) throw new Error(`Project sandbox container(s) still exist after removal: ${remaining.replaceAll('\n', ', ')}`);
    spinner.stop(pc.green('Project sandbox containers removed'));
  } else {
    p.log.warn('No project sandbox containers found');
  }

  if (worktrees.length > 0) {
    const shouldRemoveWorktrees = await confirm({
      message: `Remove all worktrees in ${config.worktreeBase}?`,
      initialValue: true
    });

    if (!isCancel(shouldRemoveWorktrees) && shouldRemoveWorktrees) {
      for (const dir of worktrees) {
        const permit = permits.get(path.resolve(dir));
        if (!permit) throw new Error(`Missing worktree removal permit: ${dir}`);
        removeWorktreeDir(config.repoRoot, config.worktreeBase, dir, permit, {
          allowRegisteredPathFallback: engine === ENGINES.WSL2
        });
        assertRemoved(dir, 'Worktree');
      }
      runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
      const registered = new Set(runSafe('git', ['-C', config.repoRoot, 'worktree', 'list', '--porcelain'])
        .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice(9))));
      const leftovers = worktrees.filter((dir) => registered.has(path.resolve(dir)));
      if (leftovers.length > 0) throw new Error(`Worktree(s) still registered after removal: ${leftovers.join(', ')}`);
    }
  }

  for (const dir of projectToolDirs(config, tools)) {
    if (fs.existsSync(dir)) {
      removeManagedDir(path.dirname(dir), dir);
      assertRemoved(dir, 'Tool state');
      p.log.success(`Removed tool state: ${dir}`);
    }
  }

  if (fs.existsSync(config.shellConfigBase) && fs.readdirSync(config.shellConfigBase).length > 0) {
    const shouldRemoveShellConfigs = await confirm({
      message: `Remove all shell config dirs in ${config.shellConfigBase}?`,
      initialValue: true
    });

    if (!isCancel(shouldRemoveShellConfigs) && shouldRemoveShellConfigs) {
      for (const entry of fs.readdirSync(config.shellConfigBase)) {
        const dir = path.join(config.shellConfigBase, entry);
        removeManagedDir(config.shellConfigBase, dir);
        assertRemoved(dir, 'Shell config');
      }
      p.log.success(`Project shell config dirs removed: ${config.shellConfigBase}`);
    }
  }

  if (fs.existsSync(config.shareBase) && fs.readdirSync(config.shareBase).length > 0) {
    const shouldRemoveAllShares = await confirm({
      message: `Remove all share dirs for project (${config.shareBase})?`,
      initialValue: true
    });
    if (!isCancel(shouldRemoveAllShares) && shouldRemoveAllShares) {
      removeManagedDir(path.dirname(config.shareBase), config.shareBase);
      assertRemoved(config.shareBase, 'Project share dir');
      p.log.success(`Project share dirs removed: ${config.shareBase}`);
    }
  }

  for (const [base, label] of [
    [config.workspaceViewBase, 'workspace views'],
    [config.controlBase, 'control channels']
  ] as const) {
    const projectDir = path.join(base, config.project);
    if (fs.existsSync(projectDir)) {
      removeManagedDir(base, projectDir);
      assertRemoved(projectDir, `Project ${label}`);
      p.log.success(`Removed project ${label}: ${projectDir}`);
    }
  }

  const shouldRemoveImage = await confirm({
    message: `Remove image ${config.imageName}?`,
    initialValue: false
  });
  if (!isCancel(shouldRemoveImage) && shouldRemoveImage) {
    runSafeEngine(engine, 'docker', ['rmi', config.imageName]);
  }

  pruneSandboxDanglingImages(config, engine);

  if (isManagedEngine(engine)) {
    if (engine === ENGINES.WSL2) {
      p.log.warn('Windows uses Docker Desktop with WSL2. Stop it from Docker Desktop or run "wsl --shutdown" manually.');
      p.outro(pc.green('All project sandboxes removed'));
      return;
    }

    const name = engineDisplayName(engine);
    const shouldStopVm = await confirm({
      message: `Stop ${name} VM?`,
      initialValue: false
    });
    if (!isCancel(shouldStopVm) && shouldStopVm) {
      stopManagedVm(config);
    }
  }

  p.outro(pc.green('All project sandboxes removed'));
}

async function rmUnbound(
  config: SandboxConfig,
  tools: SandboxTool[],
  options: { dryRun: boolean; assumeYes: boolean }
): Promise<void> {
  const engine = detectEngine(config);
  const { running, nonRunning } = fetchSandboxRows(engine, sandboxLabel(config), sandboxBranchLabel(config));
  const removable = [...running, ...nonRunning].filter(
    (row) => row.branch && lookupShortIdByBranch(row.branch, config.repoRoot) === null
  );

  p.intro(pc.cyan(`Removing sandboxes not bound to an active task for ${config.project}`));

  if (removable.length === 0) {
    p.outro('No removable sandboxes: every container is bound to an active task (or none exist)');
    return;
  }

  const targets = removable.map((row) => resolveRmTarget(config, tools, row.branch));
  const inspections = inspectWorktrees(targets.flatMap((target) => target.existingWorktrees));
  const blockers = inspectionBlockers(inspections);
  const permits = cleanPermits(inspections);

  for (const row of removable) {
    p.log.message(`${row.name}  ${row.branch}`);
  }
  if (blockers.length > 0) p.log.error(blockerMessage(blockers));

  if (options.dryRun) {
    p.outro(`Dry run: ${removable.length} sandbox(es) inspected, nothing deleted`);
    return;
  }

  if (blockers.length > 0) {
    throw new Error(`Refusing batch removal because worktree preflight found blocker(s):\n${blockerMessage(blockers)}`);
  }

  if (!options.assumeYes && !process.stdin.isTTY) {
    throw new Error(
      'Refusing to remove sandboxes without confirmation in a non-interactive shell; pass --yes to proceed.'
    );
  }

  const failures: { branch: string; message: string }[] = [];
  for (const [index, row] of removable.entries()) {
    try {
      await rmOne(config, tools, row.branch, {
        assumeYes: options.assumeYes,
        quiet: true,
        target: targets[index],
        permits,
        allowDirtyDiscard: false
      });
    } catch (error) {
      failures.push({ branch: row.branch, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      p.log.error(`Failed to remove '${failure.branch}': ${failure.message}`);
    }
    throw new Error(
      `Removed ${removable.length - failures.length}/${removable.length} sandbox(es); ${failures.length} failed`
    );
  }

  p.outro(pc.green(`Removed ${removable.length} sandbox(es)`));
}

export async function rm(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: 'boolean' },
      unbound: { type: 'boolean' },
      purge: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.all) {
    throw new Error('CLI_FLAG_REMOVED: --all was removed; use --unbound');
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (values.unbound && values.purge) {
    throw new Error('--unbound and --purge are mutually exclusive');
  }

  if ((values['dry-run'] || values.yes) && !values.unbound) {
    throw new Error('--dry-run and --yes only apply to --unbound');
  }

  if ((values.unbound || values.purge) && positionals.length > 0) {
    throw new Error(`${values.unbound ? '--unbound' : '--purge'} does not take a branch argument`);
  }

  if (!values.unbound && !values.purge && positionals.length !== 1) {
    throw new Error(USAGE);
  }

  const config = loadConfig();
  const tools = [...createSandboxCapabilityPlan(config).cleanupInventory];

  if (values.purge) {
    await rmPurge(config, tools);
    return;
  }

  if (values.unbound) {
    await rmUnbound(config, tools, {
      dryRun: Boolean(values['dry-run']),
      assumeYes: Boolean(values.yes)
    });
    return;
  }

  const target = resolveSandboxTarget(positionals[0] ?? '', config.repoRoot);
  await rmOne(config, tools, target.branch);
}

export { authorizeWorktrees, rmOne, rmPurge };
