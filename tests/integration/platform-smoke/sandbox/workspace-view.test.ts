import { taskWorkspaceProject, taskWorkspaceRoot } from '../../../helpers.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertSandboxTaskSource,
  materializeSandboxControl,
  materializeSandboxWorkspaceView,
  prepareSandboxWorkspaceMountTargets,
  prepareSandboxCompletedTaskMountSource,
  sandboxControlPaths,
  sandboxWorkspaceViewStatePaths
} from '../../../../lib/sandbox/workspace-view.ts';
import { acquireSandboxControlReplacement } from '../../../../lib/sandbox/control/lifecycle.ts';
import { sandboxCoreBindMounts } from '../../../../lib/sandbox/mounts.ts';
import { resolveSandboxTarget } from '../../../../lib/sandbox/workspace-identity.ts';
import { createTempDir, assertModeBits, onPlatforms } from '../../../helpers.ts';

test('workspace view state paths use the isolated runtime state allowlist', () => {
  assert.deepEqual(sandboxWorkspaceViewStatePaths('/views/current'), [
    { state: 'active', hostPath: path.join('/views/current', 'active') },
    { state: 'completed', hostPath: path.join('/views/current', 'completed') },
    { state: 'blocked', hostPath: path.join('/views/current', 'blocked') },
    { state: 'archive', hostPath: path.join('/views/current', 'archive') }
  ]);
});

test('task-bound view contains only the scoped registry', () => {
  const root = createTempDir('sandbox-view-');
  const view = materializeSandboxWorkspaceView({
    base: root,
    project: 'p',
    container: 'p-dev-feature',
    identity: { mode: 'task-bound', taskId: 'TASK-20260809-010203', shortId: '8' }
  });

  assert.deepEqual(fs.readdirSync(view.root).sort(), ['active', 'archive', 'blocked', 'completed']);
  assert.deepEqual(fs.readdirSync(path.join(view.root, 'active')).sort(), ['.short-ids.json']);
  assert.equal(
    fs.readFileSync(path.join(view.root, 'active', '.short-ids.json'), 'utf8'),
    '{"version":1,"ids":{"8":"TASK-20260809-010203"}}\n'
  );
});

test('branch-only view is stable and exposes an empty registry', () => {
  const root = createTempDir('sandbox-view-');
  const view = materializeSandboxWorkspaceView({
    base: root,
    project: 'p',
    container: 'p-dev-feature',
    identity: { mode: 'branch-only' }
  });
  assert.deepEqual(fs.readdirSync(path.join(view.root, 'active')), ['.short-ids.json']);
  assert.equal(fs.readFileSync(path.join(view.root, 'active', '.short-ids.json'), 'utf8'), '{"version":1,"ids":{}}\n');
});

