import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxWorkspaceIdentity, SandboxWorkspaceKey } from './workspace-identity.ts';
import type { SandboxControlManifest } from './control/protocol.ts';
import {
  createSandboxControlIdentitySentinel,
  writeSandboxControlIdentitySentinel
} from './control/identity-sentinel.ts';
import type { ProjectionAncestorIdentity } from './control/task-workflow.ts';

export type SandboxWorkspaceView = Readonly<{
  root: string;
  taskMountPath: string | null;
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
  return {
    root,
    taskMountPath: params.identity.mode === 'task-bound'
      ? path.join(root, 'active', params.identity.taskId)
      : null
  };
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
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity | SandboxWorkspaceKey;
}>): Readonly<{ root: string; channelDir: string; statusDir: string; processingDir: string; runtimeDir: string; manifestPath: string }> {
  const identityKey = params.identity.mode === 'task-bound'
    ? `task-bound:${params.identity.taskId}`
    : 'branch-only';
  const digest = createHash('sha256').update(identityKey).digest('hex').slice(0, 16);
  const root = path.resolve(params.base, params.project, params.container, digest);
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
  const activeRoot = fs.realpathSync.native(path.join(repoRoot, '.agents', 'workspace', 'active'));
  const source = path.join(activeRoot, taskId);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`SANDBOX_TASK_SOURCE_INVALID: ${source} must be a real directory`);
  }
  const canonical = fs.realpathSync.native(source);
  if (path.dirname(canonical) !== activeRoot) {
    throw new Error(`SANDBOX_TASK_SOURCE_INVALID: ${source} escapes the active workspace`);
  }
  return canonical;
}

function copyTaskProjection(source: string, target: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error('SANDBOX_TASK_PROJECTION_SOURCE_INVALID');
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyTaskProjection(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  if (!sourceStat.isFile()) throw new Error('SANDBOX_TASK_PROJECTION_SOURCE_INVALID');
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}

/** Materialize a writable candidate view without mounting authoritative task state. */
export function prepareSandboxTaskProjection(repoRoot: string, taskId: string, projectionRoot: string): string {
  const source = assertSandboxTaskSource(repoRoot, taskId);
  const resolvedProjection = path.resolve(projectionRoot);
  const projectionParent = path.dirname(resolvedProjection);
  fs.mkdirSync(projectionParent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(projectionParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('SANDBOX_TASK_PROJECTION_TOPOLOGY_INVALID');
  if (fs.existsSync(resolvedProjection)) {
    const existing = fs.lstatSync(resolvedProjection);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('SANDBOX_TASK_PROJECTION_TOPOLOGY_INVALID');
    fs.rmSync(resolvedProjection, { recursive: true, force: true });
  }
  fs.mkdirSync(resolvedProjection, { recursive: true, mode: 0o700 });
  copyTaskProjection(source, resolvedProjection);
  fs.chmodSync(resolvedProjection, 0o700);
  return resolvedProjection;
}

/** Refresh host-owned task metadata while preserving agent-produced artifacts. */
export function refreshSandboxTaskProjection(repoRoot: string, taskId: string, projectionRoot: string): string {
  const source = assertSandboxTaskSource(repoRoot, taskId);
  const resolvedProjection = path.resolve(projectionRoot);
  const projectionStat = fs.lstatSync(resolvedProjection);
  if (!projectionStat.isDirectory() || projectionStat.isSymbolicLink()) throw new Error('SANDBOX_TASK_PROJECTION_TOPOLOGY_INVALID');
  for (const name of ['task.md']) {
    const sourcePath = path.join(source, name);
    const targetPath = path.join(resolvedProjection, name);
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('SANDBOX_TASK_PROJECTION_SOURCE_INVALID');
    const temporary = path.join(resolvedProjection, `.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, targetPath);
  }
  return resolvedProjection;
}

export function prepareSandboxWorkspaceMountTargets(worktreeRoot: string): void {
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);
  const canonicalWorktreeRoot = fs.realpathSync.native(resolvedWorktreeRoot);
  const workspaceRoot = path.resolve(resolvedWorktreeRoot, '.agents', 'workspace');
  const statePaths = sandboxWorkspaceViewStatePaths(workspaceRoot);
  const registryTarget = path.join(workspaceRoot, 'active', '.short-ids.json');
  for (const target of [workspaceRoot, ...statePaths.map(({ hostPath }) => hostPath), registryTarget]) {
    assertSafeMountTargetPath(target, resolvedWorktreeRoot, canonicalWorktreeRoot);
  }
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  for (const { hostPath } of statePaths) {
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(hostPath, 0o700);
  }
  fs.chmodSync(workspaceRoot, 0o700);
  fs.closeSync(fs.openSync(registryTarget, 'a', 0o600));
}

export function materializeSandboxWorkspaceView(params: Readonly<{
  base: string;
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity;
}>): SandboxWorkspaceView {
  const projectRoot = path.resolve(params.base, params.project);
  const { root, taskMountPath } = sandboxWorkspaceViewPaths(params);
  assertSafeDirectory(projectRoot, path.resolve(params.base));
  assertSafeDirectory(root, projectRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const { hostPath } of sandboxWorkspaceViewStatePaths(root)) {
    assertSafeDirectory(hostPath, root);
    fs.rmSync(hostPath, { recursive: true, force: true });
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
  }

  const active = path.join(root, 'active');
  const registry = {
    version: 1,
    ids: params.identity.mode === 'task-bound'
      ? { [params.identity.shortId]: params.identity.taskId }
      : {}
  };
  fs.writeFileSync(path.join(active, '.short-ids.json'), `${JSON.stringify(registry)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  if (taskMountPath) {
    assertSafeDirectory(taskMountPath, active);
    fs.mkdirSync(taskMountPath, { recursive: true, mode: 0o700 });
  }
  return { root, taskMountPath };
}

export function materializeSandboxControl(params: Readonly<{
  base: string;
  repoRoot: string;
  worktreeRoot: string;
  project: string;
  container: string;
  branch: string;
  identity: SandboxWorkspaceIdentity;
  engine?: string;
  taskProjectionDir?: string;
  taskProjectionTopology?: readonly ProjectionAncestorIdentity[];
  replacementLease?: Readonly<{
    root: string;
    assertOwned(): void;
  }>;
}>): SandboxControlSetup {
  const { root, channelDir, statusDir, processingDir, runtimeDir, manifestPath } = sandboxControlPaths(params);
  assertSafeDirectory(root, path.resolve(params.base));
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
    if (directory === runtimeDir) fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  for (const directory of [
    path.join(runtimeDir, 'clients'),
    path.join(runtimeDir, 'clients', 'codex', 'capabilities'),
    path.join(runtimeDir, 'clients', 'codex', 'lifecycle')
  ]) {
    assertSafeDirectory(directory, runtimeDir);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
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
    ...(params.taskProjectionDir === undefined ? {} : {
      taskProjectionDir: fs.realpathSync.native(params.taskProjectionDir),
      taskProjectionTopology: params.taskProjectionTopology
    })
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
