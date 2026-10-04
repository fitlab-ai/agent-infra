import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  requestCodexControllerClose,
  requestCodexControllerOpen,
  requestCodexControllerVerify,
  recoverSandboxControl,
  recoverSandboxControlFromChannel,
  recoverAcceptedTaskFinalization,
  requestSandboxControl,
  SandboxControlClientError,
  requestSandboxTaskCreate
} from '../../../lib/sandbox/control/client.ts';
import {
  advanceSandboxRemovalJournalPhase,
  claimSandboxRemovalJournal,
  clearSandboxRemovalJournal,
  clearSandboxRemovalJournalRecord,
  garbageCollectSandboxControlRoot,
  readSandboxRemovalJournal,
  quiesceSandboxControlRoot,
  readSandboxControlManifest,
  removeSandboxControlRoot
} from '../../../lib/sandbox/control/lifecycle.ts';
import { DEFAULT_SANDBOX_CONTROL_TIMING } from '../../../lib/sandbox/control/protocol.ts';
import { writeSandboxControlIdentitySentinel } from '../../../lib/sandbox/control/identity-sentinel.ts';
import { prepareSandboxControlExecution } from '../../../lib/sandbox/control/executor.ts';
import {
  atomicWriteJson,
  createSandboxControlTerminalResult,
  writeSandboxControlPayload,
  writeSandboxControlReservation,
  writeSandboxControlResultEvidence,
  writeSandboxControlTerminalResult
} from '../../../lib/sandbox/control/state.ts';
import {
  appendCriticalAudit,
  appendDiagnosticAudit,
  createSandboxControlAuditContext,
  writeSandboxControlTransition
} from '../../../lib/sandbox/control/audit.ts';
import { recoverSandboxControlFromHost } from '../../../lib/sandbox/control/host-recovery.ts';
import { serveSandboxControl } from '../../../lib/sandbox/control/server.ts';
import { captureSandboxAuthority } from '../../../lib/sandbox/engines/authority.ts';
import { startSandboxControlBroker } from '../../../lib/sandbox/recovery.ts';
import { getProcessStartTime, isProcessAlive } from '../../../lib/server/process-state.ts';
import { createLocalTask } from '../../../lib/task/create.ts';
import { taskCreateOutputUnavailableResult } from '../../../lib/task/create-service.ts';
import { serializeTaskFinalizationEnvelope } from '../../../lib/task/finalization-envelope.ts';
import { prepareTaskFinalization } from '../../../lib/task/finalization.ts';
import { mutateShortIdRegistry } from '../../../lib/task/short-id.ts';
import { platformResult } from '../../../lib/platform/types.ts';
import { onPlatforms } from '../../helpers.ts';
import { SANDBOX_CONTROL_STATUS_MOUNT } from '../../../lib/sandbox/environment.ts';


function waitForFile(filePath: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function readJsonFileAfterPublication(filePath: string, timeoutMs: number): Record<string, unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(`Timed out waiting for JSON in ${filePath}`);
}

function waitForAbsent(filePath: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`Timed out waiting for ${filePath} to disappear`);
}

