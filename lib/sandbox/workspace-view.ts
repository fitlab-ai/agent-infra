import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SandboxWorkspaceIdentity } from './workspace-identity.ts';
import type { SandboxControlManifest } from './control/protocol.ts';

export type SandboxWorkspaceView = Readonly<{
  root: string;
  taskMountPath: string | null;
}>;

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
  channelDir: string;
  manifestPath: string;
  token: string;
}>;

export function sandboxControlPaths(params: Readonly<{
  base: string;
  project: string;
  container: string;
  identity: SandboxWorkspaceIdentity;
}>): Readonly<{ root: string; channelDir: string; manifestPath: string }> {
  const identityKey = params.identity.mode === 'task-bound'
    ? `task-bound:${params.identity.taskId}`
    : 'branch-only';
  const digest = createHash('sha256').update(identityKey).digest('hex').slice(0, 16);
  const root = path.resolve(params.base, params.project, params.container, digest);
  return { root, channelDir: path.join(root, 'channel'), manifestPath: path.join(root, 'manifest.json') };
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
  for (const state of ['active', 'completed', 'blocked', 'archive']) {
    const stateDir = path.join(root, state);
    assertSafeDirectory(stateDir, root);
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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
  project: string;
  container: string;
  branch: string;
  identity: SandboxWorkspaceIdentity;
}>): SandboxControlSetup {
  const { root, channelDir, manifestPath } = sandboxControlPaths(params);
  assertSafeDirectory(root, path.resolve(params.base));
  const consumedDir = path.join(root, 'consumed');
  assertSafeDirectory(consumedDir, root);
  fs.rmSync(consumedDir, { recursive: true, force: true });
  fs.mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
  for (const queue of ['requests', 'responses']) {
    const directory = path.join(channelDir, queue);
    assertSafeDirectory(directory, root);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString('hex');
  const manifest: SandboxControlManifest = {
    version: 1,
    repoRoot: fs.realpathSync.native(params.repoRoot),
    project: params.project,
    container: params.container,
    branch: params.branch,
    mode: params.identity.mode,
    taskId: params.identity.mode === 'task-bound' ? params.identity.taskId : null,
    token,
    channelDir
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { channelDir, manifestPath, token };
}
