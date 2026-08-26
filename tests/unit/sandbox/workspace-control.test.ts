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
  controlError,
  validateSandboxControlRequest,
  type SandboxControlManifest
} from '../../../lib/sandbox/control/protocol.ts';
import {
  appendSandboxControlAudit,
  cleanupStaleSandboxControlLease,
  readActiveLease,
  terminateSandboxControlExecution,
  SANDBOX_CONTROL_AUDIT_MAX_BYTES
} from '../../../lib/sandbox/control/state.ts';
import {
  acquireSandboxControlReplacement,
  assertSandboxControlCutoverSnapshot,
  beginSandboxControlReplacement,
  captureSandboxControlCutoverSnapshot,
  recoverSandboxControlReplacement,
  quiesceSandboxControlRoot,
  readSandboxControlManifest,
  readSandboxControlManifestForTransition
} from '../../../lib/sandbox/control/lifecycle.ts';
import { executeRequest, nodeEntryArgs } from '../../../lib/sandbox/control/executor.ts';
import { parseCodexControllerResult, SandboxControlClientError } from '../../../lib/sandbox/control/client.ts';
import {
  closeCodexControllerRegistration,
  CodexControllerRegistrationError,
  openCodexControllerRegistration,
  readCodexControllerRegistration,
  resolveCodexControllerBinding
} from '../../../lib/sandbox/control/controller-registration.ts';

const manifest: SandboxControlManifest = {
  version: 5,
  engine: 'docker',
  repoRoot: '/repo',
  worktreeRoot: '/worktree',
  project: 'p',
  container: 'p-dev-feature',
  containerIdentity: { id: 'container-id', labels: {} },
  branch: 'feature',
  mode: 'task-bound',
  taskId: 'TASK-20260809-010203',
  token: 'secret',
  generation: 'generation-1',
  channelDir: '/channel',
  publicStatusDir: '/public',
  processingDir: '/processing',
  runtimeDir: '/runtime'
};

const controllerBuild = {
  protocolVersion: 3,
  packageVersion: '0.9.9-alpha.0',
  internalExecutableBuildHash: 'a'.repeat(64),
  lifecycleContractHash: 'b'.repeat(64)
} as const;

test('controller registration requires a live requested process across create and replacement states', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-registration-'));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
  const requested = { pid: 200, startTime: 20 };
  const credentials = ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)];
  const opened = openCodexControllerRegistration({
    manifest,
    manifestPath,
    controllerProcess: requested,
    buildIdentity: controllerBuild
  }, {
    now: () => 1_000,
    probeProcess: () => 'alive',
    randomHex: () => credentials.shift()!
  });
  assert.equal(opened.status, 'opened');
  assert.equal(readCodexControllerRegistration(manifestPath).controllerProcess.pid, 200);
  assert.equal(fs.readFileSync(path.join(root, 'codex-controller.json'), 'utf8').includes(opened.lease.leaseSecret), false);

  closeCodexControllerRegistration({ manifest, manifestPath, proof: {
    version: 1,
    leaseId: opened.lease.leaseId,
    leaseSecret: opened.lease.leaseSecret,
    controllerProcess: requested
  } });
  for (const state of ['dead', 'unknown'] as const) {
    assert.throws(() => openCodexControllerRegistration({
      manifest,
      manifestPath,
      controllerProcess: requested,
      buildIdentity: controllerBuild
    }, {
      now: () => 1_000,
      probeProcess: () => state,
      randomHex: () => 'd'.repeat(64)
    }), state === 'dead' ? /PROCESS_INACTIVE/ : /PROCESS_UNKNOWN/);
    assert.equal(fs.existsSync(path.join(root, 'codex-controller.json')), false);
  }
});

