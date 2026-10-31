import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { SandboxConfig } from './config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel,
  shareBranchDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from './constants.ts';
import { detectEngine } from './engine.ts';
import './image-prune.ts';
import { assertManagedPath, removeWorktreeDir } from './managed-fs.ts';
import { runEngine, runOk, runSafe, runSafeEngine } from './shell.ts';
import {
  resolveSandboxCleanupTarget,
  resolveSandboxTarget,
  type SandboxCleanupTarget,
  type SandboxWorkspaceKey
} from './workspace-identity.ts';
import { sandboxControlPaths, sandboxWorkspaceViewPaths } from './workspace-view.ts';
import './control/lifecycle.ts';
import './control/container-identity.ts';
import { toolConfigDirCandidates, toolProjectDirCandidates } from './tools.ts';
import type { SandboxTool } from './tools.ts';
import '../server/process-state.ts';
import { releaseStaleShortIdRegistry } from '../task/short-id.ts';
import { fetchSandboxRows } from './commands/list-running.ts';
import {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectRecoveredWorktree,
  inspectWorktrees
} from './worktree-safety.ts';
import type {
  WorktreeInspection,
  WorktreeRecoveryContext,
  WorktreeRemovalPermit
} from './worktree-safety.ts';

function projectToolDirs(config: SandboxConfig, tools: SandboxTool[]): string[] {
  return tools.flatMap((tool) => toolProjectDirCandidates(tool, config.project));
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT');
}

function removalErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function removalErrorMessage(error: unknown): string {
  const code = removalErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

function addOwnerWriteToDirectories(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (!stat.isDirectory()) continue;

    fs.chmodSync(current, stat.mode | 0o200);
    for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
  }
}

function isPermissionRemovalError(error: unknown): boolean {
  return ['EACCES', 'EPERM', 'ENOTEMPTY'].includes(removalErrorCode(error) ?? '');
}