async function waitForReceiptLifecycleDoneAsync(root: string, taskId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const receiptPaths = ['active', 'completed', 'blocked'].map((state) => path.join(root, '.agents', 'workspace', state, taskId, '.task-finalization.json'));
  while (Date.now() < deadline) {
    try {
      if (receiptPaths.some((receiptPath) => { try { return (JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as { lifecycle?: unknown }).lifecycle === 'done'; } catch { return false; } })) return;
    } catch {
      // The receipt may still be between atomic updates.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for completed finalization receipt for ${taskId}`);
}

async function waitForReceiptTerminalAsync(root: string, taskId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const receiptPaths = ['active', 'completed', 'blocked'].map((state) => path.join(root, '.agents', 'workspace', state, taskId, '.task-finalization.json'));
  while (Date.now() < deadline) {
    try {
      const receiptPath = receiptPaths.find((candidate) => fs.existsSync(candidate));
      if (!receiptPath) throw new Error('receipt not found');
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
        lifecycle?: unknown;
        taskComment?: unknown;
        verification?: unknown;
        warningProjection?: unknown;
      };
      if (receipt.lifecycle === 'done'
        && receipt.taskComment !== 'pending'
        && receipt.verification !== 'pending'
        && receipt.warningProjection === 'done') return;
    } catch {
      // The receipt may still be between atomic updates.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for terminal finalization receipt for ${taskId}`);
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

async function waitForStatusStateAsync(
  statusDir: string,
  state: string,
  timeoutMs: number,
  previousBrokerId?: string
): Promise<void> {
  const statusPath = path.join(statusDir, 'status.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as {
        state?: string;
        broker?: { brokerId?: string };
      };
      if (status.state === state
        && (previousBrokerId === undefined || status.broker?.brokerId !== previousBrokerId)) return;
    } catch {
      // Atomic publication may not have completed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${state} status in ${statusDir}`);
}

async function waitForResultEvidenceAsync(processingDir: string, timeoutMs: number): Promise<{ requestId: string; resultPath: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of fs.readdirSync(processingDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const resultPath = path.join(processingDir, entry.name, 'result.json');
      if (fs.existsSync(resultPath)) return { requestId: entry.name, resultPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for result evidence in ${processingDir}`);
}

function observeResultEvidence(t: TestContext, processingDir: string): Promise<{ requestId: string; resultPath: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for result read-back')), SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    t.after(() => clearTimeout(timer));
    const readFile = fs.readFileSync;
    const observer = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      const contents = readFile(...args);
      const resultPath = String(args[0]);
      if (path.basename(resultPath) === 'result.json' && path.dirname(path.dirname(resultPath)) === processingDir) {
        observer.mock.restore();
        clearTimeout(timer);
        // Resume after the broker records the read-back, before its next publication tick.
        resolve({ requestId: path.basename(path.dirname(resultPath)), resultPath });
      }
      return contents;
    });
  });
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
const SANDBOX_CONTROL_ENV_KEYS = [
  'AGENT_INFRA_SANDBOX',
  'AGENT_INFRA_TASK_ID', 'AGENT_INFRA_CONTROL_TOKEN', 'AGENT_INFRA_CONTROL_GENERATION',
  'AGENT_INFRA_CONTROL_ROOT_ID', 'AGENT_INFRA_CONTROL_DIR', 'AGENT_INFRA_CONTROL_STATUS_DIR',
  'AGENT_INFRA_RUNTIME_DIR', 'AGENT_INFRA_CONTROL_CONTROLLER_BINDING', 'AGENT_INFRA_EXECUTOR_MANIFEST', 'HOME', 'USERPROFILE'
] as const;

function withSandboxControlEnvironment<T>(overrides: Partial<Record<typeof SANDBOX_CONTROL_ENV_KEYS[number], string>>, callback: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of SANDBOX_CONTROL_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  if (overrides.AGENT_INFRA_CONTROL_STATUS_DIR && overrides.AGENT_INFRA_SANDBOX === undefined) {
    const statusDir = overrides.AGENT_INFRA_CONTROL_STATUS_DIR;
    const identity = JSON.parse(fs.readFileSync(path.join(statusDir, 'identity.json'), 'utf8')) as {
      mode: 'task-bound' | 'branch-only'; taskId: string | null; generation: string; controlRootId: string;
    };
    const root = path.dirname(statusDir);
    process.env.AGENT_INFRA_SANDBOX = '1';
    process.env.AGENT_INFRA_CONTROL_STATUS_DIR ??= statusDir;
    process.env.AGENT_INFRA_CONTROL_DIR ??= path.join(root, 'channel');
    process.env.AGENT_INFRA_CONTROL_GENERATION ??= identity.generation;
    process.env.AGENT_INFRA_CONTROL_ROOT_ID ??= identity.controlRootId;
    if (identity.mode === 'task-bound') {
      process.env.AGENT_INFRA_TASK_ID ??= identity.taskId ?? undefined;
      process.env.AGENT_INFRA_RUNTIME_DIR ??= path.join(root, 'runtime');
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { token?: unknown };
      if (typeof manifest.token === 'string') process.env.AGENT_INFRA_CONTROL_TOKEN ??= manifest.token;
    } catch { /* A focused test may use only the mounted identity files. */ }
  }
  try {
    return callback();
  } finally {
    for (const key of SANDBOX_CONTROL_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runTaskFinalizationClient(params: {
  channelDir: string;
  statusDir: string;
  token: string;
  generation: string;
  timeoutMs: number;
  recoveryBudgetMs?: number;
}): Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> {
  const identity = JSON.parse(fs.readFileSync(path.join(params.statusDir, 'identity.json'), 'utf8')) as {
    taskId: string | null; mode: 'task-bound' | 'branch-only';
  };
  const script = [
    "import { requestSandboxTaskFinalization } from './lib/sandbox/control/client.ts';",
    'try {',
    '  const response = requestSandboxTaskFinalization({',
    "    agent: 'codex',",
    '    channelDir: process.env.TEST_CHANNEL_DIR,',
    '    statusDir: process.env.TEST_STATUS_DIR,',
    '    token: process.env.TEST_TOKEN,',
    '    generation: process.env.TEST_GENERATION,',
    '    timeoutMs: Number(process.env.TEST_TIMEOUT_MS),',
    '    recoveryBudgetMs: Number(process.env.TEST_RECOVERY_BUDGET_MS),',
    '  });',
    "  process.stdout.write(JSON.stringify({ id: response.id, phase: response.phase, exitCode: response.exitCode, stdout: response.stdout, stderr: response.stderr, error: response.error }) + '\\n');",
    '} catch (error) {',
    '  const value = error;',
    "  process.stdout.write(JSON.stringify({ error: value.detail ?? { code: 'CLIENT_FAILED', message: String(value), retryable: false }, accepted: value.accepted ?? false, requestId: value.requestId ?? null }) + '\\n');",
    '  process.exitCode = 1;',
    '}'
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        AGENT_INFRA_SANDBOX: '1',
        AGENT_INFRA_TASK_ID: identity.taskId ?? undefined,
        AGENT_INFRA_CONTROL_TOKEN: params.token,
        AGENT_INFRA_CONTROL_GENERATION: params.generation,
        AGENT_INFRA_CONTROL_ROOT_ID: JSON.parse(fs.readFileSync(path.join(params.statusDir, 'identity.json'), 'utf8')).controlRootId,
        AGENT_INFRA_CONTROL_DIR: params.channelDir,
        AGENT_INFRA_CONTROL_STATUS_DIR: params.statusDir,
        AGENT_INFRA_RUNTIME_DIR: identity.mode === 'task-bound' ? path.join(path.dirname(params.statusDir), 'runtime') : undefined,
        TEST_CHANNEL_DIR: params.channelDir,
        TEST_STATUS_DIR: params.statusDir,
        TEST_TOKEN: params.token,
        TEST_GENERATION: params.generation,
        TEST_TIMEOUT_MS: String(params.timeoutMs),
        TEST_RECOVERY_BUDGET_MS: String(params.recoveryBudgetMs ?? params.timeoutMs),
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

function runRecoverSandboxControl(params: {
  channelDir: string;
  requestId: string;
  generation: string;
  timeoutMs: number;
  readyPath: string;
}): Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> {
  const script = [
    "import { recoverSandboxControlFromChannel, SandboxControlClientError } from './lib/sandbox/control/client.ts';",
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.TEST_READY_PATH, 'ready');",
    'try {',
    '  process.stdout.write(JSON.stringify(recoverSandboxControlFromChannel(process.env.TEST_REQUEST_ID, {',
    '    channelDir: process.env.TEST_CHANNEL_DIR, generation: process.env.TEST_GENERATION,',
    '    timeoutMs: Number(process.env.TEST_TIMEOUT_MS)',
    "  })) + '\\n');",
    '} catch (error) {',
    '  const value = error;',
    "  process.stdout.write(JSON.stringify({ error: value.detail ?? { code: 'CLIENT_FAILED', message: String(value), retryable: false }, accepted: value.accepted ?? false, requestId: value.requestId ?? null }) + '\\n');",
    '  process.exitCode = 1;',
    '}'
  ].join('\n');
  const child = collectChild(spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      AGENT_INFRA_CONTROL_DIR: undefined,
      TEST_CHANNEL_DIR: params.channelDir,
      TEST_REQUEST_ID: params.requestId,
      TEST_GENERATION: params.generation,
      TEST_TIMEOUT_MS: String(params.timeoutMs),
      TEST_READY_PATH: params.readyPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }));
  return child.result.then(({ exitCode, stdout, stderr }) => ({
    exitCode,
    payload: JSON.parse(stdout) as Record<string, unknown>,
    stderr
  }));
}

function runSandboxLocalTaskFinalization(root: string, manifest: ReturnType<typeof readSandboxControlManifest>, taskId: string) {
  return spawnSync(path.resolve('bin/internal-cli.sh'), [
    'task-finalization', taskId, 'complete', '--agent', 'codex'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_INFRA_TASK_ID: taskId,
      AGENT_INFRA_SANDBOX: '1',
      AGENT_INFRA_CONTROL_TOKEN: manifest.token,
      AGENT_INFRA_CONTROL_GENERATION: manifest.generation,
      AGENT_INFRA_CONTROL_ROOT_ID: manifest.controlRootId,
      AGENT_INFRA_CONTROL_DIR: manifest.channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: manifest.publicStatusDir,
      AGENT_INFRA_RUNTIME_DIR: manifest.runtimeDir,
      AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined,
      AGENT_INFRA_EXECUTOR_MANIFEST: undefined
    }
  });
}

function runSandboxLocalTaskFinalizationAsync(root: string, manifest: ReturnType<typeof readSandboxControlManifest>, taskId: string): CollectedChild {
  return collectChild(spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'),
    'task-finalization', taskId, 'complete', '--agent', 'codex'
  ], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_INFRA_TASK_ID: taskId,
      AGENT_INFRA_SANDBOX: '1',
      AGENT_INFRA_CONTROL_TOKEN: manifest.token,
      AGENT_INFRA_CONTROL_GENERATION: manifest.generation,
      AGENT_INFRA_CONTROL_ROOT_ID: manifest.controlRootId,
      AGENT_INFRA_CONTROL_DIR: manifest.channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: manifest.publicStatusDir,
      AGENT_INFRA_RUNTIME_DIR: manifest.runtimeDir,
      AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined,
      AGENT_INFRA_EXECUTOR_MANIFEST: undefined
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }));
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

function fixtureAuthorityEvidence() {
  return captureSandboxAuthority('native', {
    env: { DOCKER_CONTEXT: 'default' },
    lockDomain: 'a'.repeat(64),
    probe: (_cmd, args) => ({
      status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'fixture-daemon-id' : { ApiVersion: '1.50' }),
      stderr: '', pid: 1, output: []
    })
  });
}

function statusTaskView(taskId: string | null = 'TASK-20260809-010203') {
  return taskId
    ? { state: 'unknown', taskId, observedSource: 'unknown', receipt: null, reasonCode: 'SANDBOX_TASK_VIEW_EVIDENCE_UNAVAILABLE' }
    : { state: 'not-applicable', taskId: null, observedSource: null, receipt: null, reasonCode: null };
}

function writeControlManifest(root: string, branch: string, generation = 'lifecycle-generation'): string {
  const manifestPath = path.join(root, 'manifest.json');
  const channelDir = path.join(root, 'channel');
  const publicStatusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  for (const directory of [channelDir, publicStatusDir, processingDir]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'lifecycle-secret', generation,
    controlRootId: 'a'.repeat(96), channelDir, publicStatusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(publicStatusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation, controlRootId: 'a'.repeat(96)
  });
  return manifestPath;
}

function writeFinalizationTaskFixture(root: string, taskId: string): void {
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
}

async function prepareFinalizationTask(root: string, taskId: string): Promise<void> {
  const result = await prepareTaskFinalization({ taskRef: taskId, intent: 'complete', agent: 'codex' }, {
    repoRoot: root,
    backfill: async () => ({ ...platformResult('no-op'), artifacts: [], warnings: [] }),
    commentSync: async () => platformResult('no-op'),
    verify: async () => ({
      status: 'pass' as const, changed: false, event: 'complete-task.completed', requestRef: taskId,
      taskId, taskDir: path.join(root, '.agents', 'workspace', 'active', taskId), taskState: 'active' as const,
      skill: 'complete-task', mode: 'gate' as const, artifact: null, invocations: [], error: null
    })
  });
  assert.equal(result.status, 'prepared', result.error?.message);
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

test('host sandbox-control recovery resolves one accepted request from managed manifests and audit evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-host-recover-'));
  const managedRoot = path.join(root, 'demo');
  const controlRoot = path.join(managedRoot, 'demo-dev-feature', '0123456789abcdef');
  const requestId = '12121212-1212-4212-8212-121212121212';
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(controlRoot, branch, 'host-recovery-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    const payload = writeSandboxControlPayload(manifest, requestId, { stdout: 'recovered\n', stderr: '' });
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'completed', exitCode: 0, stdout: '', stderr: '', error: null,
      outputState: 'available', payload: {
        version: payload.version, id: payload.id, generation: payload.generation,
        stdoutBytes: payload.stdoutBytes, stderrBytes: payload.stderrBytes,
        stdoutSha256: payload.stdoutSha256, stderrSha256: payload.stderrSha256
      }
    })}\n`);
    appendCriticalAudit(manifest, createSandboxControlAuditContext(manifest, {
      requestId, family: 'task-lifecycle', phase: 'accepted-authorized', outcome: 'in-progress'
    }));
    appendDiagnosticAudit(manifest, 'executor-result-published', {
      requestId, requestGeneration: manifest.generation, exitCode: 0,
      outputBytes: payload.stdoutBytes, errorBytes: payload.stderrBytes,
      outputDigest: payload.stdoutSha256, errorDigest: payload.stderrSha256
    });

    assert.equal(recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 100 }).stdout, 'recovered\n');
    const unknownId = '13131313-1313-4313-8313-131313131313';
    assert.equal(
      recoverSandboxControlFromHost(unknownId, { managedRoot, timeoutMs: 30 }).error?.code,
      'SANDBOX_CONTROL_RESULT_UNKNOWN'
    );
    fs.renameSync(path.join(controlRoot, 'audit.ndjson'), path.join(controlRoot, 'audit.ndjson.1'));
    fs.writeFileSync(path.join(controlRoot, 'audit.ndjson'), '');
    assert.equal(recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 100 }).stdout, 'recovered\n');

    appendDiagnosticAudit(manifest, 'executor-result-published', {
      requestId, requestGeneration: manifest.generation, exitCode: 0,
      outputBytes: payload.stdoutBytes, errorBytes: payload.stderrBytes,
      outputDigest: payload.stdoutSha256, errorDigest: payload.stderrSha256
    });
    assert.equal(recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 100 }).stdout, 'recovered\n');
    appendDiagnosticAudit(manifest, 'executor-result-published', {
      requestId, requestGeneration: manifest.generation, exitCode: 7,
      outputBytes: Buffer.byteLength('conflict\n'), errorBytes: 0,
      outputDigest: createHash('sha256').update('conflict\n').digest('hex'),
      errorDigest: createHash('sha256').update('').digest('hex')
    });
    assert.throws(
      () => recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 100 }),
      /SANDBOX_CONTROL_RESULT_EVIDENCE_CONFLICT/u
    );
    const validAudit = fs.readFileSync(path.join(controlRoot, 'audit.ndjson.1'), 'utf8');
    const currentAudit = fs.readFileSync(path.join(controlRoot, 'audit.ndjson'), 'utf8');
    fs.writeFileSync(path.join(controlRoot, 'audit.ndjson.1'), currentAudit);
    fs.writeFileSync(path.join(controlRoot, 'audit.ndjson'), validAudit);
    assert.throws(
      () => recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 100 }),
      /SANDBOX_CONTROL_RESULT_EVIDENCE_CONFLICT/u
    );

    fs.appendFileSync(path.join(controlRoot, 'audit.ndjson'), `${JSON.stringify({
      version: 2, event: 'accepted-authorized', phase: 'accepted-authorized', requestId,
      generation: 'stale-generation', identityDigest: 'f'.repeat(64)
    })}\n`);
    assert.throws(
      () => recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 100 }),
      /SANDBOX_CONTROL_AUDIT_IDENTITY_MISMATCH/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host sandbox-control recovery waits for an accepted response to become terminal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-host-recover-pending-'));
  const managedRoot = path.join(root, 'demo');
  const controlRoot = path.join(managedRoot, 'demo-dev-feature', '0123456789abcdef');
  const requestId = '15151515-1515-4515-8515-151515151515';
  let publisher: ReturnType<typeof spawn> | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(controlRoot, branch, 'host-recovery-pending-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    const payload = writeSandboxControlPayload(manifest, requestId, { stdout: 'recovered after wait\n', stderr: '' });
    const responsePath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    const terminalResponse = {
      version: 2, id: requestId, phase: 'completed', exitCode: 0, stdout: '', stderr: '', error: null,
      outputState: 'available', payload: {
        version: payload.version, id: payload.id, generation: payload.generation,
        stdoutBytes: payload.stdoutBytes, stderrBytes: payload.stderrBytes,
        stdoutSha256: payload.stdoutSha256, stderrSha256: payload.stderrSha256
      }
    };
    fs.writeFileSync(responsePath, `${JSON.stringify({ version: 2, id: requestId, phase: 'accepted' })}\n`);
    appendCriticalAudit(manifest, createSandboxControlAuditContext(manifest, {
      requestId, family: 'task-lifecycle', phase: 'accepted-authorized', outcome: 'in-progress'
    }));
    appendDiagnosticAudit(manifest, 'executor-result-published', {
      requestId, requestGeneration: manifest.generation, exitCode: 0,
      outputBytes: payload.stdoutBytes, errorBytes: payload.stderrBytes,
      outputDigest: payload.stdoutSha256, errorDigest: payload.stderrSha256
    });
    publisher = spawn(process.execPath, ['-e',
      'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], process.argv[2]), 75)',
      responsePath, JSON.stringify(terminalResponse)
    ], { stdio: 'ignore' });

    assert.equal(recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 1_000 }).stdout, 'recovered after wait\n');
    fs.rmSync(responsePath);
    assert.equal(
      recoverSandboxControlFromHost(requestId, { managedRoot, timeoutMs: 30 }).error?.code,
      'SANDBOX_CONTROL_RESULT_UNKNOWN'
    );
  } finally {
    publisher?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host sandbox-control recover prints a request-scoped unknown error in the CLI', {
  ...onPlatforms('linux', 'darwin'),
  skip: fs.existsSync(SANDBOX_CONTROL_STATUS_MOUNT)
    ? 'requires a host without the sandbox status mount'
    : onPlatforms('linux', 'darwin').skip
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-host-recover-unknown-cli-'));
  const requestId = '14141414-1414-4414-8414-141414141414';
  try {
    const branch = initializeRepository(root);
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
      project: 'demo',
      agentClients: ['claude-code', 'codex', 'antigravity-cli', 'opencode', 'traecli'].map((id) => ({
        id, enabled: false, installInSandbox: false
      }))
    }));
    const managedControlRoot = path.join(
      root, '.agent-infra', 'sandbox-control', 'demo', 'demo-dev-feature', '0123456789abcdef'
    );
    const manifestPath = writeControlManifest(managedControlRoot, branch, 'host-recovery-unknown-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    fs.mkdirSync(path.join(manifest.channelDir, 'responses'), { recursive: true });
    appendCriticalAudit(manifest, createSandboxControlAuditContext(manifest, {
      requestId, family: 'task-lifecycle', phase: 'accepted-authorized', outcome: 'in-progress'
    }));
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'rejected', exitCode: null, stdout: '', stderr: '',
      error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'unknown', retryable: false },
      outputState: 'unavailable', payload: null
    })}\n`);

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_INFRA_')));
    const recovered = spawnSync(process.execPath, [
      '--experimental-strip-types', '--no-warnings',
      path.resolve('bin/internal-cli.ts'),
      'sandbox-control', 'recover', requestId
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...env, HOME: root, USERPROFILE: root }
    });
    assert.equal(recovered.status, 1, recovered.stderr || recovered.stdout);
    assert.equal(recovered.stdout, '');
    assert.match(recovered.stderr, /SANDBOX_CONTROL_RESULT_UNKNOWN/u);
    assert.match(recovered.stderr, new RegExp(`SANDBOX_CONTROL_REQUEST_ID: ${requestId}`));
    assert.equal(fs.existsSync(path.join(manifest.channelDir, 'requests', `${requestId}.json`)), false);
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

test('sandbox control removal gives container operations a bounded pre-force budget', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-deadline-'));
  let callbackTimeout = 0;
  const inspectionTimeouts: number[] = [];
  let manifestPath: string | undefined;
  try {
    manifestPath = writeControlManifest(root, initializeRepository(root), 'remove-deadline-generation');
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    await assert.rejects(
      () => removeSandboxControlRoot(root, {
        timeoutMs: 200,
        inspectContainer: async (timeoutMs) => {
          inspectionTimeouts.push(timeoutMs);
          return { state: 'found', id: 'container-id', running: false, labels: {} };
        },
        removeContainer: async (timeoutMs) => {
          callbackTimeout = timeoutMs;
          t.mock.timers.tick(150);
        }
      }),
      /SANDBOX_CONTROL_CONTAINER_STILL_EXISTS/
    );
    assert.equal(callbackTimeout, 200);
    assert.deepEqual(inspectionTimeouts, [200, 50]);
    assert.equal(fs.existsSync(root), true);
  } finally {
    if (manifestPath && fs.existsSync(root)) clearSandboxRemovalJournal(readSandboxControlManifest(manifestPath));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control removal records pending evidence when the exact removal outlives the deadline', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-pending-'));
  let manifestPath: string | undefined;
  try {
    manifestPath = writeControlManifest(root, initializeRepository(root), 'remove-pending-generation');
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });
    const rejected = assert.rejects(
      () => removeSandboxControlRoot(root, {
        timeoutMs: 30,
        inspectContainer: async () => ({ state: 'found', id: 'container-id', running: false, labels: {} }),
        removeContainer: () => {
          removalStarted();
          return new Promise<void>(() => {});
        }
      }),
      /SANDBOX_CONTROL_REMOVE_PENDING/
    );
    await started;
    t.mock.timers.tick(30);
    await rejected;
    const pending = JSON.parse(fs.readFileSync(path.join(root, 'removal-pending.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(pending.phase, 'container-removal');
    assert.equal(fs.existsSync(root), true);
  } finally {
    if (manifestPath && fs.existsSync(root)) clearSandboxRemovalJournal(readSandboxControlManifest(manifestPath));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control removal resumes from carrier-finalizing without replaying container actions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-carrier-retry-'));
  let manifestPath: string | undefined;
  let manifest: ReturnType<typeof readSandboxControlManifest> | undefined;
  const originalRmSync = fs.rmSync;
  let injectFailure = true;
  try {
    const branch = initializeRepository(root);
    manifestPath = writeControlManifest(root, branch, `carrier-retry-generation-${process.pid}-${Date.now()}`);
    manifest = readSandboxControlManifest(manifestPath);
    fs.rmSync = ((target, options) => {
      if (injectFailure && path.resolve(String(target)) === path.resolve(root)) {
        injectFailure = false;
        throw new Error('INJECTED_CRASH_BEFORE_CARRIER_DELETE');
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;

    await assert.rejects(
      () => removeSandboxControlRoot(root, {
        timeoutMs: 200,
        inspectContainer: async () => ({ state: 'absent', id: 'container-id' }),
        retainRemovalJournal: true,
        removeContainer: async () => { throw new Error('unexpected container removal'); }
      }),
      /INJECTED_CRASH_BEFORE_CARRIER_DELETE/
    );
    assert.equal(readSandboxRemovalJournal(manifest)?.phase, 'carrier-finalizing');
  } finally {
    fs.rmSync = originalRmSync;
  }

  try {
    await removeSandboxControlRoot(root, {
      timeoutMs: 200,
      identityProbe: () => 'dead',
      inspectContainer: async () => { throw new Error('container observation must not replay'); },
      retainRemovalJournal: true,
      removeContainer: async () => { throw new Error('container removal must not replay'); }
    });
    assert.equal(fs.existsSync(root), false);
    const recovered = manifest ? readSandboxRemovalJournal(manifest) : null;
    assert.equal(recovered?.phase, 'carrier-removed');
    if (recovered) clearSandboxRemovalJournalRecord(recovered);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox removal journal enforces live-owner refusal, dead-owner takeover, and revision CAS', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-removal-journal-'));
  let manifest: ReturnType<typeof readSandboxControlManifest> | undefined;
  t.after(() => {
    if (manifest) clearSandboxRemovalJournal(manifest);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const branch = initializeRepository(root);
  const generation = `removal-journal-generation-${process.pid}-${Date.now()}`;
  const manifestPath = writeControlManifest(root, branch, generation);
  manifest = readSandboxControlManifest(manifestPath);
  await removeSandboxControlRoot(root, {
    timeoutMs: 5_000,
    inspectContainer: async () => ({ state: 'absent', id: 'container-id' }),
    retainRemovalJournal: true,
    removeContainer: async () => { throw new Error('unexpected container removal'); }
  });

  const prepared = readSandboxRemovalJournal(manifest);
  assert.ok(prepared);
  assert.equal(prepared.version, 2);
  assert.equal(prepared.phase, 'carrier-removed');
  assert.equal(prepared.revision, 5);
  assert.equal(prepared.expectedOldJournalRevision, 4);
  assert.equal(prepared.target.controlRoot, root);
  assert.equal(prepared.target.removeBranch, false);
  assert.equal(prepared.target.removeShare, false);
  assert.throws(
    () => claimSandboxRemovalJournal(prepared),
    /SANDBOX_CONTROL_REMOVE_RETRY_IN_PROGRESS/
  );

  const claimed = claimSandboxRemovalJournal(prepared, { identityProbe: () => 'dead' });
  assert.equal(claimed.revision, prepared.revision + 1);
  assert.equal(claimed.expectedOldJournalRevision, prepared.revision);
  const advanced = advanceSandboxRemovalJournalPhase(claimed, 'carrier-removed');
  assert.equal(advanced.revision, claimed.revision);
  assert.throws(
    () => advanceSandboxRemovalJournalPhase(claimed, 'prepared'),
    /SANDBOX_CONTROL_REMOVAL_PHASE_TRANSITION_INVALID/
  );
  assert.throws(
    () => advanceSandboxRemovalJournalPhase(prepared, 'carrier-removed'),
    /SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH/
  );
  clearSandboxRemovalJournalRecord(advanced);
  assert.equal(readSandboxRemovalJournal(manifest), null);
});
test('sandbox control removal retries a transient unknown owner through its journal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-remove-owner-retry-'));
  let probes = 0;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'remove-owner-retry-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    fs.writeFileSync(path.join(root, 'public', 'status.json'), `${JSON.stringify({
      version: 3,
      generation: manifest.generation,
      broker: {
        version: 3,
        pid: 999_999,
        startTime: 1,
        brokerId: 'stale-broker',
        token: manifest.token,
        generation: manifest.generation
      },
      state: 'parked',
      reasonCode: 'SANDBOX_WORKTREE_BINDING_LOST',
      activeRequestId: null,
      updatedAt: Date.now(),
      taskView: statusTaskView(null)
    })}