test('controller registration replacement uses byte-equal compare before commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-registration-cas-'));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
  const first = openCodexControllerRegistration({
    manifest,
    manifestPath,
    controllerProcess: { pid: 100, startTime: 10 },
    buildIdentity: controllerBuild
  }, { now: () => 1_000, probeProcess: () => 'alive', randomHex: () => 'e'.repeat(64) });
  const registrationPath = path.join(root, 'codex-controller.json');
  const expired = { ...readCodexControllerRegistration(manifestPath), issuedAt: 0, expiresAt: 999 };
  fs.writeFileSync(registrationPath, `${JSON.stringify(expired)}\n`, { mode: 0o600 });
  assert.throws(() => openCodexControllerRegistration({
    manifest,
    manifestPath,
    controllerProcess: { pid: 200, startTime: 20 },
    buildIdentity: controllerBuild
  }, {
    now: () => 2_000,
    probeProcess: () => 'alive',
    randomHex: () => 'f'.repeat(64),
    beforeCommit: () => fs.writeFileSync(registrationPath, `${JSON.stringify({ ...expired, leaseId: first.lease.leaseId.slice(0, -1) + '0' })}\n`, { mode: 0o600 })
  }), /OWNERSHIP_LOST/);
  assert.equal(readCodexControllerRegistration(manifestPath).controllerProcess.pid, 100);
});

test('controller registration covers every existing and requested process state without unsafe mutation', () => {
  const existingStates = ['missing', 'alive', 'expired', 'dead', 'unknown', 'invalid'] as const;
  const requestedStates = ['alive', 'dead', 'zombie', 'unknown'] as const;
  for (const existingState of existingStates) {
    for (const requestedState of requestedStates) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `controller-matrix-${existingState}-${requestedState}-`));
      const manifestPath = path.join(root, 'manifest.json');
      const file = path.join(root, 'codex-controller.json');
      fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
      if (existingState !== 'missing') {
        const seedValues = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
        openCodexControllerRegistration({
          manifest,
          manifestPath,
          controllerProcess: { pid: 100, startTime: 10 },
          buildIdentity: controllerBuild
        }, { now: () => 1_000, probeProcess: () => 'alive', randomHex: () => seedValues.shift()! });
        if (existingState === 'expired') {
          const value = readCodexControllerRegistration(manifestPath);
          fs.writeFileSync(file, `${JSON.stringify({ ...value, issuedAt: 0, expiresAt: 999 })}\n`, { mode: 0o600 });
        } else if (existingState === 'invalid') {
          fs.writeFileSync(file, `${JSON.stringify({ ...readCodexControllerRegistration(manifestPath), extra: true })}\n`, { mode: 0o600 });
        }
      }
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const values = ['4'.repeat(64), '5'.repeat(64), '6'.repeat(64)];
      const attempt = () => openCodexControllerRegistration({
        manifest,
        manifestPath,
        controllerProcess: { pid: 200, startTime: 20 },
        buildIdentity: controllerBuild
      }, {
        now: () => 2_000,
        randomHex: () => values.shift()!,
        probeProcess: (identity) => identity.pid === 100
          ? existingState === 'alive' ? 'alive' : existingState === 'unknown' ? 'unknown' : 'dead'
          : requestedState === 'alive' ? 'alive' : requestedState === 'unknown' ? 'unknown' : 'dead'
      });
      const succeeds = requestedState === 'alive'
        && (existingState === 'missing' || existingState === 'expired' || existingState === 'dead');
      if (succeeds) {
        assert.equal(attempt().status, 'opened', `${existingState}/${requestedState}`);
        assert.equal(readCodexControllerRegistration(manifestPath).controllerProcess.pid, 200);
      } else {
        assert.throws(attempt, Error, `${existingState}/${requestedState}`);
        assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, `${existingState}/${requestedState}`);
      }
    }
  }
});

