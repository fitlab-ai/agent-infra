import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestSandboxControl, requestSandboxTaskCreate } from '../../../lib/sandbox/control/client.ts';

function waitForFile(filePath: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function initializeRepository(root: string): string {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
}

test('sandbox control client and broker exchange a task-bound response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-roundtrip-'));
  const channelDir = path.join(root, 'channel');
  const manifestPath = path.join(root, 'manifest.json');
  const token = 'roundtrip-secret';
  fs.mkdirSync(channelDir, { recursive: true });
  const branch = initializeRepository(root);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 2,
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-dev-feature',
    branch,
    mode: 'task-bound',
    taskId: 'TASK-20260809-010203',
    token,
    channelDir
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForFile(path.join(root, 'broker.json'), 5_000);
    const response = requestSandboxControl({
      family: 'task-lifecycle',
      args: ['08', 'complete'],
      channelDir,
      token,
      timeoutMs: 5_000
    });
    assert.equal(response.exitCode, 1);
    assert.match(response.stdout, /LIFECYCLE_PAYLOAD_INVALID/);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('branch-only broker persists a typed task-create request on the host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-task-create-'));
  const channelDir = path.join(root, 'control', 'channel');
  const manifestPath = path.join(root, 'control', 'manifest.json');
  const token = 'roundtrip-secret';
  fs.mkdirSync(channelDir, { recursive: true });
  const branch = initializeRepository(root);
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 }, platform: { type: null } }));
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 2, repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature', branch,
    mode: 'branch-only', taskId: null, token, channelDir
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForFile(path.join(root, 'control', 'broker.json'), 5_000);
    const candidate = {
      version: 1 as const,
      idempotencyKey: '12345678-1234-4123-8123-123456789abc',
      agent: 'codex' as const,
      title: 'Create from branch-only sandbox',
      type: 'feature' as const,
      branchSlug: 'create-branch-only-sandbox-task',
      priority: 'Medium' as const,
      effort: 'Low' as const,
      description: 'Persist a task without changing sandbox identity.',
      taskInput: {
        sources: [], facts: [], constraints: [], decisions: [], alternatives: [],
        acceptanceCriteria: [], openQuestions: []
      }
    };
    const response = requestSandboxTaskCreate({
      candidate,
      channelDir,
      token,
      timeoutMs: 5_000
    });
    assert.equal(response.exitCode, 0, response.stderr || response.stdout);
    const result = JSON.parse(response.stdout);
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.operations.at(-1), { name: 'task:verify', status: 'pass', reasonCode: null });
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', result.task.id, 'task.md')), true);
    const currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(currentManifest.mode, 'branch-only');
    assert.equal(currentManifest.taskId, null);

    const [requestId] = fs.readdirSync(path.join(root, 'control', 'consumed'));
    assert.ok(requestId);
    fs.writeFileSync(path.join(channelDir, 'requests', `${requestId}.json`), `${JSON.stringify({
      version: 1, id: requestId, token, family: 'task-create', candidate
    })}\n`);
    const replayPath = path.join(channelDir, 'responses', `${requestId}.json`);
    waitForFile(replayPath, 5_000);
    const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    assert.equal(replay.exitCode, 1);
    assert.match(replay.stderr, /SANDBOX_CONTROL_REQUEST_REPLAYED/);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
