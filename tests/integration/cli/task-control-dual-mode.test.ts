import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { INTERNAL_CLI_PATH, sandboxControlSafeEnv } from '../../helpers.ts';
import {
  createDirectHostExecutionContext,
  createSandboxExecutorExecutionContext,
  dispatchTaskControlOperation
} from '../../../lib/task/control-authority.ts';
import { issueHumanOverride } from '../../../lib/task/human-override.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...sandboxControlSafeEnv(),
    AGENT_INFRA_TASK_ID: undefined,
    AGENT_INFRA_RUNTIME_DIR: undefined,
    AGENT_INFRA_EXECUTOR_MANIFEST: undefined,
    AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined,
    ...overrides
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, command, ...args], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8'
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? ''
  };
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
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
}

test('task control without sandbox markers uses the direct-host entry', () => {
  const result = run('task-lifecycle', ['--help'], cleanEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: agent-infra-internal task-lifecycle/);
});

test('complete sandbox markers use the client entry without executing local authority', () => {
  const result = run('task-orchestration', ['TASK-20260809-010203', 'status'], cleanEnv({
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: 'generation',
    AGENT_INFRA_CONTROL_DIR: '/missing/control',
    AGENT_INFRA_CONTROL_STATUS_DIR: '/missing/status'
  }));
  assert.equal(result.status, 75);
  assert.match(result.stderr, /SANDBOX_CONTROL_BROKER_UNAVAILABLE/);
  assert.equal(result.stdout, '');
});

test('partial sandbox or executor markers fail closed before task parsing', () => {
  const partial = run('task-lifecycle', ['--help'], cleanEnv({ AGENT_INFRA_CONTROL_TOKEN: 'token' }));
  assert.equal(partial.status, 1);
  assert.equal(JSON.parse(partial.stdout).error.code, 'TASK_CONTROL_TRANSPORT_INVALID');

  const executor = run('task-lifecycle', ['--help'], cleanEnv({
    AGENT_INFRA_EXECUTOR_MANIFEST: '/missing/manifest.json'
  }));
  assert.equal(executor.status, 1);
  assert.equal(JSON.parse(executor.stdout).error.code, 'TASK_CONTROL_TRANSPORT_INVALID');
});

test('task-bound marker requires its runtime binding before entering the client', () => {
  const result = run('task-finalization', ['--help'], cleanEnv({
    AGENT_INFRA_TASK_ID: 'TASK-20260809-010203',
    AGENT_INFRA_CONTROL_TOKEN: 'token',
    AGENT_INFRA_CONTROL_GENERATION: 'generation',
    AGENT_INFRA_CONTROL_DIR: '/missing/control',
    AGENT_INFRA_CONTROL_STATUS_DIR: '/missing/status'
  }));
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'TASK_CONTROL_TRANSPORT_INVALID');
});

const TASK_ID = 'TASK-20260809-010203';

function taskFixture(activityLog = true, repository = false): { root: string; taskDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-control-dual-mode-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'),
    `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`
  );
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
    'updated_at: old', 'agent_infra_version: v0.9.11-alpha.0', 'target_date:', '---', '', '# Task',
    '', '## Review Disagreement Ledger', '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|',
    ...(activityLog ? ['', '## Activity Log', ''] : [''])
  ].join('\n'));
  if (repository) initializeRepository(root);
  return { root, taskDir };
}

type SandboxFixture = ReturnType<typeof taskFixture> & Readonly<{
  controlRoot: string;
  manifestPath: string;
  channelDir: string;
  statusDir: string;
  token: string;
  generation: string;
}>;

