import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxWorkspaceIdentity } from './workspace-identity.ts';
import type { SandboxControlManifest } from './control/protocol.ts';

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
  identity: SandboxWorkspaceIdentity;
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
  manifestPath: string;
  token: string;
  generation: string;
}>;

export function sandboxControlPaths(params: Readonly<{
  base: string;
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity;
}>): Readonly<{ root: string; channelDir: string; statusDir: string; processingDir: string; manifestPath: string }> {
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

export function prepareSandboxWorkspaceMountTarget(worktreeRoot: string): string {
  const worktree = path.resolve(worktreeRoot);
  const canonicalWorktree = fs.realpathSync.native(worktree);
  const agentsRoot = path.join(worktree, '.agents');
  if (fs.existsSync(agentsRoot)) {
    const agentsStat = fs.lstatSync(agentsRoot);
    if (!agentsStat.isDirectory() || agentsStat.isSymbolicLink()) {
      throw new Error(`Sandbox workspace mount ancestor must be a real directory: ${agentsRoot}`);
    }
  } else {
    fs.mkdirSync(agentsRoot, { mode: 0o700 });
  }
  const canonicalAgents = fs.realpathSync.native(agentsRoot);
  if (path.dirname(canonicalAgents) !== canonicalWorktree) {
    throw new Error(`Sandbox workspace mount ancestor escapes the worktree: ${agentsRoot}`);
  }

  const target = path.join(agentsRoot, 'workspace');
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`Sandbox workspace mount target must not be a symbolic link: ${target}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Sandbox workspace mount target must be a directory: ${target}`);
    }
    if (path.dirname(fs.realpathSync.native(target)) !== canonicalAgents) {
      throw new Error(`Sandbox workspace mount target escapes the worktree: ${target}`);
    }
  } else {
    fs.mkdirSync(target, { mode: 0o700 });
  }
  fs.chmodSync(target, 0o700);
  fs.accessSync(target, fs.constants.W_OK);
  return target;
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
}>): SandboxControlSetup {
  const { root, channelDir, statusDir, processingDir, manifestPath } = sandboxControlPaths(params);
  assertSafeDirectory(root, path.resolve(params.base));
  const consumedDir = path.join(root, 'consumed');
  assertSafeDirectory(consumedDir, root);
  fs.rmSync(consumedDir, { recursive: true, force: true });
  fs.mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
  for (const directory of [statusDir, processingDir]) {
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
  const repoRoot = fs.realpathSync.native(params.repoRoot);
  const manifest: SandboxControlManifest = {
    version: 4,
    engine: params.engine ?? 'docker',
    repoRoot,
    worktreeRoot: fs.realpathSync.native(params.worktreeRoot),
    project: params.project,
    container: params.container,
    containerIdentity: { id: '', labels: {} },
    branch: params.branch,
    mode: params.identity.mode,
    taskId: params.identity.mode === 'task-bound' ? params.identity.taskId : null,
    token,
    generation,
    channelDir,
    publicStatusDir: statusDir,
    processingDir
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { root, channelDir, statusDir, manifestPath, token, generation };
}

export function finalizeSandboxControlManifest(
  setup: SandboxControlSetup,
  identity: Readonly<{ engine: string; id: string; labels: Readonly<Record<string, string>> }>
): void {
  if (!identity.engine || !identity.id) throw new Error('SANDBOX_CONTROL_CONTAINER_ID_INVALID');
  const manifest = JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.version = 4;
  manifest.engine = identity.engine;
  manifest.containerIdentity = { id: identity.id, labels: { ...identity.labels } };
  const temporary = `${setup.manifestPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, setup.manifestPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
