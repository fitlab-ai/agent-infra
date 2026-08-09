import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serveSandboxControl } from '../../../lib/sandbox/control/server.ts';
import {
  bindSandboxControlTask,
  validateSandboxControlRequest,
  type SandboxControlManifest
} from '../../../lib/sandbox/control/protocol.ts';

const manifest: SandboxControlManifest = {
  version: 1,
  repoRoot: '/repo',
  project: 'p',
  container: 'p-dev-feature',
  branch: 'feature',
  mode: 'task-bound',
  taskId: 'TASK-20260809-010203',
  token: 'secret',
  channelDir: '/channel'
};

test('control requests are restricted to allowed families and rebound to the manifest task', () => {
  const request = validateSandboxControlRequest({
    version: 1,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    family: 'task-lifecycle',
    args: ['08', 'complete', '--agent', 'codex']
  }, manifest);
  assert.deepEqual(bindSandboxControlTask(request, manifest.taskId!), [
    'TASK-20260809-010203',
    'complete',
    '--agent',
    'codex'
  ]);
  assert.throws(
    () => validateSandboxControlRequest({ ...request, family: 'platform-issue' }, manifest),
    /REQUEST_INVALID/
  );
});

test('branch-only sandboxes and incorrect tokens fail closed', () => {
  const request = {
    version: 1,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    family: 'task-orchestration',
    args: ['08', 'status']
  };
  assert.throws(
    () => validateSandboxControlRequest(request, { ...manifest, mode: 'branch-only', taskId: null }),
    /BRANCH_ONLY/
  );
  assert.throws(
    () => validateSandboxControlRequest({ ...request, token: 'wrong' }, manifest),
    /REQUEST_INVALID/
  );
});

test('control broker ownership is acquired exclusively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-owner-'));
  const channelDir = path.join(root, 'channel');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(channelDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, repoRoot: root, channelDir })}\n`);
  fs.writeFileSync(path.join(root, 'broker.json'), '{}\n');
  const controller = new AbortController();
  controller.abort();
  try {
    assert.throws(
      () => serveSandboxControl(manifestPath, controller.signal),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