test('controller proof failures preserve the host registration', () => {
  const cases = [
    ['wrong-secret', 'CODEX_SANDBOX_CONTROLLER_PROOF_INVALID'],
    ['expired', 'CODEX_SANDBOX_CONTROLLER_LEASE_EXPIRED'],
    ['cross-task', 'CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID'],
    ['cross-generation', 'CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID'],
    ['cross-container', 'CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID'],
    ['cross-build', 'CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID'],
    ['cross-process', 'CODEX_SANDBOX_CONTROLLER_PROOF_INVALID'],
    ['dead-process', 'CODEX_SANDBOX_CONTROLLER_PROCESS_INACTIVE'],
    ['unknown-process', 'CODEX_SANDBOX_CONTROLLER_PROCESS_UNKNOWN']
  ] as const;
  for (const [scenario, expectedCode] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `controller-proof-${scenario}-`));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
    const values = ['7'.repeat(64), '8'.repeat(64), '9'.repeat(64)];
    const opened = openCodexControllerRegistration({
      manifest,
      manifestPath,
      controllerProcess: { pid: 100, startTime: 10 },
      buildIdentity: controllerBuild
    }, { now: () => 1_000, probeProcess: () => 'alive', randomHex: () => values.shift()! });
    const file = path.join(root, 'codex-controller.json');
    const before = fs.readFileSync(file, 'utf8');
    const proof = {
      version: 1 as const,
      leaseId: opened.lease.leaseId,
      leaseSecret: scenario === 'wrong-secret' ? '0'.repeat(64) : opened.lease.leaseSecret,
      controllerProcess: scenario === 'cross-process'
        ? { pid: 101, startTime: 10 }
        : opened.lease.controllerProcess
    };
    const candidateManifest = scenario === 'cross-task'
      ? { ...manifest, taskId: 'TASK-20260809-999999' }
      : scenario === 'cross-generation'
        ? { ...manifest, generation: 'other-generation' }
        : scenario === 'cross-container'
          ? { ...manifest, containerIdentity: { ...manifest.containerIdentity, id: 'other-container' } }
          : manifest;
    assert.throws(() => resolveCodexControllerBinding({
      manifest: candidateManifest,
      manifestPath,
      proof,
      buildIdentity: scenario === 'cross-build'
        ? { ...controllerBuild, lifecycleContractHash: '0'.repeat(64) }
        : controllerBuild,
      now: scenario === 'expired' ? 14_402_000 : 2_000,
      probeProcess: () => scenario === 'dead-process' ? 'dead' : scenario === 'unknown-process' ? 'unknown' : 'alive'
    }), new RegExp(expectedCode));
    assert.equal(fs.readFileSync(file, 'utf8'), before, scenario);
  }
});

test('controller proof rejection occurs before the domain child and workspace mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-proof-executor-'));
  const sentinel = path.join(root, 'workspace-sentinel');
  fs.writeFileSync(sentinel, 'unchanged\n');
  const proof = {
    version: 1 as const,
    leaseId: '7'.repeat(64),
    leaseSecret: '8'.repeat(64),
    controllerProcess: { pid: 100, startTime: 10 }
  };
  for (const code of [
    'CODEX_SANDBOX_CONTROLLER_PROOF_INVALID',
    'CODEX_SANDBOX_CONTROLLER_LEASE_EXPIRED',
    'CODEX_SANDBOX_CONTROLLER_REGISTRATION_INVALID',
    'CODEX_SANDBOX_CONTROLLER_PROCESS_INACTIVE',
    'CODEX_SANDBOX_CONTROLLER_PROCESS_UNKNOWN'
  ]) {
    let spawns = 0;
    const request = {
      version: 3 as const,
      id: '12345678-1234-1234-1234-123456789abc',
      token: manifest.token,
      generation: manifest.generation,
      issuedAt: 1_000,
      expiresAt: 3_000,
      family: 'task-orchestration' as const,
      args: [manifest.taskId!, 'prepare', '--client', 'codex'],
      controllerProcess: null,
      controllerProof: proof
    };
    const result = executeRequest(manifest, path.join(root, 'manifest.json'), request, {
      buildIdentity: () => controllerBuild,
      resolveControllerBinding: (() => { throw new CodexControllerRegistrationError(code, 'rejected'); }) as never,
      spawnDomain: (() => { spawns += 1; throw new Error('domain child must not spawn'); }) as never
    });
    assert.equal(result.exitCode, 1, code);
    assert.match(result.stdout, new RegExp(code), code);
    assert.equal(spawns, 0, code);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n', code);
  }
  let missingProofSpawns = 0;
  const missingProof = executeRequest(manifest, path.join(root, 'manifest.json'), {
    version: 3,
    id: '12345678-1234-1234-1234-123456789abd',
    token: manifest.token,
    generation: manifest.generation,
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-orchestration',
    args: [manifest.taskId!, 'prepare', '--client', 'codex'],
    controllerProcess: null,
    controllerProof: null
  }, { spawnDomain: (() => { missingProofSpawns += 1; }) as never });
  assert.match(missingProof.stdout, /CODEX_SANDBOX_CONTROLLER_PROOF_REQUIRED/);
  assert.equal(missingProofSpawns, 0);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n');
});