function sandboxFixture(): SandboxFixture {
  const fixture = taskFixture(true, true);
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-control-dual-mode-control-'));
  const channelDir = path.join(controlRoot, 'channel');
  const statusDir = path.join(controlRoot, 'public');
  const processingDir = path.join(controlRoot, 'processing');
  const generation = 'dual-mode-generation';
  const token = 'dual-mode-token';
  for (const directory of [channelDir, path.join(channelDir, 'requests'), path.join(channelDir, 'responses'), statusDir, processingDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const manifestPath = path.join(controlRoot, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    engine: 'test',
    repoRoot: fixture.root,
    worktreeRoot: fixture.root,
    project: 'dual-mode',
    container: 'dual-mode-container',
    containerIdentity: { id: 'container-id', labels: {} },
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: fixture.root, encoding: 'utf8' }).trim(),
    mode: 'task-bound',
    taskId: TASK_ID,
    token,
    generation,
    channelDir,
    publicStatusDir: statusDir,
    processingDir,
    runtimeDir: path.join(controlRoot, 'runtime')
  })}\n`);
  return { ...fixture, controlRoot, manifestPath, channelDir, statusDir, token, generation };
}

function runSandboxClient(
  fixture: SandboxFixture,
  family: 'task-lifecycle' | 'task-orchestration',
  args: string[]
): { status: number | null; payload: Record<string, unknown>; stderr: string } {
  const result = spawnSync(process.execPath, [
    INTERNAL_CLI_PATH, 'sandbox-control', 'client', family, ...args
  ], {
    cwd: fixture.root,
    env: {
      ...cleanEnv(),
      AGENT_INFRA_CONTROL_DIR: fixture.channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: fixture.statusDir,
      AGENT_INFRA_CONTROL_TOKEN: fixture.token,
      AGENT_INFRA_CONTROL_GENERATION: fixture.generation
    },
    encoding: 'utf8'
  });
  return {
    status: result.status,
    payload: JSON.parse(result.stdout?.toString() ?? '') as Record<string, unknown>,
    stderr: result.stderr?.toString() ?? ''
  };
}

function startSandboxFixtureBroker(fixture: SandboxFixture): ReturnType<typeof spawn> {
  const serverModule = pathToFileURL(path.resolve('lib/sandbox/control/server.ts')).href;
  const script = [
    `import { serveSandboxControl } from '${serverModule}';`,
    'process.argv[1] = process.env.TEST_INTERNAL_CLI;',
    'const controller = new AbortController();',
    "process.once('SIGTERM', () => controller.abort());",
    "process.once('SIGINT', () => controller.abort());",
    'await serveSandboxControl(process.env.TEST_MANIFEST, controller.signal, {',
    "  inspectContainer: async () => ({ state: 'found', id: 'container-id', running: true, labels: {} }),",
    '  timing: { controlTickMs: 10, parkedBindingInitialMs: 10, slowCheckMs: 50, containerHeartbeatMs: 1000, quiesceDeadlineMs: 200 }',
    '});'
  ].join('\n');
  const child = spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      TEST_MANIFEST: fixture.manifestPath,
      TEST_INTERNAL_CLI: INTERNAL_CLI_PATH
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function stopSandboxFixtureBroker(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function contexts(root: string) {
  return {
    direct: createDirectHostExecutionContext({ repoRoot: root }),
    sandbox: createSandboxExecutorExecutionContext({
      repoRoot: root,
      worktreeRoot: root,
      runtimeDir: path.join(root, 'control', 'runtime'),
      taskId: TASK_ID,
      generation: 'generation',
      manifestPath: path.join(root, 'control', 'manifest.json'),
      requestId: 'request-id'
    })
  };
}

function lifecycleOperation(overrides: Record<string, unknown> = {}) {
  return {
    family: 'task-lifecycle' as const,
    request: {
      taskRef: TASK_ID,
      intent: 'block' as const,
      agent: 'codex',
      reason: 'pause for dual-mode verification',
      unblockCondition: 'resume after verification',
      ...overrides
    }
  };
}

function comparableLifecycle(value: unknown): unknown {
  const result = value as Record<string, unknown>;
  return {
    status: result.status,
    changed: result.changed,
    taskId: result.taskId,
    intent: result.intent,
    sourceState: result.sourceState,
    targetState: result.targetState,
    directory: result.directory,
    shortId: result.shortId,
    error: result.error
  };
}

function comparableReceipt(value: unknown): unknown {
  const receipt = value as Record<string, unknown>;
  return {
    taskId: receipt.taskId,
    role: receipt.role,
    stage: receipt.stage,
    round: receipt.round,
    artifact: receipt.artifact,
    client: receipt.client,
    requestedModel: receipt.requestedModel,
    requestedReasoningEffort: receipt.requestedReasoningEffort,
    actualModel: receipt.actualModel,
    actualReasoningEffort: receipt.actualReasoningEffort,
    modelFallbackReason: receipt.modelFallbackReason,
    reasoningEffortFallbackReason: receipt.reasoningEffortFallbackReason,
    parentId: receipt.parentId,
    childId: receipt.childId,
    spawnMode: receipt.spawnMode,
    agent: receipt.agent,
    status: receipt.status,
    workspaceSnapshotScope: receipt.workspaceSnapshotScope,
    lifecycleProvenance: receipt.lifecycleProvenance,
    hostEvidence: receipt.hostEvidence,
    beforeFingerprint: comparableSnapshot(receipt.beforeFingerprint),
    afterFingerprint: receipt.afterFingerprint,
    changedPaths: receipt.changedPaths
  };
}

function comparableSnapshot(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('ws2:')) return value;
  const snapshot = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')) as {
    version: number;
    gitTree: string;
    taskFiles: Array<{ path: string; mode: number; kind: string }>;
  };
  return {
    version: snapshot.version,
    gitTree: snapshot.gitTree,
    taskFiles: snapshot.taskFiles
  };
}

function comparableOrchestration(value: unknown): unknown {
  const result = value as Record<string, unknown>;
  const run = result.run as Record<string, unknown> | null;
  const source = run?.modelPolicySource as Record<string, unknown> | undefined;
  return {
    status: result.status,
    changed: result.changed,
    taskId: result.taskId,
    next: result.next,
    error: result.error,
    run: run ? {
      taskId: run.taskId,
      status: run.status,
      nextStage: run.nextStage,
      stepCount: run.stepCount,
      maxSteps: run.maxSteps,
      modelPolicy: run.modelPolicy,
      modelPolicySource: source ? { kind: source.kind, client: source.client } : null,
      recoveryHistory: run.recoveryHistory,
      baseline: run.baseline,
      pendingDelegation: run.pendingDelegation ? comparableReceipt(run.pendingDelegation) : null,
      receipts: Array.isArray(run.receipts) ? run.receipts.map(comparableReceipt) : [],
      commitAuthorization: run.commitAuthorization,
      completionEvidence: run.completionEvidence
    } : null
  };
}

function assertTaskSnapshotShape(value: unknown, taskId: string): void {
  assert.equal(typeof value, 'string');
  assert.match(value as string, /^ws2:/u);
  const snapshot = JSON.parse(Buffer.from((value as string).slice(4), 'base64url').toString('utf8')) as {
    version: number;
    gitTree: string;
    taskFiles: Array<{ path: string; mode: number; kind: string; sha256: string }>;
  };
  assert.equal(snapshot.version, 2);
  assert.match(snapshot.gitTree, /^[a-f0-9]{40}$/u);
  assert.ok(snapshot.taskFiles.length > 0);
  for (const file of snapshot.taskFiles) {
    assert.match(file.path, new RegExp(`^\\.agents/workspace/active/${taskId}/`));
    assert.ok(Number.isInteger(file.mode));
    assert.ok(file.kind === 'file' || file.kind === 'symlink');
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  }
}

test('direct-host and sandbox executor share lifecycle, orchestration, auto-hook, and failure results', () => {
  const directFixture = taskFixture();
  const sandboxFixture = taskFixture();
  try {
    const direct = contexts(directFixture.root);
    const sandbox = contexts(sandboxFixture.root);
    const directLifecycle = dispatchTaskControlOperation(direct.direct, lifecycleOperation());
    const sandboxLifecycle = dispatchTaskControlOperation(sandbox.sandbox, lifecycleOperation());
    assert.deepEqual(comparableLifecycle(directLifecycle), comparableLifecycle(sandboxLifecycle));
    assert.equal(fs.readFileSync(path.join(directFixture.root, '.agents', 'workspace', 'blocked', TASK_ID, 'task.md'), 'utf8').includes('status: blocked'), true);
    assert.equal(fs.readFileSync(path.join(sandboxFixture.root, '.agents', 'workspace', 'blocked', TASK_ID, 'task.md'), 'utf8').includes('status: blocked'), true);

    const begin = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'begin-or-resume' as const,
      input: {
        client: 'claude-code' as const,
        maxSteps: 3,
        modelPolicy: {
          executor: { model: 'executor-model', reasoningEffort: 'high' },
          reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
        }
      },
      options: { id: () => 'run-id', now: () => '2026-08-09 01:02:03+00:00' }
    };
    const directBegin = dispatchTaskControlOperation(direct.direct, begin);
    const sandboxBegin = dispatchTaskControlOperation(sandbox.sandbox, begin);
    assert.deepEqual(sandboxBegin, directBegin);

    const autoHook = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'hook-start' as const,
      input: {
        auto: true,
        client: 'claude-code' as const,
        event: { nativeAgent: 'claude', childId: 'child', parentId: 'parent', spawnMode: 'fresh' }
      }
    };
    const directAuto = dispatchTaskControlOperation(direct.direct, autoHook);
    const sandboxAuto = dispatchTaskControlOperation(sandbox.sandbox, autoHook);
    assert.deepEqual(sandboxAuto, directAuto);
  } finally {
    fs.rmSync(directFixture.root, { recursive: true, force: true });
    fs.rmSync(sandboxFixture.root, { recursive: true, force: true });
  }
});

test('sandbox lifecycle uses the shared task lock and human override authority', () => {
  const lockFixture = taskFixture();
  try {
    const sandbox = contexts(lockFixture.root).sandbox;
    withTaskExecutionLock(lockFixture.root, TASK_ID, 'test-holder', () => {
      const result = dispatchTaskControlOperation(sandbox, lifecycleOperation());
      assert.equal((result as { error?: { code?: string } }).error?.code, 'ORCHESTRATION_LOCK_BUSY');
      assert.equal((result as { status?: string }).status, 'failed');
    });
  } finally {
    fs.rmSync(lockFixture.root, { recursive: true, force: true });
  }

  const directFixture = taskFixture(false);
  const sandboxFixture = taskFixture(false);
  try {
    const issue = (root: string, ticketId: string) => issueHumanOverride({
      taskRef: TASK_ID,
      failureId: 'lifecycle.apply:LIFECYCLE_LOG_MISSING',
      target: 'repair-task',
      operator: 'external-contributor',
      reason: 'repair the missing activity log',
      scope: 'task-lifecycle',
      intent: 'cancel',
      expiresAt: '2099-01-01 00:00:00+00:00'
    }, { repoRoot: root, randomId: () => ticketId, now: () => '2026-08-09 01:02:03+00:00' });
    assert.equal(issue(directFixture.root, 'direct-ticket').status, 'applied');
    assert.equal(issue(sandboxFixture.root, 'sandbox-ticket').status, 'applied');
    const request = {
      intent: 'cancel' as const,
      reason: 'normal cancel blocked by missing log',
      overrideTarget: 'repair-task',
      overrideScope: 'task-lifecycle'
    };
    const directResult = dispatchTaskControlOperation(
      contexts(directFixture.root).direct,
      lifecycleOperation({ ...request, overrideTicket: 'direct-ticket' })
    );
    const sandboxResult = dispatchTaskControlOperation(
      contexts(sandboxFixture.root).sandbox,
      lifecycleOperation({ ...request, overrideTicket: 'sandbox-ticket' })
    );
    assert.equal((directResult as { status: string }).status, 'applied');
    assert.equal((sandboxResult as { status: string }).status, 'applied');
    assert.equal((directResult as unknown as { humanOverride: { status: string } }).humanOverride.status, 'applied');
    assert.equal((sandboxResult as unknown as { humanOverride: { status: string } }).humanOverride.status, 'applied');
    assert.equal(fs.existsSync(path.join(directFixture.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal(fs.existsSync(path.join(sandboxFixture.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
  } finally {
    fs.rmSync(directFixture.root, { recursive: true, force: true });
    fs.rmSync(sandboxFixture.root, { recursive: true, force: true });
  }
});

test('direct-host and sandbox client transport preserve task state, receipts, snapshots, and recovery decisions', async () => {
  const directFixture = taskFixture(true, true);
  const sandbox = sandboxFixture();
  const broker = startSandboxFixtureBroker(sandbox);
  try {
    waitForHealthyStatus(sandbox.statusDir, 5_000);
    const directContext = createDirectHostExecutionContext({ repoRoot: directFixture.root });
    const begin = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'begin-or-resume' as const,
      input: {
        client: 'claude-code' as const,
        maxSteps: 3,
        modelPolicy: {
          executor: { model: 'executor-model', reasoningEffort: 'high' },
          reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
        }
      }
    };
    const directBegin = dispatchTaskControlOperation(directContext, begin);
    const sandboxBegin = runSandboxClient(sandbox, 'task-orchestration', [
      TASK_ID, 'begin-or-resume', '--client', 'claude-code', '--max-steps', '3',
      '--executor-model', 'executor-model', '--executor-reasoning-effort', 'high',
      '--reviewer-model', 'reviewer-model', '--reviewer-reasoning-effort', 'high'
    ]);
    assert.equal(sandboxBegin.status, 0, sandboxBegin.stderr);
    assert.deepEqual(comparableOrchestration(directBegin), comparableOrchestration(sandboxBegin.payload));

    const route = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'route' as const,
      input: {}
    };
    const directRoute = dispatchTaskControlOperation(directContext, route);
    const sandboxRoute = runSandboxClient(sandbox, 'task-orchestration', [TASK_ID, 'route']);
    assert.equal(sandboxRoute.status, 0, sandboxRoute.stderr);
    assert.deepEqual(comparableOrchestration(directRoute), comparableOrchestration(sandboxRoute.payload));

    const prepare = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'prepare' as const,
      input: {
        client: 'claude-code' as const,
        requestedModel: 'executor-model',
        requestedReasoningEffort: 'high'
      }
    };
    const directPrepare = dispatchTaskControlOperation(directContext, prepare);
    const sandboxPrepare = runSandboxClient(sandbox, 'task-orchestration', [
      TASK_ID, 'prepare', '--client', 'claude-code',
      '--requested-model', 'executor-model', '--requested-reasoning-effort', 'high'
    ]);
    assert.equal(sandboxPrepare.status, 0, sandboxPrepare.stderr);
    assert.deepEqual(comparableOrchestration(directPrepare), comparableOrchestration(sandboxPrepare.payload));
    const directReceipt = (directPrepare as { run?: { pendingDelegation?: Record<string, unknown> | null } }).run?.pendingDelegation;
    const sandboxReceipt = (sandboxPrepare.payload.run as { pendingDelegation?: Record<string, unknown> | null }).pendingDelegation;
    assert.ok(directReceipt);
    assert.ok(sandboxReceipt);
    assert.equal(directReceipt?.workspaceSnapshotScope, 'task');
    assert.equal(sandboxReceipt?.workspaceSnapshotScope, 'task');
    assert.equal(directReceipt?.lifecycleProvenance, null);
    assert.equal(sandboxReceipt?.lifecycleProvenance, null);
    assertTaskSnapshotShape(directReceipt?.beforeFingerprint, TASK_ID);
    assertTaskSnapshotShape(sandboxReceipt?.beforeFingerprint, TASK_ID);

    const recover = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'recover-prepared' as const,
      input: {}
    };
    const directRecover = dispatchTaskControlOperation(directContext, recover);
    const sandboxRecover = runSandboxClient(sandbox, 'task-orchestration', [TASK_ID, 'recover-prepared']);
    assert.equal(sandboxRecover.status, 0, sandboxRecover.stderr);
    assert.deepEqual(comparableOrchestration(directRecover), comparableOrchestration(sandboxRecover.payload));
    assert.equal((directRecover as { run?: { pendingDelegation?: unknown } }).run?.pendingDelegation, null);
    assert.equal((sandboxRecover.payload.run as { pendingDelegation?: unknown }).pendingDelegation, null);
    assert.equal((directRecover as { next?: unknown }).next, null);
    assert.equal((sandboxRecover.payload as { next?: unknown }).next, null);

    const advance = {
      family: 'task-orchestration' as const,
      taskRef: TASK_ID,
      intent: 'advance' as const,
      input: {}
    };
    const directAdvance = dispatchTaskControlOperation(directContext, advance);
    const sandboxAdvance = runSandboxClient(sandbox, 'task-orchestration', [TASK_ID, 'advance']);
    assert.equal(sandboxAdvance.status, 1, sandboxAdvance.stderr);
    assert.deepEqual(comparableOrchestration(directAdvance), comparableOrchestration(sandboxAdvance.payload));
    assert.equal((directAdvance as { error?: { code?: string } }).error?.code, 'ORCHESTRATION_DELEGATION_MISSING');

    const directLifecycle = dispatchTaskControlOperation(directContext, lifecycleOperation());
    const sandboxLifecycle = runSandboxClient(sandbox, 'task-lifecycle', [
      TASK_ID, 'block', '--agent', 'codex', '--reason', 'pause for dual-mode verification',
      '--unblock-condition', 'resume after verification'
    ]);
    assert.equal(sandboxLifecycle.status, 0, sandboxLifecycle.stderr);
    assert.deepEqual(comparableLifecycle(directLifecycle), comparableLifecycle(sandboxLifecycle.payload));
    assert.equal(fs.existsSync(path.join(directFixture.root, '.agents', 'workspace', 'blocked', TASK_ID, 'task.md')), true);
    assert.equal(fs.existsSync(path.join(sandbox.root, '.agents', 'workspace', 'blocked', TASK_ID, 'task.md')), true);
  } finally {
    await stopSandboxFixtureBroker(broker);
    fs.rmSync(directFixture.root, { recursive: true, force: true });
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    fs.rmSync(sandbox.controlRoot, { recursive: true, force: true });
  }
});
