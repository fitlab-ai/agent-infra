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
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel,
  shareBranchDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from '../constants.ts';
import { ENGINES, detectEngine, engineDisplayName, isManagedEngine, stopManagedVm } from '../engine.ts';
import { pruneSandboxDanglingImages } from '../image-prune.ts';
import { assertManagedPath, removeManagedDir, removeWorktreeDir } from '../managed-fs.ts';
import { runEngine, runOk, runOkEngine, runSafe, runSafeEngine } from '../shell.ts';
import {
  parseSandboxWorkspaceIdentity,
  resolveSandboxTarget,
  sameSandboxWorkspaceIdentity,
  type SandboxWorkspaceIdentity
} from '../workspace-identity.ts';
import { sandboxControlPaths, sandboxWorkspaceViewPaths } from '../workspace-view.ts';
import { removeSandboxControlRoot, readSandboxControlManifest } from '../control/lifecycle.ts';
import { inspectSandboxControlContainer } from '../control/container-identity.ts';
import { toolConfigDirCandidates, toolProjectDirCandidates } from '../tools.ts';
import { createSandboxCapabilityPlan } from '../agent-client-reconciler.ts';
import type { SandboxTool } from '../tools.ts';
import { fetchSandboxRows } from './list-running.ts';
import { lookupShortIdByBranch } from '../../task/short-id.ts';
import {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectRecoveredWorktree,
  inspectWorktrees,
  verifyWorktreePermit
} from '../worktree-safety.ts';
import type {
  WorktreeInspection,
  WorktreeRecoveryContext,
  WorktreeRemovalPermit
} from '../worktree-safety.ts';

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
  interactive?: boolean;
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

function recoveryContexts(
  config: SandboxConfig,
  target: RmTarget,
  worktrees: readonly string[]
): Map<string, WorktreeRecoveryContext> {
  const candidates = worktreeDirCandidates(config, target.effectiveBranch).map((candidate) => path.resolve(candidate));
  const existingCandidates = candidates.filter((candidate) => fs.existsSync(candidate));
  if (existingCandidates.length !== 1) return new Map();

  const resolvedWorkspace = resolveSandboxTarget(target.effectiveBranch, config.repoRoot).workspace;
  const sameWorkspace = resolvedWorkspace.mode === target.workspace.mode
    && (resolvedWorkspace.mode !== 'task-bound'
      || (target.workspace.mode === 'task-bound' && resolvedWorkspace.taskId === target.workspace.taskId));
  if (!sameWorkspace) return new Map();

  const contexts = new Map<string, WorktreeRecoveryContext>();
  for (const worktree of worktrees) {
    const resolvedWorktree = path.resolve(worktree);
    if (resolvedWorktree !== existingCandidates[0]) continue;
    for (const root of target.controlRoots.filter((candidate) => fs.existsSync(candidate))) {
      assertLegacyCandidateEvidence(root, config.controlBase, config, target.effectiveBranch, target.matchedContainers);
      assertControlRootMatchesTarget(root, target.effectiveBranch, target.workspace);
    }
    contexts.set(resolvedWorktree, {
      repoRoot: config.repoRoot,
      worktreeBase: config.worktreeBase,
      branch: target.effectiveBranch,
      identitySource: target.workspace.mode,
      taskId: target.workspace.mode === 'task-bound' ? target.workspace.taskId : null
    });
  }
  return contexts;
}