test('TypeScript control entries retain explicit strip-types startup', () => {
  assert.deepEqual(nodeEntryArgs('/repo/bin/internal-cli.ts', ['sandbox-control', 'serve']), [
    '--experimental-strip-types', '--no-warnings', '/repo/bin/internal-cli.ts', 'sandbox-control', 'serve'
  ]);
  assert.deepEqual(nodeEntryArgs('/repo/dist/bin/internal-cli.js', ['sandbox-control', 'serve']), [
    '/repo/dist/bin/internal-cli.js', 'sandbox-control', 'serve'
  ]);
});

test('control requests are restricted to allowed families and rebound to the manifest task', () => {
  const request = validateSandboxControlRequest({
    version: 3,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-lifecycle',
    args: ['08', 'complete', '--agent', 'codex'],
    controllerProcess: null,
    controllerProof: null
  }, manifest, { now: 2_000 });
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

test('task finalization uses a typed task-bound request with manifest authority', () => {
  const request = validateSandboxControlRequest({
    version: 3,
    id: '12345678-1234-1234-1234-123456789abc',
    token: manifest.token,
    generation: manifest.generation,
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-finalization',
    operation: 'complete',
    agent: 'codex',
    args: [],
    controllerProcess: null,
    controllerProof: null
  }, manifest, { now: 2_000 });
  assert.equal(request.family, 'task-finalization');
  assert.equal(request.operation, 'complete');
  assert.equal(request.agent, 'codex');
  assert.deepEqual(request.args, []);
  assert.throws(() => bindSandboxControlTask(request, manifest.taskId!), /REQUEST_INVALID/);
  assert.throws(() => validateSandboxControlRequest({ ...request, args: ['TASK-20260809-999999'] }, manifest, { now: 2_000 }), /REQUEST_INVALID/);
  assert.throws(() => validateSandboxControlRequest({ ...request, operation: 'status' }, manifest, { now: 2_000 }), /REQUEST_INVALID/);
  assert.throws(() => validateSandboxControlRequest({ ...request, repoRoot: '/untrusted' }, manifest, { now: 2_000 }), /REQUEST_INVALID/);
  assert.throws(() => validateSandboxControlRequest(request, { ...manifest, mode: 'branch-only', taskId: null }, { now: 2_000 }), /SANDBOX_CONTROL_BRANCH_ONLY/);
});

test('sandbox executor finalizes only the manifest task and returns no control authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-executor-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  try {
    fs.mkdirSync(path.join(taskDir), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ prFlow: 'disabled', task: { shortIdLength: 2 } }));
    fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': taskId } })}\n`);
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
      skill: 'complete-task', checks: { 'review-ledger': null, 'manual-validation': {}, 'post-review-commit': null, 'platform-sync-preflight': null, 'required-pr-delivery': null }
    }));
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'status: active', 'current_step: code-review', 'updated_at: old', 'agent_infra_version: old', 'target_date:', '---',
      '', '# Task', '', '## Activity Log', ''
    ].join('\n'));
    const result = executeRequest({
      ...manifest,
      repoRoot: root,
      worktreeRoot: root,
      taskId,
      runtimeDir: path.join(root, 'runtime')
    }, path.join(root, 'manifest.json'), {
      version: 3,
      id: '12345678-1234-1234-1234-123456789abc',
      token: manifest.token,
      generation: manifest.generation,
      issuedAt: 1_000,
      expiresAt: 3_000,
      family: 'task-finalization',
      operation: 'complete',
      agent: 'codex',
      args: [],
      controllerProcess: null,
      controllerProof: null
    });
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'completed');
    assert.equal(payload.accepted, true);
    assert.equal(result.stdout.includes(manifest.token), false);
    assert.equal(result.stdout.includes(root), false);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'completed', taskId, 'task.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control protocol rejects request v2 and controller result parser enforces exact wire phases', () => {
  const request = {
    version: 3,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-lifecycle',
    args: ['08', 'status'],
    controllerProcess: null,
    controllerProof: null
  };
  assert.throws(() => validateSandboxControlRequest({ ...request, version: 2 }, manifest, { now: 2_000 }), /REQUEST_INVALID/);
  const opened = {
    version: 1,
    status: 'opened',
    changed: true,
    lease: {
      version: 1,
      leaseId: 'c'.repeat(64),
      leaseSecret: 'd'.repeat(64),
      taskId: manifest.taskId!,
      controlGeneration: manifest.generation,
      controllerInstanceDigest: 'e'.repeat(64),
      controllerProcess: { pid: 200, startTime: 20 },
      buildIdentity: controllerBuild,
      issuedAt: 1_000,
      expiresAt: 2_000
    },
    error: null
  };
  const response = {
    version: 2 as const,
    id: request.id,
    phase: 'completed' as const,
    exitCode: 0,
    stdout: `${JSON.stringify(opened)}\n`,
    stderr: '',
    error: null
  };
  assert.equal(parseCodexControllerResult(response).status, 'opened');
  assert.throws(
    () => parseCodexControllerResult({ ...response, stdout: `${JSON.stringify({ ...opened, extra: true })}\n` }),
    (error: unknown) => error instanceof SandboxControlClientError && error.detail.code === 'SANDBOX_CONTROL_RESULT_INVALID'
  );
  assert.throws(() => parseCodexControllerResult({ ...response, exitCode: 1 }), /controller success result is invalid/);
});