function assertBranchRemovalIdentity(
  config: SandboxConfig,
  branch: string,
  permits: ReadonlyMap<string, WorktreeRemovalPermit>
): void {
  if (!runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', `refs/heads/${branch}`])) return;
  const expectedHeads = new Set(
    [...permits.values()]
      .filter((permit) => permit.snapshot.branch === branch)
      .map((permit) => permit.snapshot.head)
  );
  if (expectedHeads.size === 0) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
  const actualHead = runSafe('git', ['-C', config.repoRoot, 'rev-parse', `refs/heads/${branch}`]);
  if (!expectedHeads.has(actualHead)) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
}

type RmTarget = {
  branch: string;
  effectiveBranch: string;
  engine: string;
  matchedContainers: string[];
  existingWorktrees: string[];
  toolCandidates: Array<{ tool: SandboxTool; candidates: string[] }>;
  managedPathCandidates?: string[];
  workspace: SandboxWorkspaceKey;
  controlRoots: string[];
  workspaceViewRoots: string[];
};

type RmOneOptions = {
  assumeYes?: boolean;
  interactive?: boolean;
  quiet?: boolean;
  target?: RmTarget;
  cleanupTarget?: SandboxCleanupTarget;
  permits?: ReadonlyMap<string, WorktreeRemovalPermit>;
  allowDirtyDiscard?: boolean;
  prompt?: PromptDependencies;
};

type PromptDependencies = {
  confirm?: typeof p.confirm;
  isCancel?: typeof p.isCancel;
};

function resolveRmTarget(
  config: SandboxConfig,
  tools: SandboxTool[],
  cleanupTarget: SandboxCleanupTarget,
  options: Readonly<{ discoveredContainers?: readonly string[] }> = {}
): RmTarget {
  assertValidBranchName(cleanupTarget.branch);
  const engine = detectEngine(config);
  const branch = cleanupTarget.branch;
  const effectiveBranch = branch;
  const worktreeCandidates = worktreeDirCandidates(config, branch);
  const toolCandidates = tools.map((tool) => ({
    tool,
    candidates: toolConfigDirCandidates(tool, config.project, branch)
  }));
  const shellCandidates = shellConfigDirCandidates(config, branch);
  const existing = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const matchedContainers = options.discoveredContainers
    ? [...options.discoveredContainers]
    : containerNameCandidates(config, branch).filter((name) => existing.includes(name));

  const workspace = cleanupTarget.workspace;
  const identities: SandboxWorkspaceKey[] = [workspace];
  const containers = options.discoveredContainers
    ? matchedContainers
    : [...new Set([...containerNameCandidates(config, effectiveBranch), ...matchedContainers])];
  const controlRoots = containers.flatMap((container) => identities.map((identity) => sandboxControlPaths({
    base: config.controlBase, project: config.project, container, identity
  }).root));
  const workspaceViewRoots = containers.flatMap((container) => identities.map((identity) => sandboxWorkspaceViewPaths({
    base: config.workspaceViewBase, project: config.project, container, identity
  }).root));
  const managedPathCandidates = [...new Set([
    ...worktreeCandidates,
    ...toolCandidates.flatMap(({ candidates }) => candidates),
    ...shellCandidates,
    shareBranchDir(config, branch),
    ...controlRoots,
    ...workspaceViewRoots
  ].map((candidate) => path.resolve(candidate)))];

  return {
    branch,
    effectiveBranch,
    engine,
    matchedContainers,
    existingWorktrees: worktreeCandidates.filter((candidate) => fs.existsSync(candidate)),
    toolCandidates,
    managedPathCandidates,
    workspace,
    controlRoots: [...new Set(controlRoots)],
    workspaceViewRoots: [...new Set(workspaceViewRoots)]
  };
}

function assertRemoved(target: string, label: string): void {
  if (fs.existsSync(target)) throw new Error(`${label} still exists after removal: ${target}`);
}

function sandboxContainersRemoved(engine: string, containers: readonly string[]): boolean {
  if (containers.length === 0) return true;
  const remaining = new Set(runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .filter(Boolean));
  return containers.every((container) => !remaining.has(container));
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
    isCancel = p.isCancel,
    recovery = new Map<string, WorktreeRecoveryContext>()
  }: PromptDependencies & { interactive?: boolean; recovery?: ReadonlyMap<string, WorktreeRecoveryContext> } = {}
): Promise<Map<string, WorktreeRemovalPermit>> {
  const inspections = worktrees.map((worktree) => {
    const inspection = inspectWorktrees([worktree])[0]!;
    const context = recovery.get(path.resolve(worktree));
    return inspection.status === 'failed' && context
      ? inspectRecoveredWorktree(worktree, context)
      : inspection;
  });
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
      message: 'Discard this worktree and all its uncommitted changes, including later changes?',
      initialValue: false
    });
    if (isCancel(confirmed) || !confirmed) throw new Error('Dirty worktree removal cancelled; nothing was deleted');
    permits.set(inspection.snapshot.worktree, createDiscardPermit(inspection.snapshot));
  }
  return permits;
}

