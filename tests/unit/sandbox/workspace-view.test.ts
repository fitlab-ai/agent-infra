import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSandboxTaskSource,
  materializeSandboxControl,
  materializeSandboxWorkspaceView
} from '../../../lib/sandbox/workspace-view.ts';

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

test('task sources reject symlinks before they become writable mounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-source-'));
  const active = path.join(root, '.agents', 'workspace', 'active');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(active, 'TASK-20260809-010203'));
  assert.throws(() => assertSandboxTaskSource(root, 'TASK-20260809-010203'), /SOURCE_INVALID/);
});

test('control materialization rotates the token and clears host-only replay markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-control-view-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot);
  const params = {
    base: path.join(root, 'controls'), repoRoot, project: 'p', container: 'p-dev-feature', branch: 'feature',
    identity: { mode: 'branch-only' as const }
  };
  const first = materializeSandboxControl(params);
  const controlRoot = path.dirname(first.manifestPath);
  fs.writeFileSync(path.join(controlRoot, 'consumed', 'request-id'), '');
  const second = materializeSandboxControl(params);
  assert.notEqual(second.token, first.token);
  assert.deepEqual(fs.readdirSync(path.join(controlRoot, 'consumed')), []);
  assert.equal(path.dirname(path.join(controlRoot, 'consumed')), controlRoot);
});