test('branch-only sandboxes and incorrect tokens fail closed', () => {
  const request = {
    version: 3,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-orchestration',
    args: ['08', 'status'],
    controllerProcess: null,
    controllerProof: null
  };
  assert.throws(
    () => validateSandboxControlRequest(request, { ...manifest, mode: 'branch-only', taskId: null }, { now: 2_000 }),
    /SANDBOX_CONTROL_BRANCH_ONLY: .*ai sandbox start --recreate <task-ref-or-correct-branch>/
  );
  assert.throws(
    () => validateSandboxControlRequest({ ...request, token: 'wrong' }, manifest, { now: 2_000 }),
    /REQUEST_INVALID/
  );
  const branchManifest = { ...manifest, mode: 'branch-only' as const, taskId: null };
  assert.throws(() => validateSandboxControlRequest({
    ...request,
    family: 'codex-controller',
    command: 'open',
    args: [],
    controllerProcess: { pid: 100, startTime: 10 },
    controllerProof: null
  }, branchManifest, { now: 2_000 }), /SANDBOX_CONTROL_BRANCH_ONLY/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-controller-denied-'));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
  assert.throws(() => openCodexControllerRegistration({
    manifest: branchManifest,
    manifestPath,
    controllerProcess: { pid: 100, startTime: 10 },
    buildIdentity: controllerBuild
  }, { probeProcess: () => 'alive' }), /SANDBOX_CONTROL_BRANCH_ONLY/);
  const proof = {
    version: 1 as const,
    leaseId: '7'.repeat(64),
    leaseSecret: '8'.repeat(64),
    controllerProcess: { pid: 100, startTime: 10 }
  };
  assert.throws(() => closeCodexControllerRegistration({
    manifest: branchManifest, manifestPath, proof
  }), /SANDBOX_CONTROL_BRANCH_ONLY/);
  assert.throws(() => resolveCodexControllerBinding({
    manifest: branchManifest,
    manifestPath,
    proof,
    buildIdentity: controllerBuild,
    probeProcess: () => 'alive'
  }), /SANDBOX_CONTROL_BRANCH_ONLY/);
  assert.equal(fs.existsSync(path.join(root, 'codex-controller.json')), false);
});

test('task-orchestration requests cannot override the manifest worktree binding', () => {
  assert.throws(() => validateSandboxControlRequest({
    version: 3,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-orchestration',
    args: ['08', 'status', '--git-worktree-root', '/other'],
    controllerProcess: null,
    controllerProof: null
  }, manifest, { now: 2_000 }), /REQUEST_INVALID/);
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
      version: 3,
      id: '12345678-1234-1234-1234-123456789abc',
      token: 'secret',
      generation: 'generation-1',
      issuedAt: 1_000,
      expiresAt: 3_000,
      family: 'task-create',
      candidate,
      controllerProcess: null,
      controllerProof: null
    }, { ...manifest, mode, taskId: mode === 'task-bound' ? manifest.taskId : null }, { now: 2_000 });
    assert.equal(request.family, 'task-create');
    assert.equal(request.candidate.title, candidate.title);
  }
});