async function runRmOne(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<null> {
  const target = options.target ?? resolveRmTarget(
    config,
    tools,
    options.cleanupTarget ?? resolveSandboxCleanupTarget(branch, config.repoRoot)
  );
  return rmOneCore(config, tools, branch, { ...options, target });
}

async function rmOne(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<void> {
  await runRmOne(config, tools, branch, options);
}

async function removeUncheckedSandbox(
  config: SandboxConfig,
  target: RmTarget,
  options: RmOneOptions
): Promise<null> {
  const confirm = options.prompt?.confirm ?? p.confirm;
  const isCancel = options.prompt?.isCancel ?? p.isCancel;
  const { effectiveBranch, engine, matchedContainers, existingWorktrees, toolCandidates, controlRoots, workspaceViewRoots } = target;

  if (!options.quiet) p.intro(pc.cyan(`Removing sandbox for ${target.branch}`));

  const shouldRemoveWorktree = existingWorktrees.length > 0 && !options.assumeYes
    ? await confirm({ message: `Remove worktree(s): ${existingWorktrees.join(', ')}?`, initialValue: true })
    : existingWorktrees.length > 0;
  if (isCancel(shouldRemoveWorktree)) {
    if (!options.quiet) p.outro('Cancelled');
    return null;
  }

  const shouldDeleteBranch = Boolean(shouldRemoveWorktree) && existingWorktrees.length > 0 && !options.assumeYes
    ? await confirm({ message: `Also delete local branch '${effectiveBranch}'?`, initialValue: true })
    : Boolean(shouldRemoveWorktree) && existingWorktrees.length > 0;
  if (isCancel(shouldDeleteBranch)) {
    if (!options.quiet) p.outro('Cancelled');
    return null;
  }

  const sharePath = path.resolve(shareBranchDir(config, effectiveBranch));
  const shouldRemoveShare = fs.existsSync(sharePath) && !options.assumeYes
    ? await confirm({ message: `Remove share dir for branch '${effectiveBranch}' (${sharePath})?`, initialValue: true })
    : fs.existsSync(sharePath);
  if (isCancel(shouldRemoveShare)) {
    if (!options.quiet) p.outro('Cancelled');
    return null;
  }

  const worktreePermits = options.permits ?? await authorizeWorktrees(
    existingWorktrees,
    { allowDirtyDiscard: true, assumeYes: Boolean(options.assumeYes) },
    { ...options.prompt, interactive: options.interactive }
  );

  for (const container of matchedContainers) runSafeEngine(engine, 'docker', ['rm', '-f', container]);
  if (!sandboxContainersRemoved(engine, matchedContainers)) {
    throw new Error(`SANDBOX_REMOVAL_CONTAINER_STILL_PRESENT: ${matchedContainers.join(', ')}`);
  }
  for (const root of controlRoots) {
    fs.rmSync(root, { recursive: true, force: true });
    if (target.workspace.mode !== 'task-bound') {
      removeEmptyManagedParent(path.join(config.controlBase, config.project), root);
    }
  }
  for (const root of workspaceViewRoots) {
    fs.rmSync(root, { recursive: true, force: true });
    removeEmptyManagedParent(path.join(config.workspaceViewBase, config.project), root);
  }
  const toolRemovalFailures: string[] = [];
  for (const candidate of toolCandidates.flatMap(({ candidates }) => candidates)) {
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      continue;
    } catch (initialError) {
      if (isPermissionRemovalError(initialError)) {
        try {
          addOwnerWriteToDirectories(candidate);
          fs.rmSync(candidate, { recursive: true, force: true });
          continue;
        } catch (retryError) {
          toolRemovalFailures.push(`${candidate}: ${removalErrorMessage(initialError)}; retry failed: ${removalErrorMessage(retryError)}`);
        }
      } else {
        toolRemovalFailures.push(`${candidate}: ${removalErrorMessage(initialError)}`);
      }
    }
  }
  for (const shell of shellConfigDirCandidates(config, effectiveBranch)) fs.rmSync(shell, { recursive: true, force: true });
  if (shouldRemoveShare) fs.rmSync(sharePath, { recursive: true, force: true });
  if (shouldRemoveWorktree) {
    for (const worktree of existingWorktrees) {
      const permit = worktreePermits.get(path.resolve(worktree));
      if (!permit) throw new Error(`SANDBOX_WORKTREE_REMOVAL_PERMIT_MISSING: ${worktree}`);
      removeWorktreeDir(config.repoRoot, config.worktreeBase, worktree, permit);
    }
  }
  if (shouldDeleteBranch) {
    assertBranchRemovalIdentity(config, effectiveBranch, worktreePermits);
    runSafe('git', ['-C', config.repoRoot, 'branch', '-D', effectiveBranch]);
  }
  if (toolRemovalFailures.length > 0) {
    throw new Error(`SANDBOX_TOOL_CLEANUP_INCOMPLETE:\n${toolRemovalFailures.map((failure) => `  - ${failure}`).join('\n')}`);
  }
  releaseTaskBoundSandboxIdentity(config.repoRoot, target.workspace);

  if (!options.quiet) p.outro('Sandbox removed');
  return null;
}

function releaseTaskBoundSandboxIdentity(
  repoRoot: string,
  workspace: SandboxWorkspaceKey
): void {
  if (workspace.mode === 'task-bound') releaseStaleShortIdRegistry(repoRoot, workspace.taskId);
}

async function rmOneCore(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<null> {
  const target = options.target ?? resolveRmTarget(
    config,
    tools,
    options.cleanupTarget ?? resolveSandboxCleanupTarget(branch, config.repoRoot)
  );
  return removeUncheckedSandbox(config, target, options);
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
  const listed = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config),
    { mode: sandboxWorkspaceModeLabel(config), taskId: sandboxTaskIdLabel(config) }
  );
  const rows = [...listed.running, ...listed.nonRunning];
  const containers = runEngine(engine, 'docker', [
    'ps', '-a', '--filter', `label=${sandboxLabel(config)}`, '--format', '{{.Names}}'
  ]).split('\n').filter(Boolean);
  const controlRoots = rows.flatMap((row) => {
    if (!row.branch) return [];
    const identity = row.workspaceMode === 'task-bound' && row.taskId
      ? { mode: 'task-bound' as const, taskId: row.taskId }
      : row.workspaceMode === 'branch-only'
        ? { mode: 'branch-only' as const }
        : null;
    if (!identity) return [];
    return [sandboxControlPaths({
      base: config.controlBase, project: config.project,
      container: row.name, identity
    }).root];
  });
  const completedTaskIds = [...new Set(rows
    .filter((row) => row.workspaceMode === 'task-bound' && row.taskId)
    .map((row) => row.taskId!))];
  for (const name of containers) runSafeEngine(engine, 'docker', ['rm', '-f', name]);
  if (!sandboxContainersRemoved(engine, containers)) {
    throw new Error(`SANDBOX_REMOVAL_CONTAINER_STILL_PRESENT: ${containers.join(', ')}`);
  }

  let cleanupCompleted = true;

  const worktrees = fs.existsSync(config.worktreeBase)
    ? fs.readdirSync(config.worktreeBase).map((entry) => path.join(config.worktreeBase, entry))
    : [];
  if (worktrees.length > 0) {
    const selected = await confirm({ message: `Remove all worktrees in ${config.worktreeBase}?`, initialValue: true });
    if (!isCancel(selected) && selected) {
      for (const worktree of worktrees) fs.rmSync(worktree, { recursive: true, force: true });
      runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
    } else cleanupCompleted = false;
  }

  for (const dir of projectToolDirs(config, tools)) fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(config.shellConfigBase)) {
    const selected = await confirm({ message: `Remove all shell config dirs in ${config.shellConfigBase}?`, initialValue: true });
    if (!isCancel(selected) && selected) fs.rmSync(config.shellConfigBase, { recursive: true, force: true });
    else cleanupCompleted = false;
  }
  if (fs.existsSync(config.shareBase)) {
    const selected = await confirm({ message: `Remove all share dirs for project (${config.shareBase})?`, initialValue: true });
    if (!isCancel(selected) && selected) fs.rmSync(config.shareBase, { recursive: true, force: true });
    else cleanupCompleted = false;
  }
  fs.rmSync(path.join(config.workspaceViewBase, config.project), { recursive: true, force: true });
  for (const root of new Set(controlRoots)) fs.rmSync(root, { recursive: true, force: true });
  if (cleanupCompleted) {
    for (const taskId of completedTaskIds) releaseStaleShortIdRegistry(config.repoRoot, taskId);
  }
  const removeImage = await confirm({ message: `Remove image ${config.imageName}?`, initialValue: false });
  if (!isCancel(removeImage) && removeImage) runSafeEngine(engine, 'docker', ['rmi', config.imageName]);
  p.outro(pc.green('All project sandboxes removed'));
}

