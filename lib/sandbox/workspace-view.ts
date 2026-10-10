import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxWorkspaceIdentity, SandboxWorkspaceKey } from './workspace-identity.ts';
import { resolveTaskWorkspace } from './task-resolver.ts';
import type { SandboxControlManifest } from './control/protocol.ts';
import { resolveTaskRuntimeRoot } from '../task/runtime-paths.ts';
import {
  createSandboxControlIdentitySentinel,
  writeSandboxControlIdentitySentinel
} from './control/identity-sentinel.ts';

export type SandboxWorkspaceView = Readonly<{
  root: string;
}>;

export const SANDBOX_WORKSPACE_VIEW_STATES = Object.freeze([
  'active',
  'completed',
  'blocked',
  'archive'
] as const);

export function sandboxWorkspaceViewStatePaths(root: string): ReadonlyArray<Readonly<{
  state: typeof SANDBOX_WORKSPACE_VIEW_STATES[number];
  hostPath: string;
}>> {
  return SANDBOX_WORKSPACE_VIEW_STATES.map((state) => ({
    state,
    hostPath: path.join(root, state)
  }));
}

export function sandboxWorkspaceViewPaths(params: Readonly<{
  base: string;
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity | SandboxWorkspaceKey;
}>): SandboxWorkspaceView {
  const identityKey = params.identity.mode === 'task-bound'
    ? `task-bound:${params.identity.taskId}`
    : 'branch-only';
  const digest = createHash('sha256').update(identityKey).digest('hex').slice(0, 16);
  const projectRoot = path.resolve(params.base, params.project);
  const root = path.resolve(projectRoot, params.container, digest);
  return { root };
}

export type SandboxControlSetup = Readonly<{
  root: string;
  channelDir: string;
  statusDir: string;
  runtimeDir: string;
  manifestPath: string;
  manifestDraft: SandboxControlManifestDraft;
  token: string;
  generation: string;
  controlRootId: string;
}>;

export type SandboxControlManifestDraft = Readonly<Omit<SandboxControlManifest, 'containerIdentity' | 'engine' | 'authorityEvidence'> & {
  engine: string;
}>;

export function sandboxControlPaths(params: Readonly<{
  base: string;
  repoRoot?: string;
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity | SandboxWorkspaceKey;
}>): Readonly<{ root: string; channelDir: string; statusDir: string; processingDir: string; runtimeDir: string; manifestPath: string }> {
  const root = params.identity.mode === 'task-bound'
    ? path.join(resolveTaskRuntimeRoot(params.identity.taskId, { repoRoot: params.repoRoot }), 'sandbox-control')
    : (() => {
      const digest = createHash('sha256').update('branch-only').digest('hex').slice(0, 16);
      return path.resolve(params.base, params.project, params.container, digest);
    })();
  return {
    root,
    channelDir: path.join(root, 'channel'),
    statusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    runtimeDir: path.join(root, 'runtime'),
    manifestPath: path.join(root, 'manifest.json')
  };
}

function assertSafeDirectory(directory: string, expectedBase: string): void {
  const relative = path.relative(expectedBase, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Sandbox workspace view escapes its configured root: ${directory}`);
  }
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Sandbox workspace view must not be a symbolic link: ${directory}`);
  }
}