function resolveRmTarget(config: SandboxConfig, tools: SandboxTool[], branch: string): RmTarget {
  assertValidBranchName(branch);
  const engine = detectEngine(config);
  const effectiveBranch = branch;
  const worktreeCandidates = worktreeDirCandidates(config, branch);
  const toolCandidates = tools.map((tool) => ({
    tool,
    candidates: toolConfigDirCandidates(tool, config.project, branch)
  }));
  const existing = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const matchedContainers = containerNameCandidates(config, branch).filter((name) => existing.includes(name));

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

function assertMatchedContainerIdentities(config: SandboxConfig, target: RmTarget): void {
  for (const container of target.matchedContainers) {
    const rawLabels = runSafeEngine(target.engine, 'docker', [
      'inspect', '--format', '{{json .Config.Labels}}', container
    ]).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLabels);
    } catch {
      throw new Error(`SANDBOX_WORKSPACE_IDENTITY_UNKNOWN: container '${container}' labels are invalid`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`SANDBOX_WORKSPACE_IDENTITY_UNKNOWN: container '${container}' labels are incomplete`);
    }
    const labels = parsed as Record<string, unknown>;
    if (Object.values(labels).some((value) => typeof value !== 'string')) {
      throw new Error(`SANDBOX_WORKSPACE_IDENTITY_UNKNOWN: container '${container}' labels are incomplete`);
    }
    const stringLabels = labels as Record<string, string>;
    const branch = stringLabels[sandboxBranchLabel(config)];
    if (branch !== target.branch) {
      throw new Error(
        `SANDBOX_WORKSPACE_IDENTITY_CONFLICT: container '${container}' branch is ${JSON.stringify(branch ?? null)}, `
        + `but this request is ${JSON.stringify(target.branch)}`
      );
    }
    const identity = parseSandboxWorkspaceIdentity(stringLabels, {
      mode: sandboxWorkspaceModeLabel(config),
      taskId: sandboxTaskIdLabel(config)
    });
    if (identity.mode === 'legacy-invalid' || !sameSandboxWorkspaceIdentity(identity, target.workspace)) {
      const existingDescription = identity.mode === 'task-bound'
        ? `task-bound:${identity.taskId}`
        : identity.mode;
      const requestedDescription = target.workspace.mode === 'task-bound'
        ? `task-bound:${target.workspace.taskId}`
        : target.workspace.mode;
      throw new Error(
        `SANDBOX_WORKSPACE_IDENTITY_CONFLICT: container '${container}' is ${existingDescription}, `
        + `but this request is ${requestedDescription}`
      );
    }
  }
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