async function rmUnbound(
  config: SandboxConfig,
  tools: SandboxTool[],
  options: { dryRun: boolean; assumeYes: boolean }
): Promise<void> {
  const engine = detectEngine(config);
  const listed = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config),
    { mode: sandboxWorkspaceModeLabel(config), taskId: sandboxTaskIdLabel(config) }
  );
  const discovered = [...listed.running, ...listed.nonRunning];
  const branchMismatches: Array<{ container: string; labelBranch: string; taskBranch: string }> = [];
  const classified = discovered.map((row) => {
    if (!row.branch) return { row, protected: true, cleanupTarget: null };
    if (row.workspaceMode === 'task-bound' && row.taskId) {
      try {
        resolveSandboxTarget(row.taskId, config.repoRoot);
        return { row, protected: true, cleanupTarget: null };
      } catch {
        try {
          const cleanupTarget = resolveSandboxCleanupTarget(row.taskId, config.repoRoot, { allowProtected: true });
          if (cleanupTarget.taskState === 'blocked'
            || cleanupTarget.taskState === 'completed'
            || cleanupTarget.taskState === 'archive') {
            if (row.branch !== cleanupTarget.branch) {
              branchMismatches.push({ container: row.name, labelBranch: row.branch, taskBranch: cleanupTarget.branch });
              return { row, protected: true, cleanupTarget: null };
            }
            const activeBranchTarget = resolveSandboxTarget(cleanupTarget.branch, config.repoRoot);
            if (activeBranchTarget.workspace.mode === 'branch-only') {
              return { row, protected: false, cleanupTarget };
            }
          }
        } catch {
          // An unresolved task identity has no active short-id evidence, so keep it out of bulk cleanup.
        }
        return { row, protected: true, cleanupTarget: null };
      }
    }
    if (row.workspaceMode !== 'branch-only') return { row, protected: true, cleanupTarget: null };
    const cleanupTarget = resolveSandboxCleanupTarget(row.branch, config.repoRoot);
    return cleanupTarget.workspace.mode === 'branch-only'
      ? { row, protected: false, cleanupTarget }
      : { row, protected: true, cleanupTarget: null };
  });
  const protectedBranches = new Set(classified
    .filter((entry) => entry.protected)
    .map(({ row }) => row.branch));
  const targets = classified
    .filter((entry) => !entry.protected && !protectedBranches.has(entry.row.branch) && entry.cleanupTarget)
    .map(({ row, cleanupTarget }) => ({
      row,
      cleanupTarget: cleanupTarget!,
      target: resolveRmTarget(config, tools, cleanupTarget!, { discoveredContainers: [row.name] })
    }));
  p.intro(pc.cyan(`Removing sandboxes for ${config.project}`));
  for (const mismatch of branchMismatches) {
    p.log.warn(`Skipping task-bound sandbox '${mismatch.container}': container branch '${mismatch.labelBranch}' differs from task record branch '${mismatch.taskBranch}'. Inspect the task record and container labels before retrying cleanup.`);
  }
  if (options.dryRun) {
    p.outro(`Dry run: ${targets.length} sandbox(es) found, nothing deleted`);
    return;
  }
  for (const { cleanupTarget, target } of targets) {
    await runRmOne(config, tools, cleanupTarget.branch, {
      assumeYes: options.assumeYes,
      target,
      cleanupTarget
    });
  }
  p.outro(pc.green(`Removed ${targets.length} sandbox(es)`));
}
export { authorizeWorktrees, rmOne, rmPurge, rmUnbound };