`);

    await removeSandboxControlRoot(root, {
      timeoutMs: 200,
      identityProbe: () => {
        probes += 1;
        return probes === 1 ? 'unknown' : 'dead';
      },
      inspectContainer: async () => ({ state: 'absent', id: 'container-id' }),
      removeContainer: async () => { throw new Error('unexpected container removal'); }
    });

    assert.equal(probes >= 2, true);
    assert.equal(fs.existsSync(root), false);
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

for (const removalFails of [false, true]) {
  test(`sandbox control removal ${removalFails ? 'cleans up stubborn children after failure' : 'completes all stages for stubborn broker and execution'}`, onPlatforms('linux', 'darwin'), async () => {
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
        version: 3, generation: 'remove-stages-generation',
        broker: { pid: brokerProcess.pid, startTime: brokerStartTime, brokerId: 'stubborn-broker' },
        state: 'busy', reasonCode: null, activeRequestId: 'stubborn-request', updatedAt: Date.now(), taskView: statusTaskView()
      })}\n`);
      const executionDir = path.join(root, 'processing', 'stubborn-request');
      fs.mkdirSync(executionDir);
      fs.writeFileSync(path.join(executionDir, 'execution.json'), `${JSON.stringify({
        version: 2, generation: 'remove-stages-generation', requestId: 'stubborn-request', nonce: 'stubborn-nonce',
        child: { pid: executionProcess.pid, startTime: executionStartTime, processGroupId: executionProcess.pid },
        phase: 'running', updatedAt: Date.now()
      })}\n`);

      const removal = removeSandboxControlRoot(root, {
        timeoutMs: 1_000,
        inspectContainer: async () => {
          inspectCalls += 1;
          return inspectCalls === 1
            ? { state: 'found', id: 'container-id', running: true, labels: {} }
            : { state: 'absent', id: 'container-id' };
        },
        removeContainer: async () => {
          if (removalFails) throw new Error('injected removal failure');
          stages.push('container-remove');
          assert.equal(isProcessAlive(brokerProcess.pid!), true);
          assert.equal(isProcessAlive(executionProcess.pid!), true);
        }
      });

      if (removalFails) {
        await assert.rejects(removal, /injected removal failure/);
        return;
      }
      await removal;

      assert.deepEqual(stages, ['container-remove']);
      assert.equal(inspectCalls, 2);
      assert.equal(isProcessAlive(brokerProcess.pid!), false);
      assert.equal(isProcessAlive(executionProcess.pid!), false);
      assert.equal(fs.existsSync(root), false);
    } finally {
      if (executionProcess.pid && isProcessAlive(executionProcess.pid)) {
        try { process.kill(-executionProcess.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
      if (brokerProcess.pid) await stopBroker(brokerProcess.pid);
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(isProcessAlive(brokerProcess.pid!), false);
    }
  });
}