test('task-bound control paths use a stable project and full-task control root', () => {
  const root = createTempDir('sandbox-task-runtime-root-');
  const taskId = 'TASK-20261006-010203';
  const taskDir = path.join(taskWorkspaceRoot(root),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: task-branch\n---\n`);
  const controlBase = path.join(root, 'stable-control-base');
  const control = sandboxControlPaths({
    base: controlBase, project: 'p', container: 'p-dev-feature',
    identity: { mode: 'task-bound', taskId }
  });
  assert.equal(control.root, path.join(controlBase, 'p', 'tasks', taskId));
  assert.equal(control.runtimeDir, path.join(control.root, 'runtime'));
  assert.equal(control.manifestPath, path.join(control.root, 'manifest.json'));
  assert.notEqual(sandboxControlPaths({
    base: controlBase, project: 'other-project', container: 'p-dev-feature',
    identity: { mode: 'task-bound', taskId }
  }).root, control.root);
  assert.notEqual(sandboxControlPaths({
    base: controlBase, project: 'p', container: 'p-dev-feature',
    identity: { mode: 'task-bound', taskId: 'TASK-20261006-010204' }
  }).root, control.root);
});

test('branch-only control paths retain their existing container identity layout', () => {
  const root = createTempDir('sandbox-branch-control-root-');
  const control = sandboxControlPaths({
    base: path.join(root, 'controls'), project: 'p', container: 'p-dev-feature',
    identity: { mode: 'branch-only' }
  });
  const digest = createHash('sha256').update('branch-only').digest('hex').slice(0, 16);
  assert.equal(control.root, path.join(root, 'controls', 'p', 'p-dev-feature', digest));
});

test('task-bound control materialization rejects a symlinked managed-root ancestor', () => {
  const root = createTempDir('sandbox-control-root-link-');
  const base = path.join(root, 'controls');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(base, 'p'), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(base, 'p', 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => materializeSandboxControl({
    base, repoRoot: root, worktreeRoot: root, project: 'p', container: 'p-dev-feature', branch: 'feature',
    identity: { mode: 'task-bound', taskId: 'TASK-20261006-010205' }
  }), /symbolic link/u);
});

test('workspace mount targets are created by the host with private permissions', () => {
  const root = createTempDir('sandbox-workspace-target-');
  const workspace = taskWorkspaceRoot(root);
  prepareSandboxWorkspaceMountTargets(root);
  assert.equal(fs.statSync(workspace).isDirectory(), true);
  assertModeBits(workspace, 0o700);
  for (const { hostPath } of sandboxWorkspaceViewStatePaths(workspace)) {
    assert.equal(fs.statSync(hostPath).isDirectory(), true);
    assertModeBits(hostPath, 0o700);
  }
  assert.equal(fs.statSync(path.join(workspace, 'active', '.short-ids.json')).isFile(), true);
  assert.equal(fs.readFileSync(path.join(workspace, 'active', '.short-ids.json'), 'utf8'), '{"version":1,"ids":{}}\n');
  assert.equal(resolveSandboxTarget('feature/empty', root).workspace.mode, 'branch-only');
});

test('workspace mount targets preserve existing runtime content on repeat', () => {
  const root = createTempDir('sandbox-workspace-target-repeat-');
  const workspace = taskWorkspaceRoot(root);
  prepareSandboxWorkspaceMountTargets(root);
  const registry = path.join(workspace, 'active', '.short-ids.json');
  const sentinel = path.join(workspace, 'active', 'sentinel');
  fs.writeFileSync(registry, '{"keep":true}\n');
  fs.writeFileSync(sentinel, 'preserve\n');
  prepareSandboxWorkspaceMountTargets(root);

  assert.equal(fs.readFileSync(registry, 'utf8'), '{"keep":true}\n');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve\n');
});

test('task-bound sandboxes bind only their completed task directory writable', () => {
  const root = createTempDir('sandbox-completed-target-');
  const repoRoot = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  const taskId = 'TASK-20260809-010203';
  fs.mkdirSync(taskWorkspaceRoot(repoRoot), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const completedSource = prepareSandboxCompletedTaskMountSource(repoRoot, taskId);

  const mounts = sandboxCoreBindMounts({
    repoRoot, worktreeBase: path.join(root, 'worktrees'), shareBase: path.join(root, 'shares'),
    shellConfigBase: path.join(root, 'shell')
  }, 'feature/task', {
    worktree, workspaceViewRoot: path.join(root, 'view'), controlDir: path.join(root, 'control', 'channel'),
    controlRootDir: path.join(root, 'control'),
    controlStatusDir: path.join(root, 'control', 'public'), taskSources: [path.join(taskWorkspaceRoot(repoRoot), 'active', taskId)],
    completedTaskSource: completedSource, taskId
  });
  const parent = mounts.find((mount) => mount.containerPath === '/task-workspace/completed');
  const task = mounts.find((mount) => mount.containerPath === `/task-workspace/completed/${taskId}`);
  assert.equal(parent, undefined);
  assert.deepEqual(task, { hostPaths: [completedSource], containerPath: `/task-workspace/completed/${taskId}`, readOnly: false });
  assert.equal(fs.statSync(path.join(taskWorkspaceRoot(repoRoot), 'completed', taskId)).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(completedSource), []);
});

test('workspace mount targets reject symbolic-link destinations', () => {
  const root = createTempDir('sandbox-workspace-target-link-');
  const outside = createTempDir('sandbox-workspace-target-outside-');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.dirname(taskWorkspaceRoot(root)), { recursive: true });
  fs.symlinkSync(outside, taskWorkspaceRoot(root), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => prepareSandboxWorkspaceMountTargets(root), /must not contain a symbolic link/);
});

test('workspace mount target rejects symbolic-link ancestors', () => {
  const root = createTempDir('sandbox-workspace-ancestor-link-');
  const home = path.join(root, 'home');
  const outside = createTempDir('sandbox-workspace-ancestor-outside-');
  const project = taskWorkspaceProject(root);
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project }));
  fs.mkdirSync(path.join(home, '.agent-infra'), { recursive: true });
  fs.symlinkSync(outside, path.join(home, '.agent-infra', 'task-workspaces'), process.platform === 'win32' ? 'junction' : 'dir');
  const moduleUrl = new URL('../../../../lib/sandbox/workspace-view.ts', import.meta.url).href;
  const script = `import { prepareSandboxWorkspaceMountTargets } from ${JSON.stringify(moduleUrl)}; prepareSandboxWorkspaceMountTargets(process.argv[1]);`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of [
    'AGENT_INFRA_SANDBOX', 'AGENT_INFRA_TASK_ID', 'AGENT_INFRA_CONTROL_GENERATION',
    'AGENT_INFRA_CONTROL_DIR', 'AGENT_INFRA_CONTROL_ROOT_DIR', 'AGENT_INFRA_CONTROL_ROOT_ID',
    'AGENT_INFRA_CONTROL_STATUS_DIR', 'AGENT_INFRA_RUNTIME_DIR'
  ]) delete env[key];
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, root], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8'
  });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /must not contain a symbolic link/);
});

test('task sources reject symlinks before they become writable mounts', () => {
  const root = createTempDir('sandbox-source-');
  const active = path.join(taskWorkspaceRoot(root),  'active');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(active, 'TASK-20260809-010203'));
  assert.throws(() => assertSandboxTaskSource(root, 'TASK-20260809-010203'), /SOURCE_INVALID/);
});

test('control materialization rotates token and generation and creates isolated status paths', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('sandbox-control-view-');
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'source.txt'), 'base\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot });
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['add', 'source.txt']);
  git(['commit', '-qm', 'base']);
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const params = {
    base: path.join(root, 'controls'), repoRoot, worktreeRoot: repoRoot, project: 'p', container: 'p-dev-feature', branch,
    identity: { mode: 'branch-only' as const }
  };
  const first = materializeSandboxControl(params);
  const controlRoot = path.dirname(first.manifestPath);
  const retainedRuntimeRecord = path.join(controlRoot, 'runtime', 'clients', 'codex', 'lifecycle', 'sentinel');
  fs.mkdirSync(path.dirname(retainedRuntimeRecord), { recursive: true });
  fs.writeFileSync(retainedRuntimeRecord, 'keep existing bytes\n');
  fs.writeFileSync(path.join(controlRoot, 'consumed', 'request-id'), '');
  const replacementLease = acquireSandboxControlReplacement(controlRoot);
  const second = materializeSandboxControl({ ...params, replacementLease });
  replacementLease.release();
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.generation, first.generation);
  assert.deepEqual(fs.readdirSync(path.join(controlRoot, 'consumed')), []);
  assert.equal(fs.readFileSync(retainedRuntimeRecord, 'utf8'), 'keep existing bytes\n');
  assert.equal(path.dirname(path.join(controlRoot, 'consumed')), controlRoot);
  assert.equal(fs.existsSync(second.manifestPath), false);
  const manifest = second.manifestDraft;
  assert.equal(manifest.generation, second.generation);
  assert.equal(manifest.publicStatusDir, path.join(controlRoot, 'public'));
  assert.equal(manifest.processingDir, path.join(controlRoot, 'processing'));
  assert.equal(manifest.runtimeDir, path.join(controlRoot, 'runtime'));
  assert.deepEqual(fs.readdirSync(path.join(controlRoot, 'runtime', 'clients', 'codex')).sort(), ['lifecycle']);
  assert.equal(second.statusDir, path.join(controlRoot, 'public'));
  assert.equal(manifest.worktreeRoot, fs.realpathSync.native(repoRoot));
});
