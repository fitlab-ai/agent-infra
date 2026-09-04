import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  requestCodexControllerClose,
  requestCodexControllerOpen,
  requestCodexControllerVerify,
  recoverSandboxControl,
  requestSandboxControl,
  requestSandboxTaskCreate
} from '../../../lib/sandbox/control/client.ts';
import {
  garbageCollectSandboxControlRoot,
  quiesceSandboxControlRoot,
  readSandboxControlManifest,
  removeSandboxControlRoot
} from '../../../lib/sandbox/control/lifecycle.ts';
import { DEFAULT_SANDBOX_CONTROL_TIMING } from '../../../lib/sandbox/control/protocol.ts';
import { prepareSandboxControlExecution } from '../../../lib/sandbox/control/executor.ts';
import {
  atomicWriteJson,
  writeSandboxControlPayload,
  writeSandboxControlReservation,
  writeSandboxControlResultEvidence
} from '../../../lib/sandbox/control/state.ts';
import { serveSandboxControl } from '../../../lib/sandbox/control/server.ts';
import { startSandboxControlBroker } from '../../../lib/sandbox/recovery.ts';
import { getProcessStartTime, isProcessAlive } from '../../../lib/server/process-state.ts';
import { onPlatforms } from '../../helpers.ts';

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

function waitForAuditEvent(auditPath: string, event: string, generation: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = fs.readFileSync(auditPath, 'utf8')
        .trim().split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; generation?: string })
        .some((entry) => entry.event === event && entry.generation === generation);
      if (found) return;
    } catch {
      // The audit file may still be between append operations.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${event} audit event in ${auditPath}`);
}

async function waitForStatusStateAsync(statusDir: string, state: string, timeoutMs: number): Promise<void> {
  const statusPath = path.join(statusDir, 'status.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(statusPath, 'utf8')).state === state) return;
    } catch {
      // Atomic publication may not have completed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${state} status in ${statusDir}`);
}

type CollectedChild = {
  child: ReturnType<typeof spawn>;
  result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

function collectChild(child: ReturnType<typeof spawn>): CollectedChild {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
  return { child, result };
}

async function stopCollectedChild(client: CollectedChild | null): Promise<void> {
  if (!client) return;
  if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill('SIGTERM');
  await client.result.catch(() => undefined);
}

async function waitForRequestAsync(
  requestsDir: string,
  timeoutMs: number,
  options: { exclude?: string; client?: CollectedChild } = {}
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = fs.readdirSync(requestsDir)
      .find((name) => name.endsWith('.json') && name !== options.exclude);
    if (request) return request;
    if (options.client
      && (options.client.child.exitCode !== null || options.client.child.signalCode !== null)) {
      const result = await options.client.result;
      throw new Error(`client exited before publishing a request: ${result.stderr || result.stdout || result.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a request in ${requestsDir}`);
}

const SANDBOX_CONTROL_TEST_TIMEOUT_MS = 5_000;

function runTaskFinalizationClient(params: {
  channelDir: string;
  statusDir: string;
  token: string;
  generation: string;
  timeoutMs: number;
}): Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> {
  const script = [
    "import { requestSandboxTaskFinalization } from './lib/sandbox/control/client.ts';",
    'try {',
    '  const response = requestSandboxTaskFinalization({',
    "    agent: 'codex',",
    '    channelDir: process.env.TEST_CHANNEL_DIR,',
    '    statusDir: process.env.TEST_STATUS_DIR,',
    '    token: process.env.TEST_TOKEN,',
    '    generation: process.env.TEST_GENERATION,',
    '    timeoutMs: Number(process.env.TEST_TIMEOUT_MS)',
    '  });',
    "  process.stdout.write(JSON.stringify({ phase: response.phase, exitCode: response.exitCode, stdout: response.stdout, stderr: response.stderr, error: response.error }) + '\\n');",
    '} catch (error) {',
    '  const value = error;',
    "  process.stdout.write(JSON.stringify({ error: value.detail ?? { code: 'CLIENT_FAILED', message: String(value), retryable: false }, accepted: value.accepted ?? false }) + '\\n');",
    '  process.exitCode = 1;',
    '}'
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        TEST_CHANNEL_DIR: params.channelDir,
        TEST_STATUS_DIR: params.statusDir,
        TEST_TOKEN: params.token,
        TEST_GENERATION: params.generation,
        TEST_TIMEOUT_MS: String(params.timeoutMs)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        resolve({ exitCode: code ?? 1, payload: JSON.parse(stdout) as Record<string, unknown>, stderr });
      } catch (error) {
        reject(new Error(`client output was invalid: ${String(error)}\n${stdout}${stderr}`));
      }
    });
  });
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function assertMinimumIntervals(timestamps: number[], expectedMs: number[], label: string): void {
  assert.equal(timestamps.length, expectedMs.length + 1, `${label} sample count`);
  for (let index = 0; index < expectedMs.length; index += 1) {
    const actualMs = timestamps[index + 1]! - timestamps[index]!;
    assert.ok(actualMs >= expectedMs[index]! - 2, `${label} interval ${index}: ${actualMs}ms`);
  }
}