async function removeExactSandboxContainer(
  engine: string,
  manifest: ReturnType<typeof readSandboxControlManifest>,
  timeoutMs: number
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadlineAt - Date.now());
  const inspect = () => inspectSandboxControlContainer(manifest, { timeoutMs: remaining() });
  const before = await inspect();
  if (before.state === 'unknown') throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${before.reason}`);
  if (before.state === 'absent') return;
  if (before.running && !runOkEngine(engine, 'docker', ['stop', manifest.containerIdentity.id], { timeout: remaining() })) {
    const afterStop = await inspect();
    if (afterStop.state !== 'absent' && afterStop.state !== 'found') {
      throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${afterStop.reason}`);
    }
    if (afterStop.state === 'found' && afterStop.running) {
      throw new Error(`Failed to stop sandbox container: ${manifest.containerIdentity.id}`);
    }
  }
  const afterStop = await inspect();
  if (afterStop.state === 'unknown') throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${afterStop.reason}`);
  if (afterStop.state === 'found' && !runOkEngine(engine, 'docker', ['rm', manifest.containerIdentity.id], { timeout: remaining() })) {
    const afterRemove = await inspect();
    if (afterRemove.state !== 'absent') {
      throw new Error(`Failed to remove sandbox container: ${manifest.containerIdentity.id}`);
    }
  }
}

async function removeProjectControlRoots(config: SandboxConfig, engine: string): Promise<Set<string>> {
  const containers = new Set<string>();
  const projectRoot = path.join(config.controlBase, config.project);
  if (!fs.existsSync(projectRoot)) return containers;
  assertManagedPath(config.controlBase, projectRoot);
  const projectStat = fs.lstatSync(projectRoot);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  for (const container of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!container.isDirectory() || container.isSymbolicLink()) continue;
    const containerRoot = path.join(projectRoot, container.name);
    for (const identity of fs.readdirSync(containerRoot, { withFileTypes: true })) {
      if (!identity.isDirectory() || identity.isSymbolicLink()) continue;
      const root = path.join(containerRoot, identity.name);
      const manifestPath = path.join(root, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: ${root}`);
      const manifest = readSandboxControlManifest(manifestPath);
      containers.add(manifest.container);
      await removeSandboxControlRoot(root, {
        inspectContainer: (timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }),
        removeContainer: (timeoutMs) => removeExactSandboxContainer(engine, manifest, timeoutMs)
      });
    }
  }
  return containers;
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
  assertMatchedContainerIdentities(config, target);
  const confirm = options.prompt?.confirm ?? p.confirm;
  const isCancel = options.prompt?.isCancel ?? p.isCancel;

  if (!options.quiet) {
    p.intro(pc.cyan(`Removing sandbox for ${branch}`));
  }

  const recovery = options.permits
    ? new Map<string, WorktreeRecoveryContext>()
    : recoveryContexts(config, target, existingWorktrees);
  const permits = options.permits
    ? new Map(options.permits)
    : await authorizeWorktrees(existingWorktrees, {
        allowDirtyDiscard: options.allowDirtyDiscard ?? true,
        assumeYes: Boolean(options.assumeYes)
      }, {
        ...options.prompt,
        interactive: options.interactive ?? Boolean(process.stdin.isTTY),
        recovery
      });
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

  const coordinatedContainers = new Set<string>();
  for (const root of controlRoots.filter((candidate) => fs.existsSync(candidate))) {
    assertLegacyCandidateEvidence(root, config.controlBase, config, effectiveBranch, matchedContainers);
    assertControlRootMatchesTarget(root, effectiveBranch, workspace);
    const manifest = readSandboxControlManifest(path.join(root, 'manifest.json'));
    coordinatedContainers.add(manifest.container);
    await removeSandboxControlRoot(root, {
      inspectContainer: (timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }),
      removeContainer: (timeoutMs) => removeExactSandboxContainer(engine, manifest, timeoutMs)
    });
    removeEmptyManagedParent(path.join(config.controlBase, config.project), root);
  }

  const uncoordinatedContainers = matchedContainers.filter((name) => !coordinatedContainers.has(name));
  if (uncoordinatedContainers.length > 0) {
    const spinner = p.spinner();
    spinner.start(`Stopping container(s): ${uncoordinatedContainers.join(', ')}`);
    for (const name of uncoordinatedContainers) {
      if (!runOkEngine(engine, 'docker', ['stop', name])) throw new Error(`Failed to stop sandbox container: ${name}`);
      if (!runOkEngine(engine, 'docker', ['rm', name])) throw new Error(`Failed to remove sandbox container: ${name}`);
    }
    const remaining = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
    const leftovers = uncoordinatedContainers.filter((name) => remaining.includes(name));
    if (leftovers.length > 0) throw new Error(`Sandbox container(s) still exist after removal: ${leftovers.join(', ')}`);
    spinner.stop(pc.green(`Removed container(s): ${uncoordinatedContainers.join(', ')}`));
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

  const coordinatedContainers = await removeProjectControlRoots(config, engine);

  const containers = runEngine(engine, 'docker', [
    'ps',
    '-a',
    '--filter',
    `label=${sandboxLabel(config)}`,
    '--format',
    '{{.Names}}'
  ]);
  const uncoordinatedContainers = containers.split('\n').filter((name) => name && !coordinatedContainers.has(name));
  if (uncoordinatedContainers.length > 0) {
    const spinner = p.spinner();
    spinner.start('Stopping project sandbox containers...');
    for (const name of uncoordinatedContainers) {
      if (!runOkEngine(engine, 'docker', ['stop', name])) throw new Error(`Failed to stop sandbox container: ${name}`);
      if (!runOkEngine(engine, 'docker', ['rm', name])) throw new Error(`Failed to remove sandbox container: ${name}`);
    }
    const remaining = runEngine(engine, 'docker', [
      'ps', '-a', '--filter', `label=${sandboxLabel(config)}`, '--format', '{{.Names}}'
    ]);
    const leftovers = remaining.split('\n').filter((name) => name && !coordinatedContainers.has(name));
    if (leftovers.length > 0) throw new Error(`Project sandbox container(s) still exist after removal: ${leftovers.join(', ')}`);
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
