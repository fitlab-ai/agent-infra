import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sandboxControlSafeEnv,
  serveSandboxControl
} from '../../../lib/sandbox/control/server.ts';
import {
  bindSandboxControlTask,
  validateSandboxControlRequest,
  type SandboxControlManifest
} from '../../../lib/sandbox/control/protocol.ts';

const manifest: SandboxControlManifest = {
  version: 2,
  repoRoot: '/repo',
  worktreeRoot: '/worktree',
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

test('task-orchestration requests cannot override the manifest worktree binding', () => {
  assert.throws(() => validateSandboxControlRequest({
    version: 1,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    family: 'task-orchestration',
    args: ['08', 'commit-status', '--git-worktree-root', '/other']
  }, manifest), /REQUEST_INVALID/);
});

test('control broker strips mixed-case sandbox authority from child environments', () => {
  assert.deepEqual(sandboxControlSafeEnv({
    agent_infra_control_token: 'live-token',
    Agent_Infra_Control_Dir: 'live-channel',
    aGeNt_InFrA_cOnTrOl_FuTuRe: 'future-authority',
    AGENT_INFRA_TEST_SENTINEL: 'preserved'
  }), {
    AGENT_INFRA_TEST_SENTINEL: 'preserved'
  });
});

test('task-create is authorized in both sandbox modes without task rebinding', () => {
  const candidate = {
    version: 1,
    idempotencyKey: '12345678-1234-4123-8123-123456789abc',
    agent: 'codex',
    title: 'Create a sandbox task',
    type: 'feature',
    branchSlug: 'create-sandbox-task',
    priority: 'Medium',
    effort: 'Low',
    description: 'Persist a new task on the host.',
    taskInput: {
      sources: [], facts: [], constraints: [], decisions: [], alternatives: [],
      acceptanceCriteria: [], openQuestions: []
    }
  };
  for (const mode of ['task-bound', 'branch-only'] as const) {
    const request = validateSandboxControlRequest({
      version: 1,
      id: '12345678-1234-1234-1234-123456789abc',
      token: 'secret',
      family: 'task-create',
      candidate
    }, { ...manifest, mode, taskId: mode === 'task-bound' ? manifest.taskId : null });
    assert.equal(request.family, 'task-create');
    assert.equal(request.candidate.title, candidate.title);
  }
});

test('control broker ownership is acquired exclusively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-owner-'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['add', 'source.txt']);
  git(['commit', '-qm', 'base']);
  const branch = git(['branch', '--show-current']);
  const channelDir = path.join(root, 'channel');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(channelDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest, repoRoot: root, worktreeRoot: root, branch, channelDir
  })}\n`);
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

test('control broker rejects legacy manifests with sandbox refresh guidance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-legacy-manifest-'));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: 1, worktreeRoot: undefined })}\n`);
  try {
    assert.throws(
      () => serveSandboxControl(manifestPath),
      /SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 2; recreate the sandbox/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