async function stopBroker(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  let deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!isProcessAlive(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { return; }
  deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

function writeControlManifest(root: string, branch: string, generation = 'lifecycle-generation'): string {
  const manifestPath = path.join(root, 'manifest.json');
  const channelDir = path.join(root, 'channel');
  const publicStatusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  for (const directory of [channelDir, publicStatusDir, processingDir]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'lifecycle-secret', generation,
    channelDir, publicStatusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  return manifestPath;
}

test('sandbox control lifecycle fails closed when a manifest has no owner evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-owner-evidence-'));
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch);
    assert.equal(readSandboxControlManifest(manifestPath).generation, 'lifecycle-generation');
    await assert.rejects(
      () => quiesceSandboxControlRoot(root, { timeoutMs: 100 }),
      /SANDBOX_CONTROL_OWNER_EVIDENCE_MISSING/
    );
    assert.equal(fs.existsSync(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control lifecycle accepts a stale broker when the manifest is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-stale-broker-'));
  try {
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3,
      pid: 999_999_999,
      startTime: 0,
      brokerId: 'stale-broker',
      token: 'stale-token',
      generation: 'stale-generation'
    })}\n`);

    assert.equal(await quiesceSandboxControlRoot(root, { timeoutMs: 100 }), 'stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary sandbox control GC removes only a verified absent-container root', async () => {
  const absentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-gc-absent-'));
  const foundRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-gc-found-'));
  const unknownRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-gc-unknown-'));
  try {
    writeControlManifest(absentRoot, initializeRepository(absentRoot), 'gc-absent-generation');
    await garbageCollectSandboxControlRoot(absentRoot, {
      timeoutMs: 200,
      inspectContainer: async () => ({ state: 'absent', id: 'container-id' })
    });
    assert.equal(fs.existsSync(absentRoot), false);

    writeControlManifest(foundRoot, initializeRepository(foundRoot), 'gc-found-generation');
    await assert.rejects(
      () => garbageCollectSandboxControlRoot(foundRoot, {
        timeoutMs: 200,
        inspectContainer: async () => ({ state: 'found', id: 'container-id', running: false, labels: {} })
      }),
      /SANDBOX_CONTROL_CONTAINER_REAPPEARED/
    );
    assert.equal(fs.existsSync(foundRoot), true);

    writeControlManifest(unknownRoot, initializeRepository(unknownRoot), 'gc-unknown-generation');
    await assert.rejects(
      () => garbageCollectSandboxControlRoot(unknownRoot, {
        timeoutMs: 200,
        inspectContainer: async () => ({ state: 'unknown', reason: 'probe failed' })
      }),
      /SANDBOX_CONTROL_CONTAINER_UNKNOWN/
    );
    assert.equal(fs.existsSync(unknownRoot), true);
  } finally {
    for (const root of [absentRoot, foundRoot, unknownRoot]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control removal gives container operations a bounded pre-force budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-deadline-'));
  let callbackTimeout = 0;
  let callbackFinished!: () => void;
  const callbackDone = new Promise<void>((resolve) => { callbackFinished = resolve; });
  try {
    writeControlManifest(root, initializeRepository(root), 'remove-deadline-generation');
    await assert.rejects(
      () => removeSandboxControlRoot(root, {
        timeoutMs: 200,
        inspectContainer: async () => ({ state: 'found', id: 'container-id', running: false, labels: {} }),
        removeContainer: async (timeoutMs) => {
          callbackTimeout = timeoutMs;
          await new Promise((resolve) => setTimeout(resolve, 150));
          callbackFinished();
        }
      }),
      /SANDBOX_CONTROL_CONTAINER_STILL_EXISTS/
    );
    await callbackDone;
    assert.equal(callbackTimeout > 0, true);
    assert.equal(callbackTimeout <= 200, true);
    assert.equal(fs.existsSync(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control removal checks an absent startup transition after the pre-force budget expires', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-startup-budget-'));
  let removeCalled = false;
  try {
    writeControlManifest(root, initializeRepository(root), 'remove-startup-budget-generation');
    await removeSandboxControlRoot(root, {
      timeoutMs: 1_000,
      inspectContainer: async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
        return { state: 'absent', id: 'container-id' };
      },
      removeContainer: async () => { removeCalled = true; }
    });

    assert.equal(removeCalled, false);
    assert.equal(fs.existsSync(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control removal completes all stages for stubborn broker and execution', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-stages-'));
  const brokerReadyPath = path.join(root, 'broker-ready');
  const executionReadyPath = path.join(root, 'execution-ready');
  const stubbornScript = "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);";
  const brokerProcess = spawn(process.execPath, ['--eval', stubbornScript, brokerReadyPath], { stdio: 'ignore' });
  const executionProcess = spawn(process.execPath, ['--eval', stubbornScript, executionReadyPath], {
    detached: true,
    stdio: 'ignore'
  });
  const stages: string[] = [];
  let inspectCalls = 0;
  try {
    waitForFile(brokerReadyPath, 5_000);
    waitForFile(executionReadyPath, 5_000);
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'remove-stages-generation');
    const brokerStartTime = getProcessStartTime(brokerProcess.pid!);
    const executionStartTime = getProcessStartTime(executionProcess.pid!);
    assert.ok(brokerStartTime);
    assert.ok(executionStartTime);
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3, pid: brokerProcess.pid, startTime: brokerStartTime, brokerId: 'stubborn-broker',
      token: 'lifecycle-secret', generation: 'remove-stages-generation'
    })}\n`);
    fs.writeFileSync(path.join(root, 'public', 'status.json'), `${JSON.stringify({
      version: 2, generation: 'remove-stages-generation',
      broker: { pid: brokerProcess.pid, startTime: brokerStartTime, brokerId: 'stubborn-broker' },
      state: 'busy', reasonCode: null, activeRequestId: 'stubborn-request', updatedAt: Date.now()
    })}\n`);
    const executionDir = path.join(root, 'processing', 'stubborn-request');
    fs.mkdirSync(executionDir);
    fs.writeFileSync(path.join(executionDir, 'execution.json'), `${JSON.stringify({
      version: 2, generation: 'remove-stages-generation', requestId: 'stubborn-request', nonce: 'stubborn-nonce',
      child: { pid: executionProcess.pid, startTime: executionStartTime, processGroupId: executionProcess.pid },
      phase: 'running', updatedAt: Date.now()
    })}\n`);

    await removeSandboxControlRoot(root, {
      timeoutMs: 1_000,
      inspectContainer: async () => {
        inspectCalls += 1;
        return inspectCalls === 1
          ? { state: 'found', id: 'container-id', running: true, labels: {} }
          : { state: 'absent', id: 'container-id' };
      },
      removeContainer: async () => {
        stages.push('container-remove');
        assert.equal(isProcessAlive(brokerProcess.pid!), true);
        assert.equal(isProcessAlive(executionProcess.pid!), true);
      }
    });

    assert.deepEqual(stages, ['container-remove']);
    assert.equal(inspectCalls, 2);
    assert.equal(isProcessAlive(brokerProcess.pid!), false);
    assert.equal(isProcessAlive(executionProcess.pid!), false);
    assert.equal(fs.existsSync(root), false);
  } finally {
    for (const child of [executionProcess, brokerProcess]) {
      if (child.pid && isProcessAlive(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control lifecycle terminates a live execution before accepting a stale broker', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-stale-execution-'));
  const execution = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore'
  });
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'stale-execution-generation');
    const executionStartTime = getProcessStartTime(execution.pid!);
    assert.ok(executionStartTime);
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3, pid: 999_999_999, startTime: 0, brokerId: 'stale-broker',
      token: 'lifecycle-secret', generation: 'stale-execution-generation'
    })}\n`);
    const executionDir = path.join(root, 'processing', 'stale-execution-request');
    fs.mkdirSync(executionDir);
    fs.writeFileSync(path.join(executionDir, 'execution.json'), `${JSON.stringify({
      version: 2, generation: 'stale-execution-generation', requestId: 'stale-execution-request',
      nonce: 'stale-execution-nonce',
      child: { pid: execution.pid, startTime: executionStartTime, processGroupId: execution.pid },
      phase: 'running', updatedAt: Date.now()
    })}\n`);

    assert.equal(await quiesceSandboxControlRoot(root, { timeoutMs: 100 }), 'stale');
    const exitDeadline = Date.now() + 2_000;
    while (isProcessAlive(execution.pid!) && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isProcessAlive(execution.pid!), false);
    assert.equal(fs.existsSync(manifestPath), true);
  } finally {
    if (execution.pid && isProcessAlive(execution.pid)) {
      try { process.kill(-execution.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control lifecycle excludes a concurrent broker recovery after quiescing begins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recovery-quiesce-'));
  let brokerPid: number | null = null;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'recovery-quiesce-generation');
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3, pid: 999_999_999, startTime: 0, brokerId: 'stale-broker',
      token: 'lifecycle-secret', generation: 'recovery-quiesce-generation'
    })}\n`);
    fs.writeFileSync(path.join(root, 'public', 'status.json'), `${JSON.stringify({
      version: 2, generation: 'recovery-quiesce-generation',
      broker: { pid: 999_999_999, startTime: 0, brokerId: 'stale-broker' }, state: 'healthy',
      reasonCode: null, activeRequestId: null, updatedAt: Date.now()
    })}\n`);

    const startup = startSandboxControlBroker(root, manifestPath).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );
    const result = await quiesceSandboxControlRoot(root, { timeoutMs: 1_000 });
    const startupResult = await startup;
    if (fs.existsSync(path.join(root, 'broker.json'))) {
      brokerPid = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8')).pid;
    }

    assert.equal(result, 'stale');
    assert.equal(startupResult.status, 'rejected');
    if (startupResult.status === 'rejected') assert.match(String(startupResult.error), /SANDBOX_CONTROL_QUIESCING/);
    assert.equal(brokerPid === null || !isProcessAlive(brokerPid), true);
    await assert.rejects(() => startSandboxControlBroker(root, manifestPath), /SANDBOX_CONTROL_QUIESCING/);
    assert.equal(fs.existsSync(manifestPath), true);
  } finally {
    if (brokerPid && isProcessAlive(brokerPid)) await stopBroker(brokerPid);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('sandbox control lifecycle waits for a live broker to finish its final writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-quiesce-'));
  let brokerPid: number | null = null;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch);
    await startSandboxControlBroker(root, manifestPath);
    const broker = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
    brokerPid = broker.pid;

    assert.equal(await quiesceSandboxControlRoot(root), 'stopped');
    assert.equal(isProcessAlive(broker.pid), false);
    assert.equal(fs.existsSync(path.join(root, 'broker.json')), false);
    const events = fs.readFileSync(path.join(root, 'audit.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line).event);
    assert.equal(events.at(-1), 'broker-stop');
  } finally {
    if (brokerPid && isProcessAlive(brokerPid)) await stopBroker(brokerPid);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('sandbox control lifecycle terminates execution trees before forcing an unresponsive broker', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-forced-quiesce-'));
  const brokerReadyPath = path.join(root, 'broker-ready');
  const executionReadyPath = path.join(root, 'execution-ready');
  const stubbornScript = "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);";
  const broker = spawn(process.execPath, ['--eval', stubbornScript, brokerReadyPath], { stdio: 'ignore' });
  const execution = spawn(process.execPath, ['--eval', stubbornScript, executionReadyPath], {
    detached: true,
    stdio: 'ignore'
  });
  try {
    waitForFile(brokerReadyPath, 5_000);
    waitForFile(executionReadyPath, 5_000);
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'forced-generation');
    const brokerStartTime = getProcessStartTime(broker.pid!);
    const executionStartTime = getProcessStartTime(execution.pid!);
    assert.ok(brokerStartTime);
    assert.ok(executionStartTime);
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3, pid: broker.pid, startTime: brokerStartTime, brokerId: 'test-broker',
      token: 'lifecycle-secret', generation: 'forced-generation'
    })}\n`);
    fs.writeFileSync(path.join(root, 'public', 'status.json'), `${JSON.stringify({
      version: 2, generation: 'forced-generation', broker: { pid: broker.pid, startTime: brokerStartTime, brokerId: 'test-broker' },
      state: 'healthy', reasonCode: null, activeRequestId: 'forced-request', updatedAt: Date.now()
    })}\n`);
    const executionDir = path.join(root, 'processing', 'forced-request');
    fs.mkdirSync(executionDir);
    fs.writeFileSync(path.join(executionDir, 'execution.json'), `${JSON.stringify({
      version: 2, generation: 'forced-generation', requestId: 'forced-request', nonce: 'forced-nonce',
      child: { pid: execution.pid, startTime: executionStartTime, processGroupId: execution.pid },
      phase: 'running', updatedAt: Date.now()
    })}\n`);

    assert.equal(await quiesceSandboxControlRoot(root, { timeoutMs: 1_000 }), 'stopped');
    assert.equal(isProcessAlive(execution.pid!), false);
    assert.equal(isProcessAlive(broker.pid!), false);
    assert.equal(fs.existsSync(manifestPath), true);
  } finally {
    for (const child of [execution, broker]) {
      if (child.pid && isProcessAlive(child.pid)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox broker uses configured idle heartbeat and parked binding backoff intervals', async () => {
  assert.deepEqual(DEFAULT_SANDBOX_CONTROL_TIMING, {
    controlTickMs: 250,
    parkedBindingInitialMs: 1_000,
    slowCheckMs: 5_000,
    containerHeartbeatMs: 5_000,
    quiesceDeadlineMs: 7_000
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-timing-'));
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'timing-generation');
    const statusDir = path.join(root, 'public');
    const timing = {
      controlTickMs: 5,
      parkedBindingInitialMs: 10,
      slowCheckMs: 30,
      containerHeartbeatMs: 20,
      quiesceDeadlineMs: 200
    };
    const controller = new AbortController();
    let heartbeatQueries = 0;
    const heartbeatTimes: number[] = [];
    const serving = serveSandboxControl(manifestPath, controller.signal, {
      timing,
      inspectContainer: async () => {
        heartbeatQueries += 1;
        heartbeatTimes.push(monotonicNowMs());
        if (heartbeatQueries >= 2) controller.abort();
        return { state: 'found', id: 'container-id', running: false, labels: {} };
      }
    });
    let heartbeatWatchdogFired = false;
    const heartbeatWatchdog = setTimeout(() => {
      heartbeatWatchdogFired = true;
      controller.abort();
    }, 1_000);
    try {
      await waitForStatusStateAsync(statusDir, 'healthy', 2_000);
      await serving;
    } finally {
      clearTimeout(heartbeatWatchdog);
      if (!controller.signal.aborted) controller.abort();
      await serving;
    }
    assert.equal(heartbeatWatchdogFired, false);
    assert.equal(heartbeatQueries, 2);
    assertMinimumIntervals(heartbeatTimes, [timing.containerHeartbeatMs], 'container heartbeat');
    assert.equal(fs.readdirSync(path.join(root, 'processing')).length, 0);

    const parkedController = new AbortController();
    let bindingChecks = 0;
    const parkedTiming = { ...timing, containerHeartbeatMs: 1_000 };
    const bindingTimes: number[] = [];
    const parkedServing = serveSandboxControl(manifestPath, parkedController.signal, {
      timing: parkedTiming,
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: false, labels: {} }),
      bindingCheck: () => {
        bindingChecks += 1;
        bindingTimes.push(monotonicNowMs());
        if (bindingChecks >= 5) parkedController.abort();
        return 'SANDBOX_WORKTREE_BINDING_LOST';
      }
    });
    let parkedWatchdogFired = false;
    const parkedWatchdog = setTimeout(() => {
      parkedWatchdogFired = true;
      parkedController.abort();
    }, 1_000);
    try {
      await waitForStatusStateAsync(statusDir, 'parked', 2_000);
      await parkedServing;
    } finally {
      clearTimeout(parkedWatchdog);
      if (!parkedController.signal.aborted) parkedController.abort();
      await parkedServing;
    }
    assert.equal(parkedWatchdogFired, false);
    assert.equal(bindingChecks, 5);
    assertMinimumIntervals(bindingTimes, [
      parkedTiming.parkedBindingInitialMs,
      parkedTiming.parkedBindingInitialMs * 2,
      parkedTiming.slowCheckMs,
      parkedTiming.slowCheckMs
    ], 'parked binding');
    assert.equal(fs.readdirSync(path.join(root, 'processing')).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox broker self-GCs its control root after an authoritative absent heartbeat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-heartbeat-absent-'));
  const controller = new AbortController();
  let heartbeatQueries = 0;
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'heartbeat-absent-generation');
    const serving = serveSandboxControl(manifestPath, controller.signal, {
      timing: {
        controlTickMs: 5,
        parkedBindingInitialMs: 10,
        slowCheckMs: 30,
        containerHeartbeatMs: 5,
        quiesceDeadlineMs: 200
      },
      inspectContainer: async () => {
        heartbeatQueries += 1;
        return { state: 'absent', id: 'container-id' };
      }
    });
    const deadline = Date.now() + 2_000;
    while (fs.existsSync(root) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await serving;
    assert.equal(fs.existsSync(root), false);
    assert.equal(heartbeatQueries >= 2, true);
  } finally {
    controller.abort();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox broker retains ownership and backs off after an unknown heartbeat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-heartbeat-unknown-'));
  const controller = new AbortController();
  let heartbeatQueries = 0;
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'heartbeat-unknown-generation');
    const statusDir = path.join(root, 'public');
    const serving = serveSandboxControl(manifestPath, controller.signal, {
      timing: {
        controlTickMs: 5,
        parkedBindingInitialMs: 10,
        slowCheckMs: 30,
        containerHeartbeatMs: 5,
        quiesceDeadlineMs: 200
      },
      inspectContainer: async () => {
        heartbeatQueries += 1;
        return heartbeatQueries < 3
          ? { state: 'unknown', reason: 'probe unavailable' }
          : { state: 'found', id: 'container-id', running: false, labels: {} };
      }
    });
    await waitForStatusStateAsync(statusDir, 'parked', 2_000);
    const parkedStatus = JSON.parse(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8'));
    assert.equal(parkedStatus.reasonCode, 'SANDBOX_CONTROL_CONTAINER_UNKNOWN');
    const heartbeatDeadline = Date.now() + 2_000;
    while (heartbeatQueries < 3 && Date.now() < heartbeatDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(heartbeatQueries >= 3, true);
    assert.equal(fs.existsSync(root), true);
    assert.equal(fs.existsSync(path.join(root, 'channel')), true);
    assert.equal(fs.existsSync(path.join(root, 'broker.json')), true);
    controller.abort();
    await serving;
  } finally {
    controller.abort();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'readiness-secret', generation: 'readiness-generation',
    channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
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
      await stopBroker(brokerPid);
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
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'owner-secret', generation: 'owner-generation',
    channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
    version: 3, pid: 999_999_999, startTime: 0, brokerId: 'stale-owner', token: 'owner-secret', generation: 'owner-generation'
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
      engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
      containerIdentity: { id: 'container-id', labels: {} }, branch,
      mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'rotated-owner-secret', generation: 'rotated-generation',
      channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
    })}\n`);
    await startSandboxControlBroker(root, manifestPath);
    const rotated = JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8'));
    brokerPid = rotated.pid;
    assert.notEqual(rotated.pid, first.pid);
    waitForHealthyStatus(statusDir, 2_000);
    const status = JSON.parse(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8'));
    assert.equal(status.generation, 'rotated-generation');
    assert.equal(status.broker.pid, rotated.pid);
    waitForAuditEvent(path.join(root, 'audit.ndjson'), 'broker-state', 'rotated-generation', 2_000);
    const oldOwnerDeadline = Date.now() + 2_000;
    while (isProcessAlive(first.pid) && Date.now() < oldOwnerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isProcessAlive(first.pid), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8')).brokerId, rotated.brokerId);
    const statusAfterReplacement = fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8');
    const auditAfterReplacement = fs.readFileSync(path.join(root, 'audit.ndjson'), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8'), statusAfterReplacement);
    assert.equal(fs.readFileSync(path.join(root, 'audit.ndjson'), 'utf8'), auditAfterReplacement);
  } finally {
    if (brokerPid) {
      await stopBroker(brokerPid);
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
  const statusPath = path.join(statusDir, 'status.json');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir);
  fs.mkdirSync(statusDir);
  const responseBrokerStartTime = getProcessStartTime(process.pid);
  assert.ok(responseBrokerStartTime);
  fs.writeFileSync(statusPath, `${JSON.stringify({
    version: 2,
    generation: 'response-generation',
    broker: { pid: process.pid, startTime: responseBrokerStartTime, brokerId: 'test-broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now()
  })}\n`);
  const clientModule = path.resolve('lib/sandbox/control/client.ts');
  const runClient = (): CollectedChild => {
    const script = `
      import { requestSandboxControl } from ${JSON.stringify(clientModule)};
      try {
        const response = requestSandboxControl({
          family: 'task-orchestration', args: ['01', 'status'],
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
    return collectChild(spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  };
  const responseFor = (id: string) => ({
    version: 2, id, phase: 'rejected', exitCode: null, stdout: '',
    stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  });
  let transientClient: CollectedChild | null = null;
  let stableClient: CollectedChild | null = null;
  try {
    transientClient = runClient();
    const transientName = await waitForRequestAsync(requestsDir, 2_000, { client: transientClient });
    const transientId = transientName.slice(0, -5);
    const transientPath = path.join(responsesDir, `${transientId}.json`);
    fs.writeFileSync(path.join(responsesDir, `${transientId}.accepted.json`), `${JSON.stringify({
      version: 2, id: transientId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    fs.writeFileSync(transientPath, '{"version":2,"id":"');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    fs.writeFileSync(transientPath, `${JSON.stringify(responseFor(transientId))}\n`);
    const transient = await transientClient.result;
    assert.equal(transient.exitCode, 0, transient.stderr || transient.stdout);
    assert.equal(JSON.parse(transient.stdout).response.error.code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
    assert.equal(fs.existsSync(transientPath), true);

    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    status.updatedAt = Date.now();
    fs.writeFileSync(statusPath, `${JSON.stringify(status)}\n`);
    stableClient = runClient();
    const stableName = await waitForRequestAsync(requestsDir, 2_000, {
      client: stableClient,
      exclude: transientName
    });
    fs.writeFileSync(path.join(responsesDir, stableName), '{"version":2');
    const stable = await stableClient.result;
    assert.equal(stable.exitCode, 1);
    assert.equal(JSON.parse(stable.stdout).code, 'SANDBOX_CONTROL_RESPONSE_INVALID');
  } finally {
    await Promise.all([stopCollectedChild(transientClient), stopCollectedChild(stableClient)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control recovery reads the retained terminal response by request id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recover-client-'));
  const responsesDir = path.join(root, 'responses');
  const requestId = '33333333-3333-3333-3333-333333333333';
  fs.mkdirSync(responsesDir, { recursive: true });
  const response = {
    version: 2, id: requestId, phase: 'completed', exitCode: 0,
    stdout: 'recovered\n', stderr: '', error: null
  };
  fs.writeFileSync(path.join(responsesDir, `${requestId}.json`), `${JSON.stringify(response)}\n`);
  try {
    assert.deepEqual(recoverSandboxControl(requestId, { channelDir: root, timeoutMs: 100 }), response);
    assert.equal(fs.existsSync(path.join(responsesDir, `${requestId}.json`)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization client exposes accepted result loss as a structured unknown result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-unknown-'));
  const channelDir = path.join(root, 'channel');
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const statusDir = path.join(root, 'public');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir);
  fs.mkdirSync(statusDir);
  const startTime = getProcessStartTime(process.pid);
  assert.ok(startTime);
  const generation = 'finalization-generation';
  fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
    version: 2,
    generation,
    broker: { pid: process.pid, startTime, brokerId: 'finalization-broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now()
  })}\n`);
  const client = collectChild(spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'),
    'sandbox-control', 'client', 'task-finalization', '08', 'complete', '--agent', 'codex'
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      AGENT_INFRA_CONTROL_TOKEN: 'finalization-secret',
      AGENT_INFRA_CONTROL_GENERATION: generation,
      AGENT_INFRA_CONTROL_DIR: channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }));
  try {
    const requestName = await waitForRequestAsync(requestsDir, 2_000, { client });
    const request = JSON.parse(fs.readFileSync(path.join(requestsDir, requestName), 'utf8')) as Record<string, unknown>;
    assert.equal(request.family, 'task-finalization');
    assert.equal(request.operation, 'complete');
    assert.equal(request.agent, 'codex');
    assert.deepEqual(request.args, []);
    assert.equal('taskRef' in request, false);
    assert.equal('repoRoot' in request, false);
    fs.writeFileSync(path.join(responsesDir, requestName), `${JSON.stringify({
      version: 2,
      id: requestName.slice(0, -5),
      phase: 'rejected',
      exitCode: null,
      stdout: '',
      stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
      error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
    })}\n`);
    const result = await client.result;
    assert.equal(result.exitCode, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1,
      status: 'unknown',
      changed: false,
      accepted: true,
      result: null,
      error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
    });
    assert.match(result.stderr, /result unknown/);
  } finally {
    await stopCollectedChild(client);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-bound finalization compensates an accepted response loss through the same host executor entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-compensation-'));
  const taskId = 'TASK-20260809-010203';
  const token = 'lifecycle-secret';
  const generation = 'finalization-compensation-generation';
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    const activeTaskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
    fs.mkdirSync(activeTaskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
    fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '08': taskId } })}\n`);
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
      skill: 'complete-task',
      checks: { 'required-pr-delivery': null }
    }));
    fs.writeFileSync(path.join(activeTaskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'type: bugfix', 'workflow: bug-fix', 'status: active',
      'created_at: 2026-08-09 01:02:03+00:00', 'updated_at: 2026-08-09 01:02:03+00:00',
      'agent_infra_version: v0.9.9', 'current_step: code-review', 'assigned_to: codex',
      'target_date:', '---', '', '# Task', '', '## Review Disagreement Ledger', '',
      '| id | stage | round | severity | status | evidence |',
      '|----|-------|-------|----------|--------|----------|', '', '## Activity Log', ''
    ].join('\n'));

    const statusDir = path.join(root, 'public');
    const channelDir = path.join(root, 'channel');
    const requestsDir = path.join(channelDir, 'requests');
    const responsesDir = path.join(channelDir, 'responses');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(responsesDir, { recursive: true });
    const startTime = getProcessStartTime(process.pid);
    assert.ok(startTime);
    fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
      version: 2,
      generation,
      broker: { pid: process.pid, startTime, brokerId: 'finalization-compensation-broker' },
      state: 'healthy',
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now()
    })}\n`);
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3,
      pid: process.pid,
      startTime,
      brokerId: 'finalization-compensation-broker',
      token,
      generation
    })}\n`);
    const statusPath = path.join(statusDir, 'status.json');
    heartbeat = setInterval(() => {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
        atomicWriteJson(statusPath, { ...status, updatedAt: Date.now() });
      } catch {
        // The fixture is being removed.
      }
    }, 250);

    const serveOne = async (dropCompletedResponse: boolean) => {
      const requestName = await waitForRequestAsync(requestsDir, SANDBOX_CONTROL_TEST_TIMEOUT_MS);
      const requestPath = path.join(requestsDir, requestName);
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as { id: string; family: string; operation: string; agent: string };
      assert.equal(request.id, requestName.slice(0, -5));
      assert.equal(request.family, 'task-finalization');
      assert.equal(request.operation, 'complete');
      assert.equal(request.agent, 'codex');
      const prepared = await prepareSandboxControlExecution({
        manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        manifestPath,
        request: JSON.parse(fs.readFileSync(requestPath, 'utf8')),
        requestPath,
        internalCliPath: path.resolve('bin/internal-cli.ts')
      });
      fs.writeFileSync(path.join(responsesDir, `${request.id}.accepted.json`), `${JSON.stringify({
        version: 2, id: request.id, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
      })}\n`);
      prepared.start();
      const executionResult = await prepared.completion;
      if (!dropCompletedResponse) {
        fs.writeFileSync(path.join(responsesDir, requestName), `${JSON.stringify({
          version: 2, id: request.id, phase: 'completed', exitCode: executionResult.exitCode,
          stdout: executionResult.stdout, stderr: executionResult.stderr, error: null
        })}\n`);
      }
      fs.rmSync(path.join(root, 'processing', request.id), { recursive: true, force: true });
      fs.rmSync(requestPath, { force: true });
      return executionResult;
    };

    const firstBroker = serveOne(true);
    const firstClient = await runTaskFinalizationClient({ channelDir, statusDir, token, generation, timeoutMs: 500 });
    const firstExecution = await firstBroker;
    assert.equal(firstClient.exitCode, 1);
    assert.equal((firstClient.payload.error as { code?: string }).code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
    assert.equal(firstClient.payload.accepted, true);
    assert.equal(JSON.parse(firstExecution.stdout).status, 'completed');
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'completed', taskId, 'task.md')), true);

    const registryPath = path.join(root, '.agents', 'workspace', 'active', '.short-ids.json');
    fs.writeFileSync(registryPath, '{not-json\n');
    const failedBroker = serveOne(false);
    const failedClient = await runTaskFinalizationClient({ channelDir, statusDir, token, generation, timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS });
    const failedExecution = await failedBroker;
    assert.equal(failedExecution.exitCode, 1);
    assert.equal(failedClient.exitCode, 0);
    assert.equal(failedClient.payload.phase, 'completed');
    const failedOutput = String(failedClient.payload.stdout);
    assert.equal(failedOutput.includes(root), false);
    assert.equal(failedExecution.stdout.includes(root), false);
    assert.equal(fs.readFileSync(path.join(root, '.agents', 'workspace', '.task-finalization', `${taskId}.json`), 'utf8').includes(root), false);
    assert.equal((JSON.parse(failedOutput) as { error: { code: string } }).error.code, 'TASK_FINALIZATION_SHORT_ID_REGISTRY_UNAVAILABLE');

    fs.writeFileSync(registryPath, `${JSON.stringify({ version: 1, ids: {} })}\n`);
    const secondBroker = serveOne(false);
    const secondClient = await runTaskFinalizationClient({ channelDir, statusDir, token, generation, timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS });
    const secondExecution = await secondBroker;
    assert.equal(secondClient.exitCode, 0, secondClient.stderr);
    assert.equal(secondClient.payload.phase, 'completed');
    const compensated = JSON.parse(String(secondClient.payload.stdout)) as {
      status: string;
      changed: boolean;
      result: { status: string; changed: boolean; lifecycle: { status: string }; taskComment: { status: string }; verification: { status: string } };
    };
    assert.equal(compensated.status, 'completed');
    assert.equal(compensated.changed, false);
    assert.equal(compensated.result.status, 'completed');
    assert.equal(compensated.result.changed, false);
    assert.equal(compensated.result.lifecycle.status, 'no-op');
    assert.equal(compensated.result.taskComment.status, 'skipped');
    assert.equal(compensated.result.verification.status, 'no-op');
    assert.equal(JSON.parse(secondExecution.stdout).status, 'completed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), 'utf8')).ids, {});
  } finally {
    if (heartbeat) clearInterval(heartbeat);
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
  const taskId = 'TASK-20260809-010203';
  fs.mkdirSync(channelDir, { recursive: true });
  fs.mkdirSync(statusDir);
  fs.mkdirSync(processingDir);
  const branch = initializeRepository(root);
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  const runPath = path.join(taskDir, 'orchestration.json');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  fs.writeFileSync(runPath, '{"schemaVersion":3}\n');
  const invalidRunBytes = fs.readFileSync(runPath, 'utf8');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'docker',
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} },
    branch,
    mode: 'task-bound',
    taskId,
    token,
    generation,
    channelDir,
    publicStatusDir: statusDir,
    processingDir,
    runtimeDir: path.join(root, 'runtime')
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForFile(path.join(root, 'broker.json'), 5_000);
    waitForHealthyStatus(statusDir, 5_000);
    const orchestrationResponse = requestSandboxControl({
      family: 'task-orchestration',
      args: [taskId, 'status'],
      channelDir,
      statusDir,
      token,
      generation,
      timeoutMs: 5_000
    });
    assert.equal(orchestrationResponse.exitCode, 1);
    assert.equal(JSON.parse(orchestrationResponse.stdout).error.code, 'ORCHESTRATION_STATE_INVALID');
    assert.equal(fs.readFileSync(runPath, 'utf8'), invalidRunBytes);
    assert.equal(readSandboxControlManifest(manifestPath).taskId, taskId);

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

