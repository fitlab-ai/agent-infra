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

test('sandbox broker startup replaces a stale owner without creating a concurrent live owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-owner-'));
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
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'owner-secret', generation: 'owner-generation',
    channelDir, publicStatusDir: statusDir, processingDir
  })}\n`);
  fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
    version: 1, pid: 999_999_999, startTime: 'stale-owner'
  })}\n`);
  let brokerPid: number | null = null;
  try {
    await startSandboxControlBroker(root, manifestPath);
    const first = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
    brokerPid = first.pid;
    const recoveryEvents = fs.readFileSync(path.join(root, 'audit.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line).event);
    assert.deepEqual(recoveryEvents.slice(0, 2), ['broker-observed-crash', 'broker-restart']);
    await startSandboxControlBroker(root, manifestPath);
    const second = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
    assert.equal(second.pid, first.pid);
    assert.equal(second.startTime, first.startTime);
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      version: 3, repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature', branch,
      mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'rotated-owner-secret', generation: 'rotated-generation',
      channelDir, publicStatusDir: statusDir, processingDir
    })}\n`);
    await startSandboxControlBroker(root, manifestPath);
    const rotated = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
    brokerPid = rotated.pid;
    assert.notEqual(rotated.pid, first.pid);
    const status = JSON.parse(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8'));
    assert.equal(status.generation, 'rotated-generation');
    assert.equal(status.broker.pid, rotated.pid);
  } finally {
    if (brokerPid) {
      try { process.kill(brokerPid, 'SIGTERM'); } catch { /* already gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('sandbox control client tolerates a transient torn response but rejects stable malformed data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-response-'));
  const channelDir = path.join(root, 'channel');
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const statusDir = path.join(root, 'public');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir);
  fs.mkdirSync(statusDir);
  fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
    version: 1,
    generation: 'response-generation',
    broker: { pid: process.pid, startTime: 'test-broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now()
  })}\n`);
  const clientModule = path.resolve('lib/sandbox/control/client.ts');
  const runClient = () => {
    const script = `
      import { requestSandboxControl } from ${JSON.stringify(clientModule)};
      try {
        const response = requestSandboxControl({
          family: 'task-orchestration', args: ['01', 'commit-status'],
          channelDir: ${JSON.stringify(channelDir)}, statusDir: ${JSON.stringify(statusDir)},
          token: 'response-secret', generation: 'response-generation', timeoutMs: 2_000
        });
        process.stdout.write(JSON.stringify({ response }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' && 'detail' in error ? error.detail.code : null
        }));
        process.exitCode = 1;
      }
    `;
    return spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  };
  const collect = async (child: ReturnType<typeof runClient>) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number>((resolve) => child.once('close', (code) => resolve(code ?? 1)));
    return { exitCode, stdout, stderr };
  };
  const responseFor = (id: string) => ({
    version: 2, id, phase: 'rejected', exitCode: null, stdout: '',
    stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  });
  try {
    const transientClient = runClient();
    const requestDeadline = Date.now() + 2_000;
    while (!fs.readdirSync(requestsDir).some((name) => name.endsWith('.json')) && Date.now() < requestDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const transientId = fs.readdirSync(requestsDir).find((name) => name.endsWith('.json'))!.slice(0, -5);
    const transientPath = path.join(responsesDir, `${transientId}.json`);
    fs.writeFileSync(transientPath, `${JSON.stringify({
      version: 2, id: transientId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    fs.writeFileSync(transientPath, '{"version":2,"id":"');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    fs.writeFileSync(transientPath, `${JSON.stringify(responseFor(transientId))}\n`);
    const transient = await collect(transientClient);
    assert.equal(transient.exitCode, 0, transient.stderr || transient.stdout);
    assert.equal(JSON.parse(transient.stdout).response.error.code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');

    const stableClient = runClient();
    while (fs.readdirSync(requestsDir).filter((name) => name.endsWith('.json')).length < 2) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const stableName = fs.readdirSync(requestsDir).filter((name) => name.endsWith('.json'))
      .find((name) => !name.startsWith(transientId))!;
    fs.writeFileSync(path.join(responsesDir, stableName), '{"version":2');
    const stable = await collect(stableClient);
    assert.equal(stable.exitCode, 1);
    assert.equal(JSON.parse(stable.stdout).code, 'SANDBOX_CONTROL_RESPONSE_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