function assertSafeMountTargetPath(
  target: string,
  worktreeRoot: string,
  canonicalWorktreeRoot: string
): void {
  const relative = path.relative(worktreeRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Sandbox workspace mount target escapes its worktree: ${target}`);
  }
  let current = worktreeRoot;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = segment ? path.join(current, segment) : current;
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Sandbox workspace mount target must not contain a symbolic link: ${current}`);
      }
      const canonicalRelative = path.relative(canonicalWorktreeRoot, fs.realpathSync.native(current));
      if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
        throw new Error(`Sandbox workspace mount target escapes its real worktree: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function assertSandboxTaskSource(repoRoot: string, taskId: string): string {
  if (!/^TASK-\d{8}-\d{6}$/.test(taskId)) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  const activeSource = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  try {
    const stat = fs.lstatSync(activeSource);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`SANDBOX_TASK_SOURCE_INVALID: ${activeSource} must be a real directory`);
    }
    const canonical = fs.realpathSync.native(activeSource);
    const activeRoot = fs.realpathSync.native(path.dirname(activeSource));
    const workspaceRoot = fs.realpathSync.native(path.join(repoRoot, '.agents', 'workspace'));
    const relative = path.relative(workspaceRoot, canonical);
    if (path.dirname(canonical) !== activeRoot || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`SANDBOX_TASK_SOURCE_INVALID: ${activeSource} escapes the task workspace`);
    }
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const task = resolveTaskWorkspace(taskId, repoRoot);
  const source = task.state === 'archive'
    ? path.dirname(path.dirname(task.taskMd))
    : path.dirname(task.taskMd);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`SANDBOX_TASK_SOURCE_INVALID: ${source} must be a real directory`);
  }
  const canonical = fs.realpathSync.native(source);
  const workspaceRoot = fs.realpathSync.native(path.join(repoRoot, '.agents', 'workspace'));
  const relative = path.relative(workspaceRoot, canonical);
  if (path.basename(canonical) !== taskId || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`SANDBOX_TASK_SOURCE_INVALID: ${source} escapes the task workspace`);
  }
  return canonical;
}

export function prepareSandboxWorkspaceMountTargets(worktreeRoot: string, taskId?: string): void {
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);
  const canonicalWorktreeRoot = fs.realpathSync.native(resolvedWorktreeRoot);
  const workspaceRoot = path.resolve(resolvedWorktreeRoot, '.agents', 'workspace');
  const statePaths = sandboxWorkspaceViewStatePaths(workspaceRoot);
  const registryTarget = path.join(workspaceRoot, 'active', '.short-ids.json');
  const completedTaskTarget = taskId ? path.join(workspaceRoot, 'completed', taskId) : null;
  if (taskId && !/^TASK-\d{8}-\d{6}$/.test(taskId)) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  for (const target of [workspaceRoot, ...statePaths.map(({ hostPath }) => hostPath), registryTarget, ...(completedTaskTarget ? [completedTaskTarget] : [])]) {
    assertSafeMountTargetPath(target, resolvedWorktreeRoot, canonicalWorktreeRoot);
  }
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  for (const { hostPath } of statePaths) {
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(hostPath, 0o700);
  }
  if (completedTaskTarget) fs.mkdirSync(completedTaskTarget, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspaceRoot, 0o700);
  fs.closeSync(fs.openSync(registryTarget, 'a', 0o600));
}

export function prepareSandboxCompletedTaskMountSource(repoRoot: string, taskId: string): string {
  if (!/^TASK-\d{8}-\d{6}$/.test(taskId)) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  const workspaceRoot = path.resolve(repoRoot, '.agents', 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, 'completed'), { recursive: true, mode: 0o700 });
  const completedRoot = path.join(workspaceRoot, 'completed');
  const completedStat = fs.lstatSync(completedRoot);
  if (!completedStat.isDirectory() || completedStat.isSymbolicLink()) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  const target = path.join(completedRoot, taskId);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length > 0) {
      throw new Error(`SANDBOX_COMPLETED_MOUNT_CONFLICT: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(target, { mode: 0o700 });
  }
  const canonicalWorkspace = fs.realpathSync.native(workspaceRoot);
  const canonicalTarget = fs.realpathSync.native(target);
  const relative = path.relative(canonicalWorkspace, canonicalTarget);
  const canonicalRepoRoot = fs.realpathSync.native(repoRoot);
  const workspaceRelative = path.relative(canonicalRepoRoot, canonicalWorkspace);
  if (workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)
    || path.dirname(canonicalTarget) !== fs.realpathSync.native(completedRoot)
    || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  return canonicalTarget;
}

export function sandboxCompletedTaskMountSource(repoRoot: string, taskId: string): string {
  if (!/^TASK-\d{8}-\d{6}$/.test(taskId)) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  const source = path.resolve(repoRoot, '.agents', 'workspace', 'completed', taskId);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  const canonicalWorkspace = fs.realpathSync.native(path.join(repoRoot, '.agents', 'workspace'));
  const canonicalSource = fs.realpathSync.native(source);
  const canonicalRepoRoot = fs.realpathSync.native(repoRoot);
  const workspaceRelative = path.relative(canonicalRepoRoot, canonicalWorkspace);
  const relative = path.relative(canonicalWorkspace, canonicalSource);
  if (workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)
    || path.dirname(canonicalSource) !== fs.realpathSync.native(path.dirname(source))
    || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SANDBOX_TASK_SOURCE_INVALID');
  return canonicalSource;
}