test('sandbox broker opens and closes a host-only Codex controller registration across processes', onPlatforms('linux'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-controller-roundtrip-'));
  const channelDir = path.join(root, 'channel');
  const manifestPath = path.join(root, 'manifest.json');
  const statusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  const fakeBin = path.join(root, 'bin-fixture');
  for (const directory of [channelDir, statusDir, processingDir, fakeBin]) fs.mkdirSync(directory, { recursive: true });
  const branch = initializeRepository(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.9.9-alpha.0' }));
  for (const relative of [
    '.codex/hooks.json',
    '.codex/agents/agent-infra-lifecycle-executor.toml',
    '.codex/agents/agent-infra-lifecycle-reviewer.toml',
    '.agents/hooks/lifecycle-delegation.js',
    '.agents/skills/run-task/SKILL.md',
    '.agents/rules/lifecycle-orchestration.md'
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  const docker = path.join(fakeBin, 'docker');
  fs.writeFileSync(docker, '#!/bin/sh\n[ "$1" = exec ] && [ "$3" = cat ] && exec cat "$4"\nexit 1\n', { mode: 0o700 });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'native',
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} },
    branch,
    mode: 'task-bound',
    taskId: 'TASK-20260809-010203',
    token: 'controller-secret',
    generation: 'controller-generation',
    channelDir,
    publicStatusDir: statusDir,
    processingDir,
    runtimeDir: path.join(root, 'runtime')
  })}\n`);
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'serve', '--manifest', manifestPath],
    { cwd: path.resolve('.'), stdio: 'ignore', env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` } }
  );
  try {
    waitForFile(path.join(root, 'broker.json'), 5_000);
    waitForHealthyStatus(statusDir, 5_000);
    const startTime = getProcessStartTime(process.pid);
    assert.ok(startTime);
    const opened = requestCodexControllerOpen({
      controllerProcess: { pid: process.pid, startTime },
      channelDir,
      statusDir,
      token: 'controller-secret',
      generation: 'controller-generation',
      timeoutMs: 5_000
    });
    const registration = fs.readFileSync(path.join(root, 'codex-controller.json'), 'utf8');
    assert.equal(registration.includes(opened.lease.leaseSecret), false);
    assert.equal(fs.lstatSync(path.join(root, 'codex-controller.json')).mode & 0o777, 0o600);
    const verified = requestCodexControllerVerify({
      controllerProof: {
        version: 1,
        leaseId: opened.lease.leaseId,
        leaseSecret: opened.lease.leaseSecret,
        controllerProcess: opened.lease.controllerProcess
      },
      channelDir,
      statusDir,
      token: 'controller-secret',
      generation: 'controller-generation',
      timeoutMs: 5_000
    });
    assert.deepEqual(verified.binding, {
      taskId: 'TASK-20260809-010203',
      controlGeneration: 'controller-generation',
      controllerInstanceDigest: opened.lease.controllerInstanceDigest
    });
    const closed = requestCodexControllerClose({
      controllerProcess: opened.lease.controllerProcess,
      controllerProof: {
        version: 1,
        leaseId: opened.lease.leaseId,
        leaseSecret: opened.lease.leaseSecret,
        controllerProcess: opened.lease.controllerProcess
      },
      channelDir,
      statusDir,
      token: 'controller-secret',
      generation: 'controller-generation',
      timeoutMs: 5_000
    });
    assert.equal(closed.changed, true);
    assert.equal(fs.existsSync(path.join(root, 'codex-controller.json')), false);
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
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 }, platform: { type: null }, delivery: { remote: 'origin', baseRef: 'main' } }));
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, branch,
    mode: 'branch-only', taskId: null, token, generation, channelDir,
    publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'control', 'runtime')
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
    assert.equal(replay.phase, 'completed');
    assert.equal(JSON.parse(replay.stdout).status, 'applied');
    assert.equal(fs.existsSync(path.join(channelDir, 'responses', `${requestId}.accepted.json`)), false);
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
  const recoverableId = '33333333-3333-3333-3333-333333333333';
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.mkdirSync(statusDir);
  fs.mkdirSync(path.join(processingDir, terminalId), { recursive: true });
  fs.mkdirSync(path.join(processingDir, unacceptedId), { recursive: true });
  fs.mkdirSync(path.join(processingDir, recoverableId), { recursive: true });
  const branch = initializeRepository(root);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'recovery-secret', generation,
    channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  const terminalResponse = {
    version: 2, id: terminalId, phase: 'completed', exitCode: 0, stdout: 'done\n', stderr: '', error: null
  };
  fs.writeFileSync(path.join(responsesDir, `${terminalId}.json`), `${JSON.stringify(terminalResponse)}\n`);
  fs.writeFileSync(path.join(processingDir, terminalId, 'execution.json'), `${JSON.stringify({
    version: 2, generation, requestId: terminalId, nonce: 'recovery-nonce',
    child: { pid: 999_999_999, startTime: 0, processGroupId: null },
    phase: 'running', updatedAt: Date.now()
  })}\n`);
  fs.writeFileSync(path.join(processingDir, recoverableId, 'request.json'), `${JSON.stringify({
    version: 3, id: recoverableId, token: 'recovery-secret', generation, issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 1_000, family: 'task-orchestration', args: ['task-orchestration', 'verify'],
    controllerProcess: null, controllerProof: null
  })}\n`);
  fs.writeFileSync(path.join(processingDir, recoverableId, 'execution.json'), `${JSON.stringify({
    version: 2, generation, requestId: recoverableId, nonce: 'recoverable-nonce',
    child: { pid: 999_999_999, startTime: 0, processGroupId: null },
    phase: 'running', updatedAt: Date.now()
  })}\n`);
  const controlManifest = {
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, branch, mode: 'task-bound' as const, taskId: 'TASK-20260809-010203',
    token: 'recovery-secret', generation, channelDir, publicStatusDir: statusDir, processingDir,
    runtimeDir: path.join(root, 'runtime')
  };
  writeSandboxControlReservation(controlManifest, recoverableId, { logicalRecords: 1, bytes: 0 });
  writeSandboxControlResultEvidence(controlManifest, recoverableId, { exitCode: 0, stdout: 'lost output', stderr: '' });
  writeSandboxControlPayload(controlManifest, recoverableId, { stdout: 'lost output', stderr: '' });
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
    const recovered = JSON.parse(fs.readFileSync(path.join(responsesDir, `${recoverableId}.json`), 'utf8'));
    assert.equal(recovered.phase, 'completed');
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.outputState, 'available');
    assert.equal(recovered.stdout, '');
    assert.equal(recovered.stderr, '');
    assert.equal(recoverSandboxControl(recoverableId, { channelDir, timeoutMs: 100 }).stdout, 'lost output');
    assert.equal(fs.existsSync(path.join(processingDir, recoverableId)), false);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function runFinalizationRecoveryCase(
  label: 'success' | 'warnings' | 'missing-receipt' | 'binding-conflict',
  receiptBinding: { generation: string; requestId: string } | null
): Promise<{ response: Record<string, unknown> | null; retained: boolean }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-infra-finalization-recovery-${label}-`));
  const taskId = 'TASK-20260809-010203';
  const requestId = label === 'success'
    ? '44444444-4444-4444-4444-444444444444'
    : label === 'warnings'
      ? '55555555-5555-5555-5555-555555555555'
      : label === 'missing-receipt'
        ? '66666666-6666-6666-6666-666666666666'
        : '77777777-7777-7777-7777-777777777777';
  const generation = 'finalization-recovery-generation';
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    const manifest = readSandboxControlManifest(manifestPath);
    fs.mkdirSync(path.join(manifest.channelDir, 'responses'), { recursive: true });
    const completedTaskDir = path.join(root, '.agents', 'workspace', 'completed', taskId);
    fs.mkdirSync(completedTaskDir, { recursive: true });
    fs.writeFileSync(path.join(completedTaskDir, 'task.md'), `---\nid: ${taskId}\nstatus: completed\n---\n\n# Task\n`);
    const processingDir = path.join(manifest.processingDir, requestId);
    fs.mkdirSync(processingDir, { recursive: true });
    const issuedAt = Date.now() - 1_000;
    fs.writeFileSync(path.join(processingDir, 'request.json'), `${JSON.stringify({
      version: 3, id: requestId, token: manifest.token, generation, issuedAt,
      expiresAt: issuedAt + 1_000, family: 'task-finalization', operation: 'complete', agent: 'codex', args: [],
      controllerProcess: null, controllerProof: null
    })}\n`);
    fs.writeFileSync(path.join(processingDir, 'execution.json'), `${JSON.stringify({
      version: 2, generation, requestId, nonce: 'recovery-finalization-nonce',
      child: { pid: 999_999_999, startTime: 0, processGroupId: null }, phase: 'running', updatedAt: Date.now()
    })}\n`);
    writeSandboxControlReservation(manifest, requestId, { logicalRecords: 0, bytes: 0 });
    writeSandboxControlResultEvidence(manifest, requestId, { exitCode: 0, stdout: 'finalization output', stderr: '' });
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.accepted.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);
    if (receiptBinding) {
      const receiptDir = path.join(root, '.agents', 'workspace', '.task-finalization');
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(path.join(receiptDir, `${taskId}.json`), `${JSON.stringify({
        version: 2, taskId, intent: 'complete', receiptId: `receipt-${label}`, revision: 1,
        lifecycle: 'done', taskComment: label === 'warnings' ? 'pending' : 'done', verification: 'done',
        warningProjection: 'done',
        warnings: label === 'warnings' ? [{
          code: 'COMMENT_SYNC_FAILED', message: 'comment sync needs retry', retryable: true,
          step: 'task-comment', target: 'issue', severity: 'ACTION_REQUIRED', status: 'open', resolvedAt: null
        }] : [],
        controlBinding: receiptBinding, updatedAt: new Date().toISOString(), lastError: null
      })}\n`);
    }
    const controller = new AbortController();
    const server = serveSandboxControl(manifestPath, controller.signal, {
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const responsePath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    const response = fs.existsSync(responsePath)
      ? JSON.parse(fs.readFileSync(responsePath, 'utf8')) as Record<string, unknown>
      : null;
    const retained = fs.existsSync(processingDir);
    controller.abort();
    await server;
    return { response, retained };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('broker recovery accepts a finalization result only with the matching completed receipt', async () => {
  const result = await runFinalizationRecoveryCase('success', {
    generation: 'finalization-recovery-generation',
    requestId: '44444444-4444-4444-4444-444444444444'
  });
  assert.equal(result.response?.phase, 'completed');
  assert.equal((JSON.parse(String(result.response?.stdout)) as { result: { result: string } }).result.result, 'completed');
  assert.equal(result.retained, false);
});

test('broker recovery preserves the finalization warning result projection', async () => {
  const result = await runFinalizationRecoveryCase('warnings', {
    generation: 'finalization-recovery-generation',
    requestId: '55555555-5555-5555-5555-555555555555'
  });
  assert.equal(result.response?.phase, 'completed');
  assert.equal((JSON.parse(String(result.response?.stdout)) as { result: { result: string } }).result.result, 'completed_with_warnings');
  assert.equal(result.retained, false);
});

test('broker recovery retains finalization evidence when the canonical receipt is missing', async () => {
  const result = await runFinalizationRecoveryCase('missing-receipt', null);
  assert.equal(result.response, null);
  assert.equal(result.retained, true);
});

test('broker recovery retains finalization evidence when the receipt binding conflicts', async () => {
  const result = await runFinalizationRecoveryCase('binding-conflict', {
    generation: 'other-generation',
    requestId: '88888888-8888-4888-8888-888888888888'
  });
  assert.equal(result.response, null);
  assert.equal(result.retained, true);
});
