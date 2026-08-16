import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestSandboxControl, requestSandboxTaskCreate } from '../../../lib/sandbox/control/client.ts';
import { startSandboxControlBroker } from '../../../lib/sandbox/recovery.ts';

function waitForFile(filePath: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function waitForHealthyStatus(statusDir: string, timeoutMs: number): void {
  const statusPath = path.join(statusDir, 'status.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(statusPath, 'utf8')).state === 'healthy') return;
    } catch {
      // Atomic publication may not have completed yet.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for healthy status in ${statusDir}`);
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

test('sandbox broker startup resolves only after matching status is published', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-readiness-'));
  const channelDir = path.join(root, 'channel');
  const statusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(channelDir);
  fs.mkdirSync(statusDir);
  fs.mkdirSync(processingDir);
  const branch = initializeRepository(root);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 3, repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature', branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'readiness-secret', generation: 'readiness-generation',
    channelDir, publicStatusDir: statusDir, processingDir
  })}\n`);
  let brokerPid: number | null = null;
  try {
    await startSandboxControlBroker(root, manifestPath);
    const broker = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
    const status = JSON.parse(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8'));
    brokerPid = broker.pid;
    assert.equal(status.generation, 'readiness-generation');
    assert.equal(status.broker.pid, broker.pid);
  } finally {
    if (brokerPid) {
      try { process.kill(brokerPid, 'SIGTERM'); } catch { /* already gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('sandbox control client and broker exchange a task-bound response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-roundtrip-'));
  const channelDir = path.join(root, 'channel');
  const manifestPath = path.join(root, 'manifest.json');
  const token = 'roundtrip-secret';
  const generation = 'roundtrip-generation';
  const statusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  fs.mkdirSync(channelDir, { recursive: true });
  fs.mkdirSync(statusDir);
  fs.mkdirSync(processingDir);
  const branch = initializeRepository(root);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 3,
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-dev-feature',
    branch,
    mode: 'task-bound',
    taskId: 'TASK-20260809-010203',
    token,
    generation,
    channelDir,
    publicStatusDir: statusDir,
    processingDir
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForFile(path.join(root, 'broker.json'), 5_000);
    waitForHealthyStatus(statusDir, 5_000);
    const response = requestSandboxControl({
      family: 'task-lifecycle',
      args: ['08', 'complete'],
      channelDir,
      statusDir,
      token,
      generation,
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
  const generation = 'roundtrip-generation';
  const statusDir = path.join(root, 'control', 'public');
  const processingDir = path.join(root, 'control', 'processing');
  fs.mkdirSync(channelDir, { recursive: true });
  fs.mkdirSync(statusDir);
  fs.mkdirSync(processingDir);
  const branch = initializeRepository(root);
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 }, platform: { type: null } }));
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 3, repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature', branch,
    mode: 'branch-only', taskId: null, token, generation, channelDir,
    publicStatusDir: statusDir, processingDir
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForFile(path.join(root, 'control', 'broker.json'), 5_000);
    waitForHealthyStatus(statusDir, 5_000);
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
      statusDir,
      token,
      generation,
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
      version: 2, id: requestId, token, generation, issuedAt: Date.now(), expiresAt: Date.now() + 2_000,
      family: 'task-create', candidate
    })}\n`);
    const replayPath = path.join(channelDir, 'responses', `${requestId}.json`);
    waitForFile(replayPath, 5_000);
    const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    assert.equal(replay.phase, 'rejected');
    assert.equal(replay.error.code, 'SANDBOX_CONTROL_REQUEST_REPLAYED');
    assert.equal(replay.error.retryable, false);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker recovery preserves terminal responses and marks unaccepted claims retryable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recovery-'));
  const channelDir = path.join(root, 'channel');
  const responsesDir = path.join(channelDir, 'responses');
  const statusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  const manifestPath = path.join(root, 'manifest.json');
  const generation = 'recovery-generation';
  const terminalId = '11111111-1111-1111-1111-111111111111';
  const unacceptedId = '22222222-2222-2222-2222-222222222222';
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.mkdirSync(statusDir);
  fs.mkdirSync(path.join(processingDir, terminalId), { recursive: true });
  fs.mkdirSync(path.join(processingDir, unacceptedId), { recursive: true });
  const branch = initializeRepository(root);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version: 3, repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature', branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'recovery-secret', generation,
    channelDir, publicStatusDir: statusDir, processingDir
  })}\n`);
  const terminalResponse = {
    version: 2, id: terminalId, phase: 'completed', exitCode: 0, stdout: 'done\n', stderr: '', error: null
  };
  fs.writeFileSync(path.join(responsesDir, `${terminalId}.json`), `${JSON.stringify(terminalResponse)}\n`);
  fs.writeFileSync(path.join(processingDir, terminalId, 'execution.json'), `${JSON.stringify({
    version: 1, generation, requestId: terminalId, nonce: 'recovery-nonce',
    child: { pid: 999_999_999, startTime: 'gone', processGroupId: null },
    phase: 'running', updatedAt: Date.now()
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForHealthyStatus(statusDir, 5_000);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(responsesDir, `${terminalId}.json`), 'utf8')), terminalResponse);
    const unaccepted = JSON.parse(fs.readFileSync(path.join(responsesDir, `${unacceptedId}.json`), 'utf8'));
    assert.equal(unaccepted.error.code, 'SANDBOX_CONTROL_NOT_EXECUTED');
    assert.equal(unaccepted.error.retryable, true);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