test('sandbox control lifecycle terminates a live execution before accepting a stale broker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-stale-execution-'));
  try {
    const manifestPath = writeControlManifest(root, 'main', 'stale-execution-generation');
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
      version: 3, pid: 999_999_999, startTime: 0, brokerId: 'stale-broker',
      token: 'lifecycle-secret', generation: 'stale-execution-generation'
    })}\n`);
    const executionDir = path.join(root, 'processing', 'stale-execution-request');
    fs.mkdirSync(executionDir);
    fs.writeFileSync(path.join(executionDir, 'execution.json'), `${JSON.stringify({
      version: 2, generation: 'stale-execution-generation', requestId: 'stale-execution-request',
      nonce: 'stale-execution-nonce',
      child: { pid: 42, startTime: 1, processGroupId: 42 },
      phase: 'running', updatedAt: Date.now()
    })}\n`);

    let executionAlive = true;
    const events: string[] = [];
    const result = await quiesceSandboxControlRoot(root, {
      identityProbe: () => 'dead',
      executionProcessControl: {
        isAlive: () => {
          events.push('probe');
          assert.equal(executionAlive, false, 'the execution must be terminated before liveness is rechecked');
          return executionAlive;
        },
        terminate: (_execution, phase) => {
          if (executionAlive) {
            events.push(`terminate:${phase}`);
            executionAlive = false;
          }
          return !executionAlive;
        }
      }
    });

    assert.equal(result, 'stale');
    assert.equal(executionAlive, false);
    assert.equal(events[0], 'terminate:graceful');
    assert.equal(events.includes('probe'), true);
    assert.equal(fs.existsSync(manifestPath), true);
  } finally {
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
      version: 3, generation: 'recovery-quiesce-generation',
      broker: { pid: 999_999_999, startTime: 0, brokerId: 'stale-broker' }, state: 'healthy',
      reasonCode: null, activeRequestId: null, updatedAt: Date.now(), taskView: statusTaskView()
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
      version: 3, generation: 'forced-generation', broker: { pid: broker.pid, startTime: brokerStartTime, brokerId: 'test-broker' },
      state: 'healthy', reasonCode: null, activeRequestId: 'forced-request', updatedAt: Date.now(), taskView: statusTaskView()
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
  let serving: Promise<void> | undefined;
  let heartbeatQueries = 0;
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'heartbeat-absent-generation');
    serving = serveSandboxControl(manifestPath, controller.signal, {
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
    assert.equal(fs.existsSync(root), false);
    await serving;
    assert.equal(heartbeatQueries >= 2, true);
  } finally {
    controller.abort();
    await serving;
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
    containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'readiness-secret', generation: 'readiness-generation',
    controlRootId: 'a'.repeat(96),
    channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation: 'readiness-generation', controlRootId: 'a'.repeat(96)
  });
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
    containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'owner-secret', generation: 'owner-generation',
    controlRootId: 'a'.repeat(96),
    channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation: 'owner-generation', controlRootId: 'a'.repeat(96)
  });
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
      containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
      mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'rotated-owner-secret', generation: 'rotated-generation',
      controlRootId: 'b'.repeat(96),
      channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
    })}\n`);
    writeSandboxControlIdentitySentinel(statusDir, {
      version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation: 'rotated-generation', controlRootId: 'b'.repeat(96)
    });
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
    const auditAfterReplacement = fs.readFileSync(path.join(root, 'audit.ndjson'), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_SANDBOX_CONTROL_TIMING.controlTickMs * 2));
    const statusAfterHeartbeat = JSON.parse(fs.readFileSync(path.join(statusDir, 'status.json'), 'utf8'));
    assert.equal(statusAfterHeartbeat.generation, 'rotated-generation');
    assert.equal(statusAfterHeartbeat.broker.pid, rotated.pid);
    assert.equal(statusAfterHeartbeat.broker.startTime, rotated.startTime);
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
    version: 3,
    generation: 'response-generation',
    broker: { pid: process.pid, startTime: responseBrokerStartTime, brokerId: 'test-broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now(), taskView: statusTaskView(null)
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'branch-only', taskId: null, generation: 'response-generation', controlRootId: 'a'.repeat(96)
  });
  const clientModule = path.resolve('lib/sandbox/control/client.ts');
  const runClient = (): CollectedChild => {
    const script = `
      import { requestSandboxControl } from ${JSON.stringify(clientModule)};
      try {
        const response = requestSandboxControl({
          family: 'task-lifecycle', args: ['01', 'complete'],
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
      env: {
        ...process.env,
        AGENT_INFRA_TASK_ID: undefined,
        AGENT_INFRA_CONTROL_TOKEN: undefined,
        AGENT_INFRA_CONTROL_GENERATION: undefined,
        AGENT_INFRA_CONTROL_ROOT_ID: undefined,
        AGENT_INFRA_CONTROL_DIR: undefined,
        AGENT_INFRA_CONTROL_STATUS_DIR: undefined,
        AGENT_INFRA_RUNTIME_DIR: undefined
      },
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
    assert.deepEqual(recoverSandboxControlFromChannel(requestId, { channelDir: root, generation: 'test-generation', timeoutMs: 100 }), response);
    assert.equal(fs.existsSync(path.join(responsesDir, `${requestId}.json`)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control recovery waits for a published unknown response to become terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recover-unknown-'));
  const responsesDir = path.join(root, 'responses');
  const readyPath = path.join(root, 'recover-ready');
  const requestId = '44444444-4444-4444-8444-444444444444';
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.writeFileSync(responsePath, `${JSON.stringify({
    version: 2, id: requestId, phase: 'rejected', exitCode: null,
    stdout: '', stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  })}\n`);
  const terminalResponse = {
    version: 2, id: requestId, phase: 'completed', exitCode: 0,
    stdout: 'finalization completed\n', stderr: '', error: null
  };
  const recovery = runRecoverSandboxControl({ channelDir: root, requestId, generation: 'test-generation', timeoutMs: 500, readyPath });
  waitForFile(readyPath, 2_000);
  const publishTerminal = new Promise<void>((resolve) => setTimeout(() => {
    fs.writeFileSync(responsePath, `${JSON.stringify(terminalResponse)}\n`);
    resolve();
  }, 75));
  try {
    const result = await recovery;
    await publishTerminal;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.payload, terminalResponse);
  } finally {
    await publishTerminal;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control recovery times out on a stable published unknown with identity intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recover-stable-unknown-'));
  const responsesDir = path.join(root, 'responses');
  const readyPath = path.join(root, 'recover-ready');
  const requestId = '66666666-6666-4666-8666-666666666666';
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.writeFileSync(path.join(responsesDir, `${requestId}.json`), `${JSON.stringify({
    version: 2, id: requestId, phase: 'rejected', exitCode: null,
    stdout: '', stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  })}\n`);
  try {
    const result = await runRecoverSandboxControl({ channelDir: root, requestId, generation: 'test-generation', timeoutMs: 100, readyPath });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.payload, {
      error: {
        code: 'SANDBOX_CONTROL_RESULT_UNKNOWN',
        message: 'SANDBOX_CONTROL_RESULT_UNKNOWN: request did not produce a final result; inspect domain state before retrying',
        retryable: false
      },
      accepted: true,
      requestId
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control recovery polls a published unknown at the bounded cadence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recover-cadence-'));
  const responsesDir = path.join(root, 'responses');
  const requestId = '77777777-7777-4777-8777-777777777777';
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.writeFileSync(responsePath, `${JSON.stringify({
    version: 2, id: requestId, phase: 'rejected', exitCode: null,
    stdout: '', stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  })}\n`);

  let now = 1_000;
  let responseReads = 0;
  const waits: number[] = [];
  const readFile = fs.readFileSync;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Atomics, 'wait', (_array: Int32Array, _index: number, _value: number, timeout: number) => {
    waits.push(timeout);
    now += timeout;
    return 'timed-out';
  });
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === responsePath) responseReads += 1;
    return readFile(...args);
  });

  try {
    assert.throws(
      () => recoverSandboxControlFromChannel(requestId, { channelDir: root, generation: 'test-generation', timeoutMs: 100 }),
      (error: unknown) => error instanceof SandboxControlClientError
        && error.detail.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN'
        && error.accepted
        && error.requestId === requestId
    );
    assert.deepEqual(waits, [25, 25, 25, 25]);
    assert.equal(responseReads, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepted finalization recovery bounds each call by the original total deadline', (t) => {
  const requestId = '88888888-8888-4888-8888-888888888888';
  let now = 1_000;
  const timeoutCalls: number[] = [];
  t.mock.method(Date, 'now', () => now);
  const recover: typeof recoverSandboxControl = (id, params) => {
    assert.equal(id, requestId);
    const timeoutMs = params?.timeoutMs ?? 0;
    timeoutCalls.push(timeoutMs);
    now += timeoutMs;
    throw new SandboxControlClientError({
      code: 'SANDBOX_CONTROL_RESULT_UNKNOWN',
      message: 'result unknown',
      retryable: false
    }, true, requestId);
  };

  assert.throws(
    () => recoverAcceptedTaskFinalization(requestId, { recoveryBudgetMs: 75_000 }, recover),
    (error: unknown) => error instanceof SandboxControlClientError
      && error.detail.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN'
      && error.accepted
      && error.requestId === requestId
  );
  assert.deepEqual(timeoutCalls, [30_000, 30_000, 15_000]);
  assert.equal(now, 76_000);
});

test('task-finalization client recovers a published accepted unknown without submitting another request', async () => {
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
    version: 3,
    generation,
    broker: { pid: process.pid, startTime, brokerId: 'finalization-broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now(), taskView: statusTaskView()
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation, controlRootId: 'a'.repeat(96)
  });
  const client = collectChild(spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'),
    'sandbox-control', 'client', 'task-finalization', 'TASK-20260809-010203', 'complete', '--agent', 'codex'
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      AGENT_INFRA_SANDBOX: '1',
      AGENT_INFRA_CONTROL_TOKEN: 'finalization-secret',
      AGENT_INFRA_CONTROL_GENERATION: generation,
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
      AGENT_INFRA_CONTROL_DIR: channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
      AGENT_INFRA_TASK_ID: 'TASK-20260809-010203',
      AGENT_INFRA_RUNTIME_DIR: path.join(root, 'runtime')
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
    const recoveredFinalization = {
      version: 2,
      status: 'completed',
      changed: true,
      accepted: true,
      requestId: requestName.slice(0, -5),
      result: { status: 'completed' },
      error: null
    };
    const publishTerminal = new Promise<void>((resolve) => setTimeout(() => {
      fs.writeFileSync(path.join(responsesDir, requestName), `${JSON.stringify({
        version: 2,
        id: requestName.slice(0, -5),
        phase: 'completed',
        exitCode: 0,
        stdout: `${JSON.stringify(recoveredFinalization)}\n`,
        stderr: '',
        error: null
      })}\n`);
      resolve();
    }, 75));
    const result = await client.result;
    await publishTerminal;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), recoveredFinalization);
    assert.equal(fs.readdirSync(requestsDir).filter((name) => name.endsWith('.json')).length, 1);
  } finally {
    await stopCollectedChild(client);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization unknown envelope preserves uncertainty and request identity', () => {
  assert.deepEqual(JSON.parse(serializeTaskFinalizationEnvelope({
    status: 'unknown',
    changed: null,
    accepted: true,
    requestId: '55555555-5555-4555-8555-555555555555',
    result: null,
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  })), {
    version: 2,
    status: 'unknown',
    changed: null,
    accepted: true,
    requestId: '55555555-5555-4555-8555-555555555555',
    result: null,
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
  });
});

test('task-finalization recovery budget expires with the accepted request identity intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-recovery-budget-'));
  const channelDir = path.join(root, 'channel');
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const statusDir = path.join(root, 'public');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir);
  fs.mkdirSync(statusDir);
  const startTime = getProcessStartTime(process.pid);
  assert.ok(startTime);
  const generation = 'finalization-recovery-budget-generation';
  fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
    version: 3, generation,
    broker: { pid: process.pid, startTime, brokerId: 'finalization-broker' },
    state: 'healthy', reasonCode: null, activeRequestId: null, updatedAt: Date.now(), taskView: statusTaskView()
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation, controlRootId: 'a'.repeat(96)
  });
  try {
    const client = runTaskFinalizationClient({
      channelDir, statusDir, token: 'finalization-secret', generation,
      timeoutMs: 100, recoveryBudgetMs: 100
    });
    const requestName = await waitForRequestAsync(requestsDir, 2_000);
    const requestId = requestName.slice(0, -5);
    fs.writeFileSync(path.join(responsesDir, `${requestId}.accepted.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);
    const result = await client;
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.payload, {
      error: {
        code: 'SANDBOX_CONTROL_RESULT_UNKNOWN',
        message: 'SANDBOX_CONTROL_RESULT_UNKNOWN: accepted finalization request remained unknown after the automatic recovery budget; inspect the receipt and resume by request id',
        retryable: false
      },
      accepted: true,
      requestId
    });
    assert.equal(fs.readdirSync(requestsDir).filter((name) => name.endsWith('.json')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-bound finalization recovers the original request after accepted response loss', async () => {
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
    await prepareFinalizationTask(root, taskId);

    const statusDir = path.join(root, 'public');
    const channelDir = path.join(root, 'channel');
    const requestsDir = path.join(channelDir, 'requests');
    const responsesDir = path.join(channelDir, 'responses');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(responsesDir, { recursive: true });
    const startTime = getProcessStartTime(process.pid);
    assert.ok(startTime);
    fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
      version: 3,
      generation,
      broker: { pid: process.pid, startTime, brokerId: 'finalization-compensation-broker' },
      state: 'healthy',
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now(),
      taskView: {
        state: 'current', taskId, observedSource: 'active', receipt: null, reasonCode: null
      }
    })}\n`);
    writeSandboxControlIdentitySentinel(statusDir, {
      version: 1, mode: 'task-bound', taskId, generation, controlRootId: 'a'.repeat(96)
    });
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

    let submissionCount = 0;
    const serveFinalization = async () => {
      const requestName = await waitForRequestAsync(requestsDir, SANDBOX_CONTROL_TEST_TIMEOUT_MS);
      submissionCount += 1;
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
      fs.writeFileSync(path.join(responsesDir, requestName), `${JSON.stringify({
        version: 2, id: request.id, phase: 'rejected', exitCode: null,
        stdout: '', stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN\n',
        error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'result unknown', retryable: false }
      })}\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      fs.writeFileSync(path.join(responsesDir, requestName), `${JSON.stringify({
        version: 2, id: request.id, phase: 'completed', exitCode: executionResult.exitCode,
        stdout: executionResult.stdout, stderr: executionResult.stderr, error: null
      })}\n`);
      fs.rmSync(path.join(root, 'processing', request.id), { recursive: true, force: true });
      fs.rmSync(requestPath, { force: true });
      return executionResult;
    };

    const broker = serveFinalization();
    const client = await runTaskFinalizationClient({ channelDir, statusDir, token, generation, timeoutMs: 500 });
    const execution = await broker;
    assert.equal(client.exitCode, 0, client.stderr);
    assert.equal(client.payload.phase, 'completed');
    assert.ok(execution.stdout, execution.stderr);
    assert.equal(JSON.parse(execution.stdout).status, 'completed', execution.stdout);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'completed', taskId, 'task.md')), true);
    assert.equal(submissionCount, 1);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker recovery cleans up a normally published large-output terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-large-terminal-recovery-'));
  const requestId = '99999999-9999-4999-8999-999999999999';
  const output = 'x'.repeat(2 * 1024 * 1024);
  const childStderr = 'child warning\n';
  let controller = new AbortController();
  let server: Promise<void> | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch);
    const manifest = readSandboxControlManifest(manifestPath);
    const executorPath = path.join(root, 'output.cjs');
    fs.writeFileSync(executorPath, [
      "process.once('message', () => {",
      '  process.disconnect();',
      `  process.stdout.write('x'.repeat(${output.length}));`,
      `  process.stderr.write(${JSON.stringify(childStderr)});`,
      '});'
    ].join('\n'));
    const options = {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1_000 },
      inspectContainer: async () => ({ state: 'found' as const, id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: executorPath
    };
    server = serveSandboxControl(manifestPath, controller.signal, options);
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    const issuedAt = Date.now();
    atomicWriteJson(path.join(manifest.channelDir, 'requests', `${requestId}.json`), {
      version: 4, id: requestId, token: manifest.token, generation: manifest.generation,
      issuedAt, expiresAt: issuedAt + 2_000, family: 'task-lifecycle', args: ['08', 'complete', '--agent', 'codex'],
      controllerProcess: null, controllerProof: null
    });
    await waitForResultEvidenceAsync(manifest.processingDir, SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    const processingDir = path.join(manifest.processingDir, requestId);
    const evidence = fs.readdirSync(processingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, contents: fs.readFileSync(path.join(processingDir, entry.name)) }));
    const acceptedPath = path.join(manifest.channelDir, 'responses', `${requestId}.accepted.json`);
    const accepted = fs.readFileSync(acceptedPath);
    const terminalPath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    const deadline = Date.now() + SANDBOX_CONTROL_TEST_TIMEOUT_MS;
    while (!fs.existsSync(terminalPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const terminal = fs.readFileSync(terminalPath, 'utf8');
    if (!evidence.some((entry) => entry.name === 'terminal-result.json')) {
      evidence.push({
        name: 'terminal-result.json',
        contents: Buffer.from(`${JSON.stringify(createSandboxControlTerminalResult(manifest, {
          id: requestId,
          family: 'task-lifecycle',
          operation: 'complete'
        }, output))}\n`)
      });
    }
    controller.abort();
    await server;
    assert.equal(JSON.parse(terminal).outputState, 'available');
    assert.equal(JSON.parse(terminal).stderr, '');
    const response = recoverSandboxControlFromChannel(requestId, { channelDir: manifest.channelDir, generation: manifest.generation, timeoutMs: 100 });
    assert.equal(response.stdout, output);
    assert.equal(response.stderr, childStderr);
    assert.throws(
      () => recoverSandboxControlFromChannel(requestId, {
        channelDir: manifest.channelDir, generation: 'stale-generation', timeoutMs: 100
      }),
      (error: unknown) => error instanceof SandboxControlClientError
        && error.detail.code === 'SANDBOX_CONTROL_RESPONSE_INVALID'
    );

    // Restore the durable state from the terminal-published, pre-cleanup boundary.
    fs.mkdirSync(processingDir, { recursive: true });
    for (const entry of evidence) fs.writeFileSync(path.join(processingDir, entry.name), entry.contents);
    fs.writeFileSync(acceptedPath, accepted);
    const previousBrokerId = JSON.parse(
      fs.readFileSync(path.join(manifest.publicStatusDir, 'status.json'), 'utf8')
    ).broker.brokerId as string;
    controller = new AbortController();
    server = serveSandboxControl(manifestPath, controller.signal, {
      ...options,
      prepareExecution: async () => { throw new Error('Unexpected executor replay'); }
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS, previousBrokerId);
    assert.equal(fs.existsSync(processingDir), false);
    assert.equal(fs.existsSync(acceptedPath), false);
    assert.equal(fs.readFileSync(terminalPath, 'utf8'), terminal);
    assert.equal(recoverSandboxControlFromChannel(requestId, { channelDir: manifest.channelDir, generation: manifest.generation, timeoutMs: 100 }).stdout, output);
  } finally {
    controller.abort();
    await server?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization normal publication fails closed on a conflicting terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-terminal-conflict-'));
  const taskId = 'TASK-20260809-010203';
  const generation = 'finalization-terminal-conflict-generation';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  let clientResult: Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    writeFinalizationTaskFixture(root, taskId);
    await prepareFinalizationTask(root, taskId);
    const manifest = readSandboxControlManifest(manifestPath);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1_000 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts')
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    clientResult = runTaskFinalizationClient({
      channelDir: manifest.channelDir,
      statusDir: manifest.publicStatusDir,
      token: manifest.token,
      generation,
      timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS,
    });
    const evidence = await waitForResultEvidenceAsync(manifest.processingDir, SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${evidence.requestId}.json`), `${JSON.stringify({
      version: 2, id: evidence.requestId, phase: 'completed', exitCode: 0,
      stdout: 'forged terminal\n', stderr: '', error: null
    })}\n`);
    await assert.rejects(server, /SANDBOX_CONTROL_TERMINAL_CONFLICT/);
    const client = await clientResult;
    assert.equal(client.exitCode, 0);
    assert.equal(client.payload.stdout, 'forged terminal\n');
    assert.equal(fs.existsSync(path.join(manifest.processingDir, evidence.requestId)), true);
  } finally {
    controller.abort();
    await server?.catch(() => undefined);
    await clientResult?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox-local task-finalization has no receipt or request side effects when broker state is unknown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-unknown-no-side-effects-'));
  const taskId = 'TASK-20260809-010203';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'finalization-unknown-generation');
    writeFinalizationTaskFixture(root, taskId);
    const manifest = readSandboxControlManifest(manifestPath);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts')
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    controller.abort();
    await server;
    server = undefined;

    const local = runSandboxLocalTaskFinalization(root, manifest, taskId);
    assert.notEqual(local.status, 0, local.stdout);
    assert.match(`${local.stdout}\n${local.stderr}`, /SANDBOX_CONTROL_(?:BROKER_UNAVAILABLE|RESULT_UNKNOWN)|SANDBOX_TASK_VIEW/u);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', taskId, '.task-finalization.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', '.task-finalization')), false);
    assert.equal(fs.readdirSync(path.join(manifest.channelDir, 'requests')).length, 0);
  } finally {
    controller.abort();
    await server?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox-local task-finalization rejects concurrent full handlers during domain preparation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-domain-prepare-'));
  const taskId = 'TASK-20260809-010203';
  const generation = 'finalization-busy-no-prepare-generation';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  let first: CollectedChild | null = null;
  let second: CollectedChild | null = null;
  let third: CollectedChild | null = null;
  let releasePrepare!: () => void;
  let releaseDomainPrepare!: () => void;
  let markPrepared!: () => void;
  const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
  const preparedEntered = new Promise<void>((resolve) => { markPrepared = resolve; });
  let prepareCalls = 0;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    writeFinalizationTaskFixture(root, taskId);
    const providerSource = path.join(root, '.agents', 'finalization-gated-provider.mjs');
    fs.copyFileSync(path.resolve('tests/fixtures/platform-providers/finalization-gated-provider.mjs'), providerSource);
    const receiptDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    const receiptPath = path.join(receiptDir, '.task-finalization.json');
    const enteredPath = path.join(root, 'domain-prepare-entered');
    const releasePath = path.join(root, 'domain-prepare-release');
    const callsPath = path.join(root, 'platform-comment-calls');
    releaseDomainPrepare = () => fs.writeFileSync(releasePath, 'release\n');
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
      task: { shortIdLength: 2 },
      platform: {
        type: 'finalization-gated',
        providers: {
          'finalization-gated': {
            source: '.agents/finalization-gated-provider.mjs',
            config: { enteredPath, releasePath, callsPath, issueId: 'finalization-test-issue' }
          }
        }
      }
    }));
    const taskPath = path.join(root, '.agents', 'workspace', 'active', taskId, 'task.md');
    fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace(
      'agent_infra_version: v0.9.9',
      "agent_infra_version: v0.9.9\nplatform_issue_identity: '{\"kind\":\"id\",\"value\":\"finalization-test-issue\"}'"
    ));
    const manifest = readSandboxControlManifest(manifestPath);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts'),
      prepareExecution: async (params) => {
        prepareCalls += 1;
        const prepared = await prepareSandboxControlExecution(params);
        markPrepared();
        await prepareGate;
        return prepared;
      }
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    first = runSandboxLocalTaskFinalizationAsync(root, manifest, taskId);
    await Promise.race([
      preparedEntered,
      first.result.then((result) => { throw new Error(`first full handler exited before executor preparation: ${result.stderr || result.stdout || result.exitCode}`); })
    ]);
    releasePrepare();
    await waitForStatusStateAsync(manifest.publicStatusDir, 'busy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + SANDBOX_CONTROL_TEST_TIMEOUT_MS;
        const poll = () => {
          if (fs.existsSync(enteredPath)) return resolve();
          if (Date.now() >= deadline) return reject(new Error('domain preparation did not reach gated platform comment write'));
          setTimeout(poll, 10);
        };
        poll();
      }),
      first.result.then((result) => {
        throw new Error(`first full handler exited before gated domain preparation: ${result.stderr || result.stdout || result.exitCode}`);
      })
    ]);
    const activeRequestId = fs.readdirSync(manifest.processingDir).find((entry) => fs.existsSync(path.join(manifest.processingDir, entry, 'reservation.json')));
    assert.ok(activeRequestId, 'active executor reservation is present');
    const acceptedReceipt = fs.readFileSync(receiptPath, 'utf8');
    assert.equal(fs.readFileSync(callsPath, 'utf8'), 'write\n');
    second = runSandboxLocalTaskFinalizationAsync(root, manifest, taskId);
    third = runSandboxLocalTaskFinalizationAsync(root, manifest, taskId);
    const concurrentResults = await Promise.all([second.result, third.result]);
    for (const result of concurrentResults) {
      assert.notEqual(result.exitCode, 0, result.stdout);
      assert.match(`${result.stdout}\n${result.stderr}`, /SANDBOX_CONTROL_BUSY/u);
    }
    assert.equal(prepareCalls, 1);
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), acceptedReceipt);
    assert.equal(fs.readFileSync(callsPath, 'utf8'), 'write\n');
    assert.equal(fs.readdirSync(path.join(manifest.channelDir, 'requests')).length, 0);
    releaseDomainPrepare();
    const firstResult = await first.result;
    assert.equal(firstResult.exitCode, 0, firstResult.stderr || firstResult.stdout);
    assert.equal(JSON.parse(firstResult.stdout).status, 'completed', firstResult.stdout);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'completed', taskId, 'task.md')), true);
  } finally {
    releasePrepare();
    releaseDomainPrepare();
    controller.abort();
    await server?.catch(() => undefined);
    await stopCollectedChild(first);
    await stopCollectedChild(second);
    await stopCollectedChild(third);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox-local task-finalization resumes a pending receipt after broker teardown in a new generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-generation-resume-'));
  const taskId = 'TASK-20260809-010203';
  const firstGeneration = 'finalization-resume-generation-1';
  const secondGeneration = 'finalization-resume-generation-2';
  let controller = new AbortController();
  let server: Promise<void> | undefined;
  let first: CollectedChild | null = null;
  let second: CollectedChild | null = null;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, firstGeneration);
    writeFinalizationTaskFixture(root, taskId);
    const registryPath = path.join(root, '.agents', 'workspace', 'active', '.short-ids.json');
    const manifest = readSandboxControlManifest(manifestPath);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts'),
      prepareExecution: async (params) => {
        const prepared = await prepareSandboxControlExecution(params);
        fs.writeFileSync(registryPath, 'invalid json');
        return prepared;
      }
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    first = runSandboxLocalTaskFinalizationAsync(root, manifest, taskId);
    const firstResult = await first.result;
    assert.notEqual(firstResult.exitCode, 0, firstResult.stdout);
    const receiptPath = path.join(root, '.agents', 'workspace', 'active', taskId, '.task-finalization.json');
    const pendingReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      lifecycle: string;
      controlBinding: { generation: string; requestId: string };
    };
    assert.equal(pendingReceipt.lifecycle, 'pending', JSON.stringify(pendingReceipt));
    assert.equal(pendingReceipt.controlBinding.generation, firstGeneration);

    controller.abort();
    await server;
    server = undefined;
    assert.equal(fs.existsSync(path.join(root, 'broker.json')), false);
    fs.writeFileSync(registryPath, `${JSON.stringify({ version: 1, ids: { '08': taskId } })}\n`);
    const secondManifestPath = writeControlManifest(root, branch, secondGeneration);
    const secondManifest = readSandboxControlManifest(secondManifestPath);
    controller = new AbortController();
    server = serveSandboxControl(secondManifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts')
    });
    await waitForStatusStateAsync(secondManifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    second = runSandboxLocalTaskFinalizationAsync(root, secondManifest, taskId);
    const secondResult = await second.result;
    assert.equal(secondResult.exitCode, 0, secondResult.stderr || secondResult.stdout);
    assert.equal(JSON.parse(secondResult.stdout).status, 'completed', secondResult.stdout);
    const resumedReceipt = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'workspace', 'completed', taskId, '.task-finalization.json'), 'utf8')) as {
      lifecycle: string;
      controlBinding: { generation: string; requestId: string };
    };
    assert.equal(resumedReceipt.lifecycle, 'done');
    assert.deepEqual(resumedReceipt.controlBinding, pendingReceipt.controlBinding);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'completed', taskId, 'task.md')), true);
  } finally {
    controller.abort();
    await server?.catch(() => undefined);
    await stopCollectedChild(first);
    await stopCollectedChild(second);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization publishes its executor result when the receipt disappears', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-receipt-missing-'));
  const taskId = 'TASK-20260809-010203';
  const generation = 'finalization-receipt-missing-generation';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  let clientResult: Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    writeFinalizationTaskFixture(root, taskId);
    await prepareFinalizationTask(root, taskId);
    const manifest = readSandboxControlManifest(manifestPath);
    const resultEvidence = observeResultEvidence(t, manifest.processingDir);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts')
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    clientResult = runTaskFinalizationClient({
      channelDir: manifest.channelDir,
      statusDir: manifest.publicStatusDir,
      token: manifest.token,
      generation,
      timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS,
    });
    const evidence = await resultEvidence;
    fs.rmSync(path.join(root, '.agents', 'workspace', 'completed', taskId, '.task-finalization.json'));
    const client = await clientResult;
    assert.equal(client.exitCode, 0, client.stderr);
    assert.equal(client.payload.phase, 'completed');
    assert.equal((JSON.parse(String(client.payload.stdout)) as { result: { result: string } }).result.result, 'completed');
    controller.abort();
    await server;
    assert.equal(fs.existsSync(path.join(manifest.channelDir, 'responses', `${evidence.requestId}.json`)), true);
    assert.equal(fs.existsSync(path.join(manifest.processingDir, evidence.requestId)), false);
  } finally {
    controller.abort();
    await server?.catch(() => undefined);
    await clientResult?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization settles and commits the canonical terminal before graceful shutdown cleanup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-graceful-shutdown-'));
  const taskId = 'TASK-20260809-010203';
  const generation = 'finalization-graceful-shutdown-generation';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  let clientResult: Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> | undefined;
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    writeFinalizationTaskFixture(root, taskId);
    await prepareFinalizationTask(root, taskId);
    const manifest = readSandboxControlManifest(manifestPath);
    const resultEvidence = observeResultEvidence(t, manifest.processingDir);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts')
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    clientResult = runTaskFinalizationClient({
      channelDir: manifest.channelDir,
      statusDir: manifest.publicStatusDir,
      token: manifest.token,
      generation,
      timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS,
    });
    const evidence = await resultEvidence;
    controller.abort();
    await server;
    const client = await clientResult;
    assert.equal(client.exitCode, 0, `${client.stderr}\n${JSON.stringify(client.payload)}`);
    assert.equal(client.payload.phase, 'completed');
    assert.equal((JSON.parse(String(client.payload.stdout)) as { result: { result: string } }).result.result, 'completed');
    const status = JSON.parse(fs.readFileSync(path.join(manifest.publicStatusDir, 'status.json'), 'utf8')) as {
      taskView: { state: string; observedSource: string | null; receipt: { requestId: string } | null };
    };
    assert.equal(status.taskView.state, 'current', JSON.stringify(status.taskView));
    assert.equal(status.taskView.observedSource, 'completed');
    assert.equal(status.taskView.receipt?.requestId, evidence.requestId);
    assert.equal(fs.existsSync(path.join(manifest.channelDir, 'responses', `${evidence.requestId}.json`)), true);
    assert.equal(fs.existsSync(path.join(manifest.processingDir, evidence.requestId)), false);
    assert.equal(fs.existsSync(path.join(manifest.channelDir, 'responses', `${evidence.requestId}.accepted.json`)), false);
  } finally {
    controller.abort();
    await server?.catch(() => undefined);
    await clientResult?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization reports unknown when shutdown precedes broker result publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-receipt-before-result-'));
  const taskId = 'TASK-20260809-010203';
  const generation = 'finalization-receipt-before-result-generation';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  let clientResult: Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> | undefined;
  let releaseResult!: () => void;
  let resultReleased = false;
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    writeFinalizationTaskFixture(root, taskId);
    await prepareFinalizationTask(root, taskId);
    const manifest = readSandboxControlManifest(manifestPath);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts'),
      prepareExecution: async (params) => {
        const prepared = await prepareSandboxControlExecution(params);
        return {
          ...prepared,
          completion: prepared.completion.then(async (result) => {
            await resultGate;
            resultReleased = true;
            return result;
          })
        };
      }
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    clientResult = runTaskFinalizationClient({
      channelDir: manifest.channelDir,
      statusDir: manifest.publicStatusDir,
      token: manifest.token,
      generation,
      timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS,
    });
    await waitForReceiptTerminalAsync(root, taskId, SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    const receiptPath = path.join(root, '.agents', 'workspace', 'completed', taskId, '.task-finalization.json');
    const processingEntries = fs.readdirSync(manifest.processingDir);
    assert.equal(processingEntries.length, 1);
    assert.equal(fs.existsSync(path.join(manifest.processingDir, processingEntries[0]!, 'result.json')), false);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    assert.equal(receipt.lifecycle, 'done', JSON.stringify(receipt));
    assert.deepEqual(receipt.controlBinding, { generation, requestId: processingEntries[0] });
    controller.abort();
    await server;
    const client = await clientResult;
    assert.equal(client.exitCode, 1);
    assert.equal((client.payload.error as { code: string }).code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
    assert.equal(client.payload.accepted, true);
    assert.equal(client.payload.requestId, processingEntries[0]);
    assert.equal(fs.readdirSync(manifest.processingDir).length, 1);
    assert.equal(resultReleased, false);
  } finally {
    releaseResult();
    controller.abort();
    await server?.catch(() => undefined);
    await clientResult?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-finalization preserves unknown result evidence when executor termination is unconfirmed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-finalization-termination-unconfirmed-'));
  const taskId = 'TASK-20260809-010203';
  const generation = 'finalization-termination-unconfirmed-generation';
  const controller = new AbortController();
  let server: Promise<void> | undefined;
  let clientResult: Promise<{ exitCode: number; payload: Record<string, unknown>; stderr: string }> | undefined;
  let releaseResult!: () => void;
  let terminateCalls = 0;
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, generation);
    writeFinalizationTaskFixture(root, taskId);
    await prepareFinalizationTask(root, taskId);
    const manifest = readSandboxControlManifest(manifestPath);
    server = serveSandboxControl(manifestPath, controller.signal, {
      timing: { ...DEFAULT_SANDBOX_CONTROL_TIMING, controlTickMs: 1 },
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null,
      internalCliPath: path.resolve('bin/internal-cli.ts'),
      prepareExecution: async (params) => {
        const prepared = await prepareSandboxControlExecution(params);
        return {
          ...prepared,
          completion: prepared.completion.then(async (result) => {
            await resultGate;
            return result;
          }),
          terminate(updateState = true) {
            terminateCalls += 1;
            prepared.terminate(updateState);
            return false;
          }
        };
      }
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    clientResult = runTaskFinalizationClient({
      channelDir: manifest.channelDir,
      statusDir: manifest.publicStatusDir,
      token: manifest.token,
      generation,
      timeoutMs: SANDBOX_CONTROL_TEST_TIMEOUT_MS,
    });
    await waitForReceiptLifecycleDoneAsync(root, taskId, SANDBOX_CONTROL_TEST_TIMEOUT_MS);
    const receiptPath = path.join(root, '.agents', 'workspace', 'completed', taskId, '.task-finalization.json');
    const processingEntries = fs.readdirSync(manifest.processingDir);
    assert.equal(processingEntries.length, 1);
    const requestId = processingEntries[0]!;
    assert.equal(fs.existsSync(path.join(manifest.processingDir, requestId, 'result.json')), false);
    controller.abort();
    await server;
    const client = await clientResult;
    assert.equal(client.exitCode, 1);
    assert.equal((client.payload.error as { code: string }).code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
    assert.equal(client.payload.accepted, true);
    assert.equal(client.payload.requestId, requestId);
    assert.equal(terminateCalls, 1);
    assert.equal(fs.existsSync(path.join(manifest.channelDir, 'responses', `${requestId}.accepted.json`)), true);
    assert.equal(fs.existsSync(path.join(manifest.processingDir, requestId)), true);
  } finally {
    releaseResult();
    controller.abort();
    await server?.catch(() => undefined);
    await clientResult?.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const shortIdLength of [2, 3]) {
test(`sandbox control broker enforces task binding with short-id width ${shortIdLength}`, async () => {
  const internalCliPath = path.resolve('bin/internal-cli.ts');
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
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  const shortId = '8'.padStart(shortIdLength, '0');
  const otherTaskId = 'TASK-20260809-010204';
  const otherTaskDir = path.join(root, '.agents', 'workspace', 'active', otherTaskId);
  fs.mkdirSync(otherTaskDir);
  fs.writeFileSync(path.join(otherTaskDir, 'task.md'), `---\nid: ${otherTaskId}\n---\n`);
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength } }));
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), JSON.stringify({
    version: 1, ids: { [shortId]: taskId, ['9'.padStart(shortIdLength, '0')]: otherTaskId }
  }));
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'docker',
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-dev-feature',
    containerIdentity: { id: 'container-id', labels: {} },
    authorityEvidence: fixtureAuthorityEvidence(),
    branch,
    mode: 'task-bound',
    taskId,
    token,
    generation,
    controlRootId: 'a'.repeat(96),
    channelDir,
    publicStatusDir: statusDir,
    processingDir,
    runtimeDir: path.join(root, 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId, generation, controlRootId: 'a'.repeat(96)
  });
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', `
      import { serveSandboxControl } from ${JSON.stringify(new URL('../../../lib/sandbox/control/server.ts', import.meta.url).href)};
      await serveSandboxControl(${JSON.stringify(manifestPath)}, undefined, {
        internalCliPath: ${JSON.stringify(internalCliPath)},
        inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} })
      });
    `],
    { cwd: path.resolve('.'), stdio: 'ignore' }
  );
  try {
    waitForFile(path.join(root, 'broker.json'), 5_000);
    waitForHealthyStatus(statusDir, 5_000);
    // Resolve from a nested directory, as ordinary task-bound CLI commands do.
    const previousCwd = process.cwd();
    process.chdir(taskDir);
    try {
      for (const ref of ['8', shortId, taskId, '9', otherTaskId, '7', '0', '9999', 'not-a-task']) {
        waitForHealthyStatus(statusDir, 5_000);
        const result = withSandboxControlEnvironment({
          AGENT_INFRA_TASK_ID: taskId,
          AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
          AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
          AGENT_INFRA_CONTROL_DIR: channelDir,
          AGENT_INFRA_CONTROL_TOKEN: token,
          AGENT_INFRA_CONTROL_GENERATION: generation,
          AGENT_INFRA_RUNTIME_DIR: path.join(root, 'runtime')
        }, () => spawnSync(process.execPath, [
          '--experimental-strip-types', '--no-warnings', internalCliPath,
          'task-artifact', ref, 'inspect', '--family', 'analysis'
        ], { cwd: taskDir, env: process.env, encoding: 'utf8', timeout: 10_000 }));
        assert.equal(result.error, undefined);
        if (['8', shortId, taskId].includes(ref)) {
          assert.equal(result.status, 0, `${ref}: ${result.stderr}${result.stdout}`);
          const output = JSON.parse(result.stdout);
          assert.equal(output.status, 'ready', ref);
          assert.equal(output.taskId, taskId, ref);
          assert.equal(output.next.name, 'analysis.md', ref);
        } else {
          assert.equal(result.status, ref === 'not-a-task' ? 2 : 1, `${ref}: ${result.stderr}${result.stdout}`);
          if (ref === 'not-a-task') {
            assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_TASK_REF');
          } else {
            assert.match(result.stderr, /SANDBOX_TASK_REF_MISMATCH/, ref);
          }
        }
      }
    } finally { process.chdir(previousCwd); }

    const response = withSandboxControlEnvironment({
      AGENT_INFRA_TASK_ID: taskId,
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    }, () => requestSandboxControl({
      family: 'task-lifecycle',
      args: [taskId, 'complete'],
      channelDir,
      statusDir,
      token,
      generation,
      timeoutMs: 5_000
    }));
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

}

test('sandbox broker opens and closes a host-only Codex controller registration across processes', onPlatforms('linux'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-controller-roundtrip-'));
  const channelDir = path.join(root, 'channel');
  const manifestPath = path.join(root, 'manifest.json');
  const statusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  const fakeBin = path.join(root, 'bin-fixture');
  for (const directory of [channelDir, statusDir, processingDir, fakeBin]) fs.mkdirSync(directory, { recursive: true });
  const branch = initializeRepository(root);
  const packageVersion = (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
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
  const containerId = 'f'.repeat(64);
  fs.writeFileSync(docker, `#!/bin/sh
if [ "$1" = --context ] && [ "$2" = default ]; then shift 2; fi
if [ "$1" = version ]; then printf '%s\\n' '{"ApiVersion":"1.50"}'; exit 0; fi
if [ "$1" = info ]; then printf '%s\\n' '"daemon-id"'; exit 0; fi
if [ "$1" = container ] && [ "$2" = ls ]; then printf '%s\\n' '${containerId}'; exit 0; fi
if [ "$1" = container ] && [ "$2" = inspect ]; then printf '%s\\n' '{"Id":"${containerId}","State":{"Running":true},"Config":{"Labels":{}}}'; exit 0; fi
[ "$1" = exec ] && [ "$3" = cat ] && exec cat "$4"
exit 1
`, { mode: 0o700 });
  const authorityEvidence = captureSandboxAuthority('native', {
    env: { DOCKER_CONTEXT: 'default' },
    lockDomain: 'a'.repeat(64),
    probe: (_cmd, args) => ({
      status: 0, signal: null, stdout: JSON.stringify(args.at(-1) === '{{json .ID}}' ? 'daemon-id' : { ApiVersion: '1.50' }), stderr: '', pid: 1, output: []
    })
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'native',
    repoRoot: root,
    worktreeRoot: root,
    project: 'demo',
    container: 'demo-dev-feature',
    containerIdentity: { id: containerId, labels: {} },
    authorityEvidence,
    branch,
    mode: 'task-bound',
    taskId: 'TASK-20260809-010203',
    token: 'controller-secret',
    generation: 'controller-generation',
    controlRootId: 'a'.repeat(96),
    channelDir,
    publicStatusDir: statusDir,
    processingDir,
    runtimeDir: path.join(root, 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation: 'controller-generation', controlRootId: 'a'.repeat(96)
  });
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
    const opened = withSandboxControlEnvironment({
      AGENT_INFRA_TASK_ID: 'TASK-20260809-010203',
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    }, () => requestCodexControllerOpen({
      controllerProcess: { pid: process.pid, startTime },
      channelDir,
      statusDir,
      token: 'controller-secret',
      generation: 'controller-generation',
      timeoutMs: 5_000
    }));
    const registration = fs.readFileSync(path.join(root, 'codex-controller.json'), 'utf8');
    assert.equal(registration.includes(opened.lease.leaseSecret), false);
    assert.equal(fs.lstatSync(path.join(root, 'codex-controller.json')).mode & 0o777, 0o600);
    const verified = withSandboxControlEnvironment({
      AGENT_INFRA_TASK_ID: 'TASK-20260809-010203',
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    }, () => requestCodexControllerVerify({
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
    }));
    assert.deepEqual(verified.binding, {
      taskId: 'TASK-20260809-010203',
      controlGeneration: 'controller-generation',
      controllerInstanceDigest: opened.lease.controllerInstanceDigest
    });
    const closed = withSandboxControlEnvironment({
      AGENT_INFRA_TASK_ID: 'TASK-20260809-010203',
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    }, () => requestCodexControllerClose({
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
    }));
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

test('broker recovery accepts a controller close after the registration was durably removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-controller-close-recovery-'));
  const requestId = '99999999-9999-4999-8999-999999999999';
  let server: Promise<void> | undefined;
  let controller: AbortController | undefined;
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'controller-close-recovery-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    fs.mkdirSync(path.join(manifest.channelDir, 'responses'), { recursive: true });
    const processing = path.join(manifest.processingDir, requestId);
    fs.mkdirSync(path.join(processing, 'transitions'), { recursive: true });
    fs.writeFileSync(path.join(processing, 'transitions', 'started-committed.json'), '{}\n');
    writeSandboxControlTransition(manifest, { requestId, phase: 'completed' });
    writeSandboxControlTransition(manifest, { requestId, phase: 'evidence-written' });
    writeSandboxControlTransition(manifest, { requestId, phase: 'publish-authorized' });
    const startTime = getProcessStartTime(process.pid);
    assert.ok(startTime);
    const proof = {
      version: 1 as const,
      leaseId: 'b'.repeat(64),
      leaseSecret: 'c'.repeat(64),
      controllerProcess: { pid: process.pid, startTime }
    };
    fs.writeFileSync(path.join(processing, 'request.json'), `${JSON.stringify({
      version: 4, id: requestId, token: manifest.token, generation: manifest.generation,
      issuedAt: Date.now() - 100, expiresAt: Date.now() + 1_000,
      family: 'codex-controller', command: 'close', args: [],
      controllerProcess: proof.controllerProcess, controllerProof: proof
    })}\n`);
    fs.writeFileSync(path.join(processing, 'execution.json'), `${JSON.stringify({
      version: 2, generation: manifest.generation, requestId, nonce: 'controller-close-recovery',
      child: { pid: 999_999_999, startTime: 0, processGroupId: null }, phase: 'running', updatedAt: Date.now()
    })}\n`);
    writeSandboxControlReservation(manifest, requestId, { logicalRecords: 1, bytes: 0 });
    const output = `${JSON.stringify({ version: 1, status: 'closed', changed: true, lease: null, error: null })}\n`;
    writeSandboxControlResultEvidence(manifest, requestId, { exitCode: 0, stdout: output, stderr: '' });
    writeSandboxControlPayload(manifest, requestId, { stdout: output, stderr: '' });
    writeSandboxControlTerminalResult(manifest, { id: requestId, family: 'codex-controller', operation: 'close' }, output);
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.accepted.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);

    controller = new AbortController();
    server = serveSandboxControl(manifestPath, controller.signal, {
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', 5_000);
    const responsePath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    waitForFile(responsePath, 5_000);
    const response = readJsonFileAfterPublication(responsePath, 5_000);
    assert.equal(response.phase, 'completed');
    const payload = readJsonFileAfterPublication(path.join(manifest.channelDir, 'responses', `${requestId}.payload.json`), 5_000);
    assert.equal((JSON.parse(String(payload.stdout)) as { changed: boolean }).changed, true);
    assert.equal(fs.existsSync(path.join(root, 'codex-controller.json')), false);
    assert.equal(fs.existsSync(processing), false);
  } finally {
    controller?.abort();
    if (server) await server;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker recovery terminates a live started executor before retaining unknown', onPlatforms('linux'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-orphan-executor-recovery-'));
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let server: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'orphan-executor-recovery-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    fs.mkdirSync(path.join(manifest.channelDir, 'responses'), { recursive: true });
    const processing = path.join(manifest.processingDir, requestId);
    fs.mkdirSync(path.join(processing, 'transitions'), { recursive: true });
    fs.writeFileSync(path.join(processing, 'transitions', 'started-committed.json'), '{}\n');
    child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', () => resolve());
      child?.once('error', reject);
    });
    const startTime = getProcessStartTime(child.pid!);
    assert.ok(startTime);
    fs.writeFileSync(path.join(processing, 'request.json'), `${JSON.stringify({
      version: 4, id: requestId, token: manifest.token, generation: manifest.generation,
      issuedAt: Date.now() - 100, expiresAt: Date.now() + 1_000,
      family: 'task-lifecycle', args: ['TASK-20260809-010203', 'block', '--agent', 'codex'],
      controllerProcess: null, controllerProof: null
    })}\n`);
    fs.writeFileSync(path.join(processing, 'execution.json'), `${JSON.stringify({
      version: 2, generation: manifest.generation, requestId, nonce: 'orphan-executor-recovery',
      child: { pid: child.pid, startTime, processGroupId: child.pid }, phase: 'running', updatedAt: Date.now()
    })}\n`);
    writeSandboxControlReservation(manifest, requestId, { logicalRecords: 1, bytes: 0 });

    controller = new AbortController();
    server = serveSandboxControl(manifestPath, controller.signal, {
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', 5_000);
    const responsePath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    waitForFile(responsePath, 5_000);
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8')) as Record<string, unknown>;
    assert.equal(response.phase, 'rejected');
    assert.equal((response.error as Record<string, unknown>).code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
    assert.equal(fs.existsSync(processing), true);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && isProcessAlive(child.pid!)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(isProcessAlive(child.pid!), false);
  } finally {
    controller?.abort();
    if (server) await server;
    if (child && isProcessAlive(child.pid!)) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    }
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
      containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
    mode: 'branch-only', taskId: null, token, generation, channelDir,
    controlRootId: 'a'.repeat(96),
    publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'control', 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'branch-only', taskId: null, generation, controlRootId: 'a'.repeat(96)
  });
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
    const response = withSandboxControlEnvironment({
      ...(process.platform === 'win32' ? { USERPROFILE: root } : { HOME: root }),
      AGENT_INFRA_TASK_ID: undefined,
      AGENT_INFRA_CONTROL_ROOT_ID: 'a'.repeat(96),
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    }, () => requestSandboxTaskCreate({
      candidate,
      channelDir,
      statusDir,
      token,
      generation,
      timeoutMs: 5_000
    }));
    assert.equal(response.exitCode, 0, response.stderr || response.stdout);
    const result = JSON.parse(response.stdout);
    assert.equal(result.status, 'applied');
    assert.equal(result.task.state, 'active');
    assert.deepEqual(result.operations.at(-1), { name: 'task:verify', status: 'pass', reasonCode: null });
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', result.task.id, 'task.md')), true);
    const currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(currentManifest.mode, 'branch-only');
    assert.equal(currentManifest.taskId, null);

    const [requestId] = fs.readdirSync(path.join(root, 'control', 'consumed'));
    assert.ok(requestId);
    assert.deepEqual(result.control, { requestId, accepted: true, recovery: 'none' });
    fs.writeFileSync(path.join(channelDir, 'requests', `${requestId}.json`), `${JSON.stringify({
      version: 2, id: requestId, token, generation, issuedAt: Date.now(), expiresAt: Date.now() + 2_000,
      family: 'task-create', candidate
    })}\n`);
    const replayPath = path.join(channelDir, 'responses', `${requestId}.json`);
    waitForFile(replayPath, 5_000);
    waitForAbsent(path.join(channelDir, 'responses', `${requestId}.accepted.json`), 5_000);
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
    containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: fixtureAuthorityEvidence(), branch,
    mode: 'task-bound', taskId: 'TASK-20260809-010203', token: 'recovery-secret', generation, controlRootId: 'a'.repeat(96),
    channelDir, publicStatusDir: statusDir, processingDir, runtimeDir: path.join(root, 'runtime')
  })}\n`);
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation, controlRootId: 'a'.repeat(96)
  });
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
    version: 4, id: recoverableId, token: 'recovery-secret', generation, issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 1_000, family: 'task-lifecycle', args: ['TASK-20260809-010203', 'block', '--agent', 'codex'],
    controllerProcess: null, controllerProof: null
  })}\n`);
  fs.writeFileSync(path.join(processingDir, recoverableId, 'execution.json'), `${JSON.stringify({
    version: 2, generation, requestId: recoverableId, nonce: 'recoverable-nonce',
    child: { pid: 999_999_999, startTime: 0, processGroupId: null },
    phase: 'running', updatedAt: Date.now()
  })}\n`);
  const controlManifest = {
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'demo', container: 'demo-dev-feature',
    authorityEvidence: fixtureAuthorityEvidence(),
    containerIdentity: { id: 'container-id', labels: {} }, branch, mode: 'task-bound' as const, taskId: 'TASK-20260809-010203',
    token: 'recovery-secret', generation, controlRootId: 'a'.repeat(96), channelDir, publicStatusDir: statusDir, processingDir,
    runtimeDir: path.join(root, 'runtime')
  };
  writeSandboxControlIdentitySentinel(statusDir, {
    version: 1, mode: 'task-bound', taskId: 'TASK-20260809-010203', generation, controlRootId: 'a'.repeat(96)
  });
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
    waitForFile(path.join(responsesDir, `${recoverableId}.json`), 5_000);
    const recovered = JSON.parse(fs.readFileSync(path.join(responsesDir, `${recoverableId}.json`), 'utf8'));
    assert.equal(recovered.phase, 'rejected');
    assert.equal(recovered.error.code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
    assert.equal(fs.existsSync(path.join(processingDir, recoverableId)), true);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker recovery returns inspectable task-create output when the payload is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-recovery-'));
  const requestId = '99999999-9999-4999-8999-999999999999';
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'task-create-recovery-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    const processingDirectory = path.join(manifest.processingDir, requestId);
    fs.mkdirSync(processingDirectory, { recursive: true });
    const issuedAt = Date.now() - 1_000;
    const candidate = {
      version: 1 as const,
      idempotencyKey: '12345678-1234-4123-8123-123456789abc',
      agent: 'codex' as const,
      title: 'Recover task-create output',
      type: 'feature' as const,
      branchSlug: 'recover-task-create-output',
      priority: 'Medium' as const,
      effort: 'Low' as const,
      description: 'Recover a task-create result after the broker loses its payload.',
      taskInput: {
        sources: [], facts: [], constraints: [], decisions: [], alternatives: [],
        acceptanceCriteria: [], openQuestions: []
      }
    };
    fs.writeFileSync(path.join(processingDirectory, 'request.json'), `${JSON.stringify({
      version: 4, id: requestId, token: manifest.token, generation: manifest.generation,
      issuedAt, expiresAt: issuedAt + 2_000, family: 'task-create', candidate,
      controllerProcess: null, controllerProof: null
    })}\n`);
    fs.writeFileSync(path.join(processingDirectory, 'execution.json'), `${JSON.stringify({
      version: 2, generation: manifest.generation, requestId, nonce: 'task-create-recovery-nonce',
      child: { pid: 999_999_999, startTime: 0, processGroupId: null }, phase: 'running', updatedAt: Date.now()
    })}\n`);
    writeSandboxControlReservation(manifest, requestId, { logicalRecords: 0, bytes: 0 });
    writeSandboxControlResultEvidence(manifest, requestId, { exitCode: 0, stdout: 'lost task-create output\n', stderr: '' });

    const controller = new AbortController();
    const server = serveSandboxControl(manifestPath, controller.signal, {
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', 5_000);
    const responsePath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    waitForFile(responsePath, 5_000);
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8')) as Record<string, unknown>;
    assert.equal(response.phase, 'completed');
    assert.equal(response.exitCode, 0);
    assert.equal(response.outputState, 'unavailable');
    const result = JSON.parse(String(response.stdout));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE');
    assert.deepEqual(result.control, { requestId, accepted: true, recovery: 'inspect-domain-state' });
    assert.equal(result.task.id, null);
    assert.equal(result.task.shortId, null);
    assert.equal(result.task.state, null);
    assert.equal(recoverSandboxControlFromChannel(requestId, { channelDir: manifest.channelDir, generation: manifest.generation, timeoutMs: 100 }).stdout, response.stdout);
    assert.equal(fs.existsSync(processingDirectory), false);
    controller.abort();
    await server;

    const recovered = spawnSync(process.execPath, [
      '--experimental-strip-types', '--no-warnings', path.resolve('bin/internal-cli.ts'), 'sandbox-control', 'recover', requestId
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_INFRA_CONTROL_TOKEN: manifest.token,
        AGENT_INFRA_SANDBOX: '1',
        AGENT_INFRA_CONTROL_ROOT_ID: manifest.controlRootId,
        AGENT_INFRA_CONTROL_GENERATION: manifest.generation,
        AGENT_INFRA_CONTROL_DIR: manifest.channelDir,
        AGENT_INFRA_CONTROL_STATUS_DIR: manifest.publicStatusDir,
        AGENT_INFRA_TASK_ID: manifest.taskId ?? '',
        AGENT_INFRA_RUNTIME_DIR: manifest.runtimeDir,
        AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined,
        AGENT_INFRA_EXECUTOR_MANIFEST: undefined
      }
    });
    assert.equal(recovered.status, 1, recovered.stderr || recovered.stdout);
    assert.equal(recovered.stdout, response.stdout, recovered.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker restart accepts an existing unavailable task-create terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-terminal-recovery-'));
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    const branch = initializeRepository(root);
    const manifestPath = writeControlManifest(root, branch, 'task-create-terminal-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    const processingDirectory = path.join(manifest.processingDir, requestId);
    fs.mkdirSync(processingDirectory, { recursive: true });
    fs.mkdirSync(path.join(manifest.channelDir, 'responses'), { recursive: true });
    const issuedAt = Date.now() - 1_000;
    const candidate = {
      version: 1 as const,
      idempotencyKey: '12345678-1234-4123-8123-123456789abc',
      agent: 'codex' as const,
      title: 'Read an existing task-create terminal',
      type: 'feature' as const,
      branchSlug: 'read-existing-task-create-terminal',
      priority: 'Medium' as const,
      effort: 'Low' as const,
      description: 'Keep a published unavailable terminal across broker restart.',
      taskInput: {
        sources: [], facts: [], constraints: [], decisions: [], alternatives: [],
        acceptanceCriteria: [], openQuestions: []
      }
    };
    fs.writeFileSync(path.join(processingDirectory, 'request.json'), `${JSON.stringify({
      version: 4, id: requestId, token: manifest.token, generation: manifest.generation,
      issuedAt, expiresAt: issuedAt + 2_000, family: 'task-create', candidate,
      controllerProcess: null, controllerProof: null
    })}\n`);
    fs.writeFileSync(path.join(processingDirectory, 'execution.json'), `${JSON.stringify({
      version: 2, generation: manifest.generation, requestId, nonce: 'task-create-terminal-nonce',
      child: { pid: 999_999_999, startTime: 0, processGroupId: null }, phase: 'running', updatedAt: Date.now()
    })}\n`);
    writeSandboxControlReservation(manifest, requestId, { logicalRecords: 0, bytes: 0 });
    writeSandboxControlResultEvidence(manifest, requestId, { exitCode: 0, stdout: 'lost task-create output\n', stderr: '' });
    const terminal = {
      version: 2, id: requestId, phase: 'completed', exitCode: 0,
      stdout: `${JSON.stringify(taskCreateOutputUnavailableResult(requestId))}\n`,
      stderr: 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: output payload was not retained\n',
      error: null, outputState: 'unavailable', payload: null
    };
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.json`), `${JSON.stringify(terminal)}\n`);

    const controller = new AbortController();
    const server = serveSandboxControl(manifestPath, controller.signal, {
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', 5_000);
    const deadline = Date.now() + 5_000;
    while (fs.existsSync(processingDirectory) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(processingDirectory), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.json`), 'utf8')), terminal);
    controller.abort();
    await server;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker recovery accepts a task-create no-op for a non-active task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-non-active-recovery-'));
  const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let server: Promise<void> | undefined;
  let controller: AbortController | undefined;
  try {
    const manifestPath = writeControlManifest(root, initializeRepository(root), 'task-create-non-active-generation');
    const manifest = readSandboxControlManifest(manifestPath);
    fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'workspace', 'blocked'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 }, delivery: { remote: 'origin', baseRef: 'main' } }));
    fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
    fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
    const candidate = {
      version: 1 as const,
      idempotencyKey: '12345678-1234-4123-8123-123456789abc',
      agent: 'codex' as const,
      title: 'Recover non-active task-create output',
      type: 'feature' as const,
      branchSlug: 'recover-non-active-create-output',
      priority: 'Medium' as const,
      effort: 'Low' as const,
      description: 'Recover a successful replay after the task leaves active.',
      taskInput: { sources: [], facts: [], constraints: [], decisions: [], alternatives: [], acceptanceCriteria: [], openQuestions: [] }
    };
    const created = createLocalTask(candidate, { repoRoot: root, agentInfraVersion: 'v0.11.5' });
    const blocked = path.join(root, '.agents', 'workspace', 'blocked', created.task.id);
    mutateShortIdRegistry(root, created.task.id, 'release');
    fs.renameSync(path.join(root, '.agents', 'workspace', 'active', created.task.id), blocked);

    const output = `${JSON.stringify({
      status: 'no-op', changed: false,
      task: { id: created.task.id, shortId: null, state: 'blocked' },
      issue: null, operations: [{ name: 'task:local', status: 'no-op', reasonCode: null }],
      warnings: [], error: null
    })}\n`;
    const processing = path.join(manifest.processingDir, requestId);
    fs.mkdirSync(path.join(processing, 'transitions'), { recursive: true });
    for (const phase of ['started-committed', 'completed', 'evidence-written', 'publish-authorized'] as const) {
      if (phase === 'started-committed') fs.writeFileSync(path.join(processing, 'transitions', `${phase}.json`), '{}\n');
      else writeSandboxControlTransition(manifest, { requestId, phase });
    }
    fs.writeFileSync(path.join(processing, 'request.json'), `${JSON.stringify({
      version: 4, id: requestId, token: manifest.token, generation: manifest.generation,
      issuedAt: Date.now() - 100, expiresAt: Date.now() + 1_000, family: 'task-create', candidate,
      controllerProcess: null, controllerProof: null
    })}\n`);
    fs.writeFileSync(path.join(processing, 'execution.json'), `${JSON.stringify({
      version: 2, generation: manifest.generation, requestId, nonce: 'task-create-non-active-recovery',
      child: { pid: 999_999_999, startTime: 0, processGroupId: null }, phase: 'running', updatedAt: Date.now()
    })}\n`);
    writeSandboxControlReservation(manifest, requestId, { logicalRecords: 1, bytes: 0 });
    writeSandboxControlResultEvidence(manifest, requestId, { exitCode: 0, stdout: output, stderr: '' });
    writeSandboxControlPayload(manifest, requestId, { stdout: output, stderr: '' });
    writeSandboxControlTerminalResult(manifest, { id: requestId, family: 'task-create', operation: 'create' }, output);
    fs.writeFileSync(path.join(manifest.channelDir, 'responses', `${requestId}.accepted.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);

    controller = new AbortController();
    server = serveSandboxControl(manifestPath, controller.signal, {
      inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),
      bindingCheck: () => null
    });
    await waitForStatusStateAsync(manifest.publicStatusDir, 'healthy', 5_000);
    const responsePath = path.join(manifest.channelDir, 'responses', `${requestId}.json`);
    waitForFile(responsePath, 5_000);
    const response = readJsonFileAfterPublication(responsePath, 5_000);
    assert.equal(response.phase, 'completed');
    assert.equal(response.exitCode, 0);
    assert.equal(response.outputState, 'available');
    const payload = readJsonFileAfterPublication(path.join(manifest.channelDir, 'responses', `${requestId}.payload.json`), 5_000);
    assert.equal(JSON.parse(String(payload.stdout)).task.state, 'blocked');
    assert.equal(JSON.parse(String(payload.stdout)).task.shortId, null);
  } finally {
    controller?.abort();
    if (server) await server;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