test('control broker ownership is acquired exclusively', async () => {
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
  const publicStatusDir = path.join(root, 'public');
  const processingDir = path.join(root, 'processing');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(channelDir, { recursive: true });
  fs.mkdirSync(publicStatusDir);
  fs.mkdirSync(processingDir);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest, repoRoot: root, worktreeRoot: root, branch, channelDir, publicStatusDir, processingDir,
    runtimeDir: path.join(root, 'runtime')
  })}\n`);
  fs.writeFileSync(path.join(root, 'broker.json'), '{}\n');
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      serveSandboxControl(manifestPath, controller.signal),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control broker rejects legacy manifests with container-only recreation guidance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-legacy-manifest-'));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: 1, worktreeRoot: undefined })}\n`);
  try {
    await assert.rejects(
      serveSandboxControl(manifestPath),
      /SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 5; container-only recreation is required/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement lease serializes generation cutover and transition reader isolates v4 compatibility', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-replacement-'));
  const manifestPath = path.join(root, 'manifest.json');
  const legacy = {
    ...manifest,
    version: 4,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: path.join(root, 'channel'),
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing')
  };
  fs.mkdirSync(legacy.channelDir, { recursive: true });
  fs.mkdirSync(legacy.publicStatusDir);
  fs.mkdirSync(legacy.processingDir);
  fs.writeFileSync(manifestPath, `${JSON.stringify(legacy)}\n`);
  const lease = acquireSandboxControlReplacement(root);
  try {
    assert.throws(() => acquireSandboxControlReplacement(root), /SANDBOX_CONTROL_REPLACEMENT_BUSY/);
    assert.equal(readSandboxControlManifestForTransition(manifestPath).version, 4);
    assert.throws(() => readSandboxControlManifest(manifestPath), /SANDBOX_CONTROL_MANIFEST_VERSION_INVALID/);
    lease.assertOwned();
  } finally {
    lease.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement owner lookup failures fail closed instead of reclaiming the lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-owner-unknown-'));
  const lease = acquireSandboxControlReplacement(root);
  try {
    assert.throws(
      () => acquireSandboxControlReplacement(root, { probeOwner: () => 'unknown' }),
      /SANDBOX_CONTROL_REPLACEMENT_OWNER_UNAVAILABLE/
    );
  } finally {
    lease.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement cutover restores the previous root after materialization failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recovery-'));
  const manifestPath = path.join(root, 'manifest.json');
  const oldManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: path.join(root, 'channel'),
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    runtimeDir: path.join(root, 'runtime')
  };
  for (const directory of [oldManifest.channelDir, oldManifest.publicStatusDir, oldManifest.processingDir, oldManifest.runtimeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(oldManifest)}\n`);
  const lease = acquireSandboxControlReplacement(root);
  try {
    beginSandboxControlReplacement(root, lease);
    fs.writeFileSync(manifestPath, '{"version":5}\n');
    await recoverSandboxControlReplacement(root, lease);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), oldManifest);
    const snapshot = captureSandboxControlCutoverSnapshot(root);
    assert.doesNotThrow(() => assertSandboxControlCutoverSnapshot(snapshot));
  } finally {
    lease.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement recovery restores a root that disappeared after the snapshot was prepared', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-recovery-window-'));
  const manifestPath = path.join(root, 'manifest.json');
  const oldManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: path.join(root, 'channel'),
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    runtimeDir: path.join(root, 'runtime')
  };
  for (const directory of [oldManifest.channelDir, oldManifest.publicStatusDir, oldManifest.processingDir, oldManifest.runtimeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(oldManifest)}\n`);
  const firstLease = acquireSandboxControlReplacement(root);
  let replacementLease: ReturnType<typeof acquireSandboxControlReplacement> | null = null;
  try {
    beginSandboxControlReplacement(root, firstLease);
    fs.rmSync(root, { recursive: true, force: true });
    replacementLease = acquireSandboxControlReplacement(root);
    assert.equal(await recoverSandboxControlReplacement(root, replacementLease), 'restored');
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), oldManifest);
  } finally {
    replacementLease?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control quiesce fails closed when broker identity is unknown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-quiesce-unknown-'));
  const controlManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: path.join(root, 'channel'),
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    runtimeDir: path.join(root, 'runtime')
  };
  for (const directory of [controlManifest.channelDir, controlManifest.publicStatusDir, controlManifest.processingDir, controlManifest.runtimeDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(controlManifest)}\n`);
  fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({
    version: 3,
    pid: process.pid,
    startTime: 1,
    brokerId: 'unknown-broker',
    token: controlManifest.token,
    generation: controlManifest.generation
  })}\n`);
  try {
    await assert.rejects(
      () => quiesceSandboxControlRoot(root, { identityProbe: () => 'unknown', timeoutMs: 100 }),
      /SANDBOX_CONTROL_OWNER_UNAVAILABLE/
    );
    assert.equal(fs.existsSync(path.join(root, 'broker.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cutover snapshot detects replaced generation evidence before materialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-snapshot-'));
  try {
    const snapshot = captureSandboxControlCutoverSnapshot(root);
    fs.writeFileSync(path.join(root, 'broker.json'), 'changed\n');
    assert.throws(() => assertSandboxControlCutoverSnapshot(snapshot), /SANDBOX_CONTROL_OWNER_TRANSITION/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control request deadline and generation fail closed', () => {
  const request = {
    version: 3,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-lifecycle',
    args: ['08', 'status'],
    controllerProcess: null,
    controllerProof: null
  };
  assert.throws(
    () => validateSandboxControlRequest(request, manifest, { now: 3_001 }),
    /SANDBOX_CONTROL_REQUEST_EXPIRED/
  );
  assert.throws(
    () => validateSandboxControlRequest({ ...request, generation: 'stale' }, manifest, { now: 2_000 }),
    /SANDBOX_CONTROL_GENERATION_INVALID/
  );
  assert.throws(
    () => validateSandboxControlRequest({ ...request, expiresAt: 3_001 }, manifest, { now: 2_000 }),
    /SANDBOX_CONTROL_REQUEST_DEADLINE_INVALID/
  );
});

test('pre-acceptance state errors expose the explicit retry contract', () => {
  for (const code of [
    'SANDBOX_CONTROL_BUSY',
    'SANDBOX_CONTROL_HANDOFF_ACTIVE',
    'SANDBOX_CONTROL_REQUEST_EXPIRED',
    'SANDBOX_WORKTREE_BINDING_LOST'
  ]) {
    assert.deepEqual(controlError(new Error(code)), { code, message: code, retryable: true });
  }
  assert.equal(controlError(new Error('SANDBOX_CONTROL_REQUEST_REPLAYED')).retryable, false);
  assert.equal(controlError(new Error('SANDBOX_CONTROL_RESULT_UNKNOWN')).retryable, false);
});

test('control audit rotates at its fixed bound without recording manifest authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-audit-'));
  const auditManifest = {
    ...manifest,
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    channelDir: path.join(root, 'channel')
  };
  fs.mkdirSync(auditManifest.publicStatusDir, { recursive: true });
  const auditPath = path.join(root, 'audit.ndjson');
  fs.writeFileSync(auditPath, Buffer.alloc(SANDBOX_CONTROL_AUDIT_MAX_BYTES, 0x20));
  try {
    appendSandboxControlAudit(auditManifest, 'broker-state', { state: 'healthy' });
    assert.equal(fs.statSync(`${auditPath}.1`).size, SANDBOX_CONTROL_AUDIT_MAX_BYTES);
    const active = fs.readFileSync(auditPath, 'utf8');
    assert.match(active, /"event":"broker-state"/);
    assert.doesNotMatch(active, /secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale lease cleanup removes only a matching expired lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-lease-'));
  const leaseManifest = {
    ...manifest,
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    channelDir: path.join(root, 'channel')
  };
  fs.mkdirSync(leaseManifest.publicStatusDir, { recursive: true });
  const leasePath = path.join(root, 'lease.json');
  fs.writeFileSync(leasePath, `${JSON.stringify({
    version: 2,
    generation: leaseManifest.generation,
    nonce: 'lease-nonce',
    owner: { pid: process.pid, startTime: 0 },
    issuedAt: 1,
    expiresAt: 2,
    taskId: leaseManifest.taskId,
    branch: leaseManifest.branch,
    reason: 'manual-validation'
  })}\n`);
  try {
    assert.equal(cleanupStaleSandboxControlLease(leaseManifest, 3), true);
    assert.equal(fs.existsSync(leasePath), false);
    fs.writeFileSync(leasePath, `${JSON.stringify({
      version: 2,
      generation: 'previous-generation',
      nonce: 'stale-generation',
      owner: { pid: process.pid, startTime: 0 },
      issuedAt: 3,
      expiresAt: 30,
      taskId: leaseManifest.taskId,
      branch: leaseManifest.branch,
      reason: 'manual-validation'
    })}\n`);
    assert.equal(readActiveLease(leaseManifest, 4), null);
    assert.equal(cleanupStaleSandboxControlLease(leaseManifest, 4), true);
    assert.equal(fs.existsSync(leasePath), false);
    fs.writeFileSync(leasePath, '{}\n');
    assert.throws(() => cleanupStaleSandboxControlLease(leaseManifest, 3), /SANDBOX_CONTROL_LEASE_INVALID/);
    assert.equal(fs.existsSync(leasePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale lease cleanup retains evidence when owner identity is unknown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-control-lease-unknown-'));
  const leaseManifest = {
    ...manifest,
    publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing'),
    channelDir: path.join(root, 'channel')
  };
  fs.mkdirSync(leaseManifest.publicStatusDir, { recursive: true });
  const leasePath = path.join(root, 'lease.json');
  fs.writeFileSync(leasePath, `${JSON.stringify({
    version: 2,
    generation: leaseManifest.generation,
    nonce: 'unknown-owner',
    owner: { pid: process.pid, startTime: 1 },
    issuedAt: 1,
    expiresAt: 2,
    taskId: leaseManifest.taskId,
    branch: leaseManifest.branch,
    reason: 'manual-validation'
  })}\n`);
  try {
    assert.throws(
      () => cleanupStaleSandboxControlLease(leaseManifest, 3, { identityProbe: () => 'unknown' }),
      /SANDBOX_CONTROL_LEASE_OWNER_UNAVAILABLE/
    );
    assert.equal(fs.existsSync(leasePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution termination fails closed when child identity is unknown', () => {
  assert.throws(
    () => terminateSandboxControlExecution({
      version: 2,
      generation: 'generation-1',
      requestId: 'unknown-execution',
      nonce: 'unknown-execution-nonce',
      child: { pid: process.pid, startTime: 1, processGroupId: null },
      phase: 'running',
      updatedAt: Date.now()
    }, { identityProbe: () => 'unknown' }),
    /SANDBOX_CONTROL_EXECUTION_OWNER_UNAVAILABLE/
  );
});
