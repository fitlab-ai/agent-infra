import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSandboxTaskSource,
  materializeSandboxControl,
  materializeSandboxWorkspaceView,
  prepareSandboxWorkspaceMountTarget,
  sandboxWorkspaceViewStatePaths
} from '../../../lib/sandbox/workspace-view.ts';
import { assertModeBits } from '../../helpers.ts';

test('workspace view state paths use the isolated runtime state allowlist', () => {
  assert.deepEqual(sandboxWorkspaceViewStatePaths('/views/current'), [
    { state: 'active', hostPath: path.join('/views/current', 'active') },
    { state: 'completed', hostPath: path.join('/views/current', 'completed') },
    { state: 'blocked', hostPath: path.join('/views/current', 'blocked') },
    { state: 'archive', hostPath: path.join('/views/current', 'archive') }
  ]);
});

test('task-bound view contains only the scoped registry and task placeholder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-view-'));
  const view = materializeSandboxWorkspaceView({
    base: root,
    project: 'p',
    container: 'p-dev-feature',
    identity: { mode: 'task-bound', taskId: 'TASK-20260809-010203', shortId: '8' }
  });

  assert.deepEqual(fs.readdirSync(view.root).sort(), ['active', 'archive', 'blocked', 'completed']);
  assert.deepEqual(fs.readdirSync(path.join(view.root, 'active')).sort(), [
    '.short-ids.json',
    'TASK-20260809-010203'
  ]);
  assert.equal(
    fs.readFileSync(path.join(view.root, 'active', '.short-ids.json'), 'utf8'),
    '{"version":1,"ids":{"8":"TASK-20260809-010203"}}\n'
  );
});

test('branch-only view is stable and exposes an empty registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-view-'));
  const view = materializeSandboxWorkspaceView({
    base: root,
    project: 'p',
    container: 'p-dev-feature',
    identity: { mode: 'branch-only' }
  });
  assert.deepEqual(fs.readdirSync(path.join(view.root, 'active')), ['.short-ids.json']);
  assert.equal(fs.readFileSync(path.join(view.root, 'active', '.short-ids.json'), 'utf8'), '{"version":1,"ids":{}}\n');
});

test('workspace mount target is created by the host with private permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-workspace-target-'));

  const target = prepareSandboxWorkspaceMountTarget(root);

  assert.equal(target, path.join(root, '.agents', 'workspace'));
  assert.equal(fs.statSync(target).isDirectory(), true);
  assertModeBits(target, 0o700);
});

test('workspace mount target rejects symbolic-link destinations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-workspace-target-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-workspace-target-outside-'));
  fs.mkdirSync(path.join(root, '.agents'));
  fs.symlinkSync(outside, path.join(root, '.agents', 'workspace'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => prepareSandboxWorkspaceMountTarget(root), /must not be a symbolic link/);
});

test('workspace mount target rejects symbolic-link ancestors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-workspace-ancestor-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-workspace-ancestor-outside-'));
  fs.symlinkSync(outside, path.join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => prepareSandboxWorkspaceMountTarget(root), /ancestor must be a real directory/);
});

test('task sources reject symlinks before they become writable mounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-source-'));
  const active = path.join(root, '.agents', 'workspace', 'active');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(active, 'TASK-20260809-010203'));
  assert.throws(() => assertSandboxTaskSource(root, 'TASK-20260809-010203'), /SOURCE_INVALID/);
});

test('control materialization rotates token and generation and creates isolated status paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-control-view-'));
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
  fs.writeFileSync(path.join(controlRoot, 'consumed', 'request-id'), '');
  const second = materializeSandboxControl(params);
  assert.notEqual(second.token, first.token);
  assert.notEqual(second.generation, first.generation);
  assert.deepEqual(fs.readdirSync(path.join(controlRoot, 'consumed')), []);
  assert.equal(path.dirname(path.join(controlRoot, 'consumed')), controlRoot);
  const manifest = JSON.parse(fs.readFileSync(second.manifestPath, 'utf8'));
  assert.equal(manifest.version, 3);
  assert.equal(manifest.generation, second.generation);
  assert.equal(manifest.publicStatusDir, path.join(controlRoot, 'public'));
  assert.equal(manifest.processingDir, path.join(controlRoot, 'processing'));
  assert.equal(second.statusDir, path.join(controlRoot, 'public'));
  assert.equal(manifest.worktreeRoot, fs.realpathSync.native(repoRoot));
});