export function materializeSandboxWorkspaceView(params: Readonly<{
  base: string;
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity | SandboxWorkspaceKey;
}>): SandboxWorkspaceView {
  const projectRoot = path.resolve(params.base, params.project);
  const { root } = sandboxWorkspaceViewPaths(params);
  assertSafeDirectory(projectRoot, path.resolve(params.base));
  assertSafeDirectory(root, projectRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const { hostPath } of sandboxWorkspaceViewStatePaths(root)) {
    assertSafeDirectory(hostPath, root);
    fs.rmSync(hostPath, { recursive: true, force: true });
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
  }

  const active = path.join(root, 'active');
  const shortId = params.identity.mode === 'task-bound' && 'shortId' in params.identity
    ? params.identity.shortId
    : null;
  const registry = {
    version: 1,
    ids: shortId !== null && params.identity.mode === 'task-bound'
      ? { [shortId]: params.identity.taskId }
      : {}
  };
  fs.writeFileSync(path.join(active, '.short-ids.json'), `${JSON.stringify(registry)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return { root };
}

export function materializeSandboxControl(params: Readonly<{
  base: string;
  repoRoot: string;
  worktreeRoot: string;
  project: string;
  container: string;
  branch: string;
  identity: SandboxWorkspaceIdentity | SandboxWorkspaceKey;
  engine?: string;
  replacementLease?: Readonly<{
    root: string;
    assertOwned(): void;
  }>;
}>): SandboxControlSetup {
  const { root, channelDir, statusDir, processingDir, runtimeDir, manifestPath } = sandboxControlPaths(params);
  assertSafeDirectory(root, params.identity.mode === 'task-bound' ? path.dirname(root) : path.resolve(params.base));
  if (fs.existsSync(root)) {
    if (!params.replacementLease || path.resolve(params.replacementLease.root) !== root) {
      throw new Error('SANDBOX_CONTROL_REPLACEMENT_REQUIRED');
    }
    params.replacementLease.assertOwned();
  }
  const consumedDir = path.join(root, 'consumed');
  assertSafeDirectory(consumedDir, root);
  fs.rmSync(consumedDir, { recursive: true, force: true });
  fs.mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
  for (const directory of [statusDir, processingDir, runtimeDir]) {
    assertSafeDirectory(directory, root);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  for (const queue of ['requests', 'responses']) {
    const directory = path.join(channelDir, queue);
    assertSafeDirectory(directory, root);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString('hex');
  const generation = randomBytes(16).toString('hex');
  const identitySentinel = createSandboxControlIdentitySentinel({
    mode: params.identity.mode,
    taskId: params.identity.mode === 'task-bound' ? params.identity.taskId : null,
    generation
  });
  writeSandboxControlIdentitySentinel(statusDir, identitySentinel);
  const repoRoot = fs.realpathSync.native(params.repoRoot);
  const manifestDraft: SandboxControlManifestDraft = {
    engine: params.engine ?? 'docker',
    repoRoot,
    worktreeRoot: fs.realpathSync.native(params.worktreeRoot),
    project: params.project,
    container: params.container,
    branch: params.branch,
    mode: params.identity.mode,
    taskId: params.identity.mode === 'task-bound' ? params.identity.taskId : null,
    token,
    generation,
    controlRootId: identitySentinel.controlRootId,
    channelDir,
    publicStatusDir: statusDir,
    processingDir,
    runtimeDir,
  };
  return { root, channelDir, statusDir, runtimeDir, manifestPath, manifestDraft, token, generation, controlRootId: identitySentinel.controlRootId };
}

export function finalizeSandboxControlManifest(
  setup: SandboxControlSetup,
  identity: Readonly<{
    engine: string;
    id: string;
    labels: Readonly<Record<string, string>>;
    authorityEvidence: SandboxControlManifest['authorityEvidence'];
  }>
): SandboxControlManifest {
  if (!identity.engine || !identity.id) throw new Error('SANDBOX_CONTROL_CONTAINER_ID_INVALID');
  const manifest: SandboxControlManifest = {
    ...setup.manifestDraft,
    engine: identity.engine,
    containerIdentity: { id: identity.id, labels: { ...identity.labels } },
    authorityEvidence: identity.authorityEvidence
  };
  const temporary = `${setup.manifestPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, setup.manifestPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return manifest;
}
