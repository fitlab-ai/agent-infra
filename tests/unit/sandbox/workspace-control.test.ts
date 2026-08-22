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
import { nodeEntryArgs } from '../../../lib/sandbox/control/executor.ts';

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
    version: 2,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-lifecycle',
    args: ['08', 'complete', '--agent', 'codex']
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

test('branch-only sandboxes and incorrect tokens fail closed', () => {
  const request = {
    version: 2,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-orchestration',
    args: ['08', 'status']
  };
  assert.throws(
    () => validateSandboxControlRequest(request, { ...manifest, mode: 'branch-only', taskId: null }, { now: 2_000 }),
    /SANDBOX_CONTROL_BRANCH_ONLY: .*ai sandbox start --recreate <task-ref-or-correct-branch>/
  );
  assert.throws(
    () => validateSandboxControlRequest({ ...request, token: 'wrong' }, manifest, { now: 2_000 }),
    /REQUEST_INVALID/
  );
});

test('task-orchestration requests cannot override the manifest worktree binding', () => {
  assert.throws(() => validateSandboxControlRequest({
    version: 2,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-orchestration',
    args: ['08', 'commit-status', '--git-worktree-root', '/other']
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
      version: 2,
      id: '12345678-1234-1234-1234-123456789abc',
      token: 'secret',
      generation: 'generation-1',
      issuedAt: 1_000,
      expiresAt: 3_000,
      family: 'task-create',
      candidate
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
    version: 2,
    id: '12345678-1234-1234-1234-123456789abc',
    token: 'secret',
    generation: 'generation-1',
    issuedAt: 1_000,
    expiresAt: 3_000,
    family: 'task-lifecycle',
    args: ['08', 'status']
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
