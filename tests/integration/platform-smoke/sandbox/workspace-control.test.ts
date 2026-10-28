import { taskWorkspaceRoot } from '../../../helpers.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getProcessStartTime } from '../../../../lib/server/process-state.ts';
import { sandboxControlSafeEnv } from '../../../../lib/sandbox/control/server.ts';
import {
  serveSandboxControl,
  writeSandboxControlResponse
} from '../../../../lib/sandbox/control/server.ts';
import {
  bindSandboxControlTask,
  controlError,
  parseSandboxControlResultEvidence,
  SANDBOX_CONTROL_MAX_LOGICAL_RECORDS,
  SANDBOX_CONTROL_MAX_RESPONSE_BYTES,
  SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES,
  SANDBOX_CONTROL_RESERVATION_BYTES,
  validateSandboxControlRequest,
  type SandboxControlManifest,
} from '../../../../lib/sandbox/control/protocol.ts';
import {
  appendSandboxControlAudit,
  cleanupStaleSandboxControlLease,
  readActiveLease,
  readSandboxControlPayload,
  readSandboxControlResultEvidence,
  resultEvidencePath,
  sandboxControlEncodedJsonBytes,
  sandboxControlGenerationUsage,
  sanitizeSandboxControlOutput,
  terminateSandboxControlExecution,
  writeSandboxControlPayload,
  writeSandboxControlReservation,
  writeSandboxControlResultEvidence,
  SANDBOX_CONTROL_AUDIT_MAX_BYTES
} from '../../../../lib/sandbox/control/state.ts';
import {
  acquireSandboxControlReplacement,
  assertSandboxControlBrokerOwner,
  assertSandboxControlCutoverSnapshot,
  beginSandboxControlReplacement,
  captureSandboxControlCutoverSnapshot,
  recoverSandboxControlReplacement,
  quiesceSandboxControlRoot,
  readSandboxControlManifest,
} from '../../../../lib/sandbox/control/lifecycle.ts';
import {
  assertSandboxControlExecutorAuthority,
  executeRequest,
  nodeEntryArgs
} from '../../../../lib/sandbox/control/executor.ts';
import { createTask } from '../../../../lib/task/create-service.ts';
import '../../../../lib/sandbox/control/client.ts';
import { writeSandboxControlIdentitySentinel } from '../../../../lib/sandbox/control/identity-sentinel.ts';
import { finalizeSandboxControlManifest } from '../../../../lib/sandbox/workspace-view.ts';
import { createTempDir, onPlatforms, taskWorkspaceProject } from '../../../helpers.ts';

const manifest: SandboxControlManifest = {
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
  controlRootId: 'a'.repeat(96),
  channelDir: '/channel',
  publicStatusDir: '/public',
  processingDir: '/processing',
  runtimeDir: '/runtime'
};

test('sandbox result evidence is strict, durable, and metadata-only', () => {
  const root = createTempDir('sandbox-result-evidence-');
  const boundManifest = {
    ...manifest,
    processingDir: path.join(root, 'processing')
  };
  const requestId = '0123456789abcdef0123456789abcdef';
  const result = {
    exitCode: 7,
    stdout: `private ${manifest.token} stdout`,
    stderr: 'private stderr'
  };

  const evidence = writeSandboxControlResultEvidence(boundManifest, requestId, result);

  assert.deepEqual(readSandboxControlResultEvidence(resultEvidencePath(boundManifest, requestId)), evidence);
  const persisted = fs.readFileSync(resultEvidencePath(boundManifest, requestId), 'utf8');
  assert.doesNotMatch(persisted, /private stdout|private stderr|secret/);
  assert.equal(evidence.captureState, 'metadata-only');
  assert.equal(sanitizeSandboxControlOutput(manifest, result.stdout), 'private [REDACTED] stdout');
  assert.equal(evidence.stdoutBytes, Buffer.byteLength(sanitizeSandboxControlOutput(manifest, result.stdout), 'utf8'));
  assert.match(evidence.stdoutSha256, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => parseSandboxControlResultEvidence({ ...evidence, stdout: result.stdout }),
    /SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID/
  );
  assert.throws(
    () => writeSandboxControlResultEvidence(boundManifest, requestId, result),
    /SANDBOX_CONTROL_RESULT_EVIDENCE_ALREADY_EXISTS/
  );
});

test('sandbox payload and reservation records enforce generation accounting and output redaction', () => {
  const root = createTempDir('sandbox-capacity-');
  const boundManifest = {
    ...manifest,
    token: 'capacity-secret',
    channelDir: path.join(root, 'channel'),
    processingDir: path.join(root, 'processing')
  };
  const requestId = '0123456789abcdef0123456789abcdef';
  fs.mkdirSync(path.join(boundManifest.channelDir, 'responses'), { recursive: true });
  fs.mkdirSync(path.join(boundManifest.processingDir, requestId), { recursive: true });
  try {
    const reservation = writeSandboxControlReservation(boundManifest, requestId, { logicalRecords: 0, bytes: 0 });
    assert.equal(reservation.logicalRecords, 1);
    assert.equal(sandboxControlGenerationUsage(boundManifest).logicalRecords, 1);
    const payload = writeSandboxControlPayload(boundManifest, requestId, {
      stdout: `printed ${boundManifest.token}\n`, stderr: ''
    });
    writeSandboxControlResultEvidence(boundManifest, requestId, {
      exitCode: 0, stdout: `printed ${boundManifest.token}\n`, stderr: ''
    });
    assert.equal(readSandboxControlPayload(path.join(boundManifest.channelDir, 'responses', `${requestId}.payload.json`)).stdout, 'printed [REDACTED]\n');
    assert.equal(payload.stdoutBytes, Buffer.byteLength(payload.stdout, 'utf8'));
    assert.equal(sandboxControlGenerationUsage(boundManifest).logicalRecords, 1);
    assert.equal(
      sandboxControlGenerationUsage(boundManifest).bytes,
      reservation.bytes + sandboxControlEncodedJsonBytes(payload)
    );
    assert.throws(
      () => writeSandboxControlReservation(boundManifest, 'fedcba9876543210fedcba9876543210', {
        logicalRecords: 1024, bytes: 0
      }),
      /CAPACITY_EXHAUSTED/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox terminal publication redacts output before durable write', () => {
  const root = createTempDir('sandbox-terminal-redaction-');
  const boundManifest = {
    ...manifest,
    token: 'terminal-secret',
    channelDir: path.join(root, 'channel')
  };
  const requestId = 'abcdefabcdefabcdefabcdefabcdefab';
  fs.mkdirSync(path.join(boundManifest.channelDir, 'responses'), { recursive: true });
  try {
    writeSandboxControlResponse(boundManifest, {
      version: 2, id: requestId, phase: 'completed', exitCode: 0,
      stdout: `result ${boundManifest.token}\n`, stderr: `error ${boundManifest.token}\n`, error: null
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(boundManifest.channelDir, 'responses', `${requestId}.json`), 'utf8')) as Record<string, string>;
    assert.equal(persisted.stdout, 'result [REDACTED]\n');
    assert.equal(persisted.stderr, 'error [REDACTED]\n');
    assert.doesNotMatch(JSON.stringify(persisted), /terminal-secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox terminal duplicate is accepted only after strict read-back', () => {
  const root = createTempDir('sandbox-terminal-duplicate-');
  const boundManifest = {
    ...manifest,
    channelDir: path.join(root, 'channel')
  };
  const requestId = 'abcdefabcdefabcdefabcdefabcdefab';
  const response = {
    version: 2 as const, id: requestId, phase: 'completed' as const, exitCode: 0,
    stdout: 'stable\n', stderr: '', error: null
  };
  fs.mkdirSync(path.join(boundManifest.channelDir, 'responses'), { recursive: true });
  try {
    writeSandboxControlResponse(boundManifest, response);
    assert.doesNotThrow(() => writeSandboxControlResponse(boundManifest, response));
    assert.throws(
      () => writeSandboxControlResponse(boundManifest, { ...response, stdout: 'forged\n' }),
      /SANDBOX_CONTROL_TERMINAL_CONFLICT/
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(boundManifest.channelDir, 'responses', `${requestId}.json`), 'utf8')).stdout,
      'stable\n'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox terminal size includes the persisted newline at the exact boundary', () => {
  const root = createTempDir('sandbox-terminal-boundary-');
  const boundManifest = {
    ...manifest,
    channelDir: path.join(root, 'channel')
  };
  const requestId = 'fedcba9876543210fedcba9876543210';
  const base = {
    version: 2 as const, id: requestId, phase: 'completed' as const, exitCode: 0,
    stdout: '', stderr: '', error: null
  };
  const emptyBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const exact = { ...base, stdout: 'x'.repeat(SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES - emptyBytes) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES);
  assert.equal(sandboxControlEncodedJsonBytes(exact), SANDBOX_CONTROL_MAX_TERMINAL_RECORD_BYTES + 1);
  fs.mkdirSync(path.join(boundManifest.channelDir, 'responses'), { recursive: true });
  try {
    writeSandboxControlResponse(boundManifest, exact);
    const persisted = JSON.parse(fs.readFileSync(path.join(boundManifest.channelDir, 'responses', `${requestId}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(persisted.stdout, '');
    assert.equal(persisted.error && typeof persisted.error === 'object' && 'code' in persisted.error, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox generation quota counts retained records once and rejects byte overflow after restart scan', () => {
  const root = createTempDir('sandbox-generation-quota-');
  const boundManifest = {
    ...manifest,
    channelDir: path.join(root, 'channel'),
    processingDir: path.join(root, 'processing')
  };
  const responsesDir = path.join(boundManifest.channelDir, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  try {
    for (let index = 0; index < SANDBOX_CONTROL_MAX_LOGICAL_RECORDS - 1; index += 1) {
      const id = index.toString(16).padStart(32, '0');
      fs.writeFileSync(path.join(responsesDir, `${id}.json`), `${JSON.stringify({ version: 2, id, phase: 'completed', exitCode: 0 })}\n`);
    }
    assert.equal(sandboxControlGenerationUsage(boundManifest).logicalRecords, SANDBOX_CONTROL_MAX_LOGICAL_RECORDS - 1);
    const finalId = (SANDBOX_CONTROL_MAX_LOGICAL_RECORDS - 1).toString(16).padStart(32, '0');
    writeSandboxControlReservation(boundManifest, finalId, sandboxControlGenerationUsage(boundManifest));
    assert.equal(sandboxControlGenerationUsage(boundManifest).logicalRecords, SANDBOX_CONTROL_MAX_LOGICAL_RECORDS);
    assert.throws(
      () => writeSandboxControlReservation(boundManifest, 'fedcba9876543210fedcba9876543210', sandboxControlGenerationUsage(boundManifest)),
      /SANDBOX_CONTROL_CAPACITY_EXHAUSTED/
    );

    const byteRoot = createTempDir('sandbox-byte-quota-');
    const byteManifest = {
      ...manifest,
      channelDir: path.join(byteRoot, 'channel'),
      processingDir: path.join(byteRoot, 'processing')
    };
    try {
      const byteResponses = path.join(byteManifest.channelDir, 'responses');
      fs.mkdirSync(byteResponses, { recursive: true });
      const terminalId = '0123456789abcdef0123456789abcdef';
      const descriptor = fs.openSync(path.join(byteResponses, `${terminalId}.json`), 'w');
      try {
        fs.ftruncateSync(descriptor, SANDBOX_CONTROL_MAX_RESPONSE_BYTES - SANDBOX_CONTROL_RESERVATION_BYTES);
      } finally {
        fs.closeSync(descriptor);
      }
      assert.equal(sandboxControlGenerationUsage(byteManifest).bytes, SANDBOX_CONTROL_MAX_RESPONSE_BYTES - SANDBOX_CONTROL_RESERVATION_BYTES);
      const reservationId = 'abcdefabcdefabcdefabcdefabcdefab';
      assert.doesNotThrow(() => writeSandboxControlReservation(byteManifest, reservationId, sandboxControlGenerationUsage(byteManifest)));
      assert.equal(sandboxControlGenerationUsage(byteManifest).bytes, SANDBOX_CONTROL_MAX_RESPONSE_BYTES);
      assert.throws(
        () => writeSandboxControlReservation(byteManifest, 'fedcba9876543210fedcba9876543210', sandboxControlGenerationUsage(byteManifest)),
        /SANDBOX_CONTROL_CAPACITY_EXHAUSTED/
      );
    } finally {
      fs.rmSync(byteRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox executor authority revalidates the gate-bound broker owner and handoff lease', () => {
  const root = createTempDir('sandbox-executor-authority-');
  const publicStatusDir = path.join(root, 'public');
  fs.mkdirSync(publicStatusDir);
  const startTime = getProcessStartTime(process.pid);
  assert.ok(startTime);
  const boundManifest = {
    ...manifest,
    publicStatusDir,
    token: 'authority-token',
    generation: 'authority-generation'
  };
  const owner = {
    version: 3,
    pid: process.pid,
    startTime,
    brokerId: 'broker-id',
    token: boundManifest.token,
    generation: boundManifest.generation
  } as const;
  fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify(owner)}\n`);
  try {
    assert.doesNotThrow(() => assertSandboxControlBrokerOwner(boundManifest, { identityProbe: () => 'alive' }));
    assert.doesNotThrow(() => assertSandboxControlExecutorAuthority(boundManifest, owner));
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify({ ...owner, brokerId: 'replacement-owner' })}\n`);
    assert.throws(
      () => assertSandboxControlExecutorAuthority(boundManifest, owner),
      /SANDBOX_CONTROL_GATE_OWNER_MISMATCH/
    );
    fs.writeFileSync(path.join(root, 'broker.json'), `${JSON.stringify(owner)}\n`);
    fs.writeFileSync(path.join(root, 'lease.json'), `${JSON.stringify({
      version: 2,
      generation: boundManifest.generation,
      nonce: 'lease-nonce',
      owner: { pid: process.pid, startTime },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      taskId: boundManifest.taskId,
      branch: boundManifest.branch,
      reason: 'test handoff'
    })}\n`);
    assert.throws(() => assertSandboxControlExecutorAuthority(boundManifest), /SANDBOX_CONTROL_HANDOFF_ACTIVE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript control entries retain explicit strip-types startup', () => {
  assert.deepEqual(nodeEntryArgs('/repo/bin/internal-cli.ts', ['sandbox-control', 'serve']), [
    '--experimental-strip-types', '--no-warnings', '/repo/bin/internal-cli.ts', 'sandbox-control', 'serve'
  ]);
  assert.deepEqual(nodeEntryArgs('/repo/dist/bin/internal-cli.js', ['sandbox-control', 'serve']), [
    '/repo/dist/bin/internal-cli.js', 'sandbox-control', 'serve'
  ]);
});

test('control requests are restricted to allowed lifecycle operations and rebound to the manifest task', () => {
  const request = validateSandboxControlRequest({
    version: 5,
    id: '12345678-1234-1234-1234-123456789abc',
    family: 'task-lifecycle',
    args: ['08', 'cancel', '--agent', 'codex', '--reason', 'test'],
  }, manifest);
  assert.deepEqual(bindSandboxControlTask(request, manifest.taskId!), [
    'TASK-20260809-010203',
    'cancel',
    '--agent',
    'codex',
    '--reason',
    'test'
  ]);
  assert.throws(() => validateSandboxControlRequest({ ...request, args: ['08', 'complete'] }, manifest), /COMMAND_DENIED/u);
  assert.throws(
    () => validateSandboxControlRequest({ ...request, family: 'platform-issue' }, manifest),
    /REQUEST_INVALID/
  );
});

test('control protocol rejects unsupported request versions', () => {
  const request = {
    version: 5,
    id: '12345678-1234-1234-1234-123456789abc',
    family: 'task-lifecycle',
    args: ['08', 'status'],
  };
  assert.throws(() => validateSandboxControlRequest({ ...request, version: 6 }, manifest), /REQUEST_INVALID/);
  assert.equal(validateSandboxControlRequest(request, manifest).family, 'task-lifecycle');
});

test('branch-only sandboxes fail closed while typed request schema remains usable', () => {
  const request = {
    version: 5,
    id: '12345678-1234-1234-1234-123456789abc',
    family: 'task-lifecycle',
    args: ['08', 'cancel'],
  };
  assert.throws(
    () => validateSandboxControlRequest(request, { ...manifest, mode: 'branch-only', taskId: null }),
    /SANDBOX_CONTROL_BRANCH_ONLY: .*ai sandbox start --recreate <task-ref-or-correct-branch>/
  );
  assert.equal(validateSandboxControlRequest(request, manifest).family, 'task-lifecycle');
});

test('control broker strips mixed-case sandbox authority from child environments', () => {
  assert.deepEqual(sandboxControlSafeEnv({
    agent_infra_control_token: 'live-token',
    Agent_Infra_Control_Dir: 'live-channel',
    aGeNt_InFrA_cOnTrOl_FuTuRe: 'future-authority',
    AGENT_INFRA_TASK_ID: 'task-id',
    AGENT_INFRA_RUNTIME_DIR: '/runtime',
    AGENT_INFRA_EXECUTOR_MANIFEST: '/manifest.json',
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
      version: 5,
      id: '12345678-1234-1234-1234-123456789abc',
      family: 'task-create',
      candidate,
    }, { ...manifest, mode, taskId: mode === 'task-bound' ? manifest.taskId : null });
    assert.equal(request.family, 'task-create');
    assert.equal(request.candidate.title, candidate.title);
  }
});

test('task-create executor preserves request identity when the host service throws', async () => {
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const request = validateSandboxControlRequest({
    version: 5,
    id: requestId,
    family: 'task-create',
    candidate: {
      version: 1,
      idempotencyKey: requestId,
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
    },
  }, manifest);
  const result = await executeRequest(manifest, '/manifest.json', request, {
    createTask: async () => { throw new Error('TASK_CREATE_TEST_ESCAPED_EXCEPTION'); }
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout).control, {
    requestId,
    accepted: true,
    recovery: 'inspect-domain-state'
  });
  assert.equal(JSON.parse(result.stdout).error.code, 'TASK_CREATE_TEST_ESCAPED_EXCEPTION');
});

test('task-create executor preserves accepted terminal status when the host service returns a qualification failure', async () => {
  const root = createTempDir('task-create-terminal-failure-');
  const requestId = '12345678-1234-4234-8234-123456789abc';
  const taskTemplateDir = path.join(root, '.agents', 'templates');
  fs.mkdirSync(taskTemplateDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    project: taskWorkspaceProject(root), task: { shortIdLength: 2 }, delivery: { remote: 'origin', baseRef: 'main' }
  }));
  fs.mkdirSync(path.join(taskWorkspaceRoot(root), 'active'), { recursive: true });
  fs.copyFileSync('.agents/templates/task.md', path.join(taskTemplateDir, 'task.md'));
  fs.copyFileSync('.agents/skills/create-task/config/verify.json', path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  const templatePath = path.join(taskTemplateDir, 'task.md');
  fs.writeFileSync(templatePath, fs.readFileSync(templatePath, 'utf8').replace(
    '| candidate_id | statement | status | constraint_ids | impact | evidence |',
    '| candidate_id | statement | status | constraint_ids | impact |'
  ));
  const boundManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    processingDir: path.join(root, 'processing'),
    publicStatusDir: path.join(root, 'public'),
    runtimeDir: path.join(root, 'runtime')
  };
  const candidate = {
    version: 1,
    idempotencyKey: requestId,
    agent: 'codex',
    title: 'Create a qualified sandbox task',
    type: 'feature',
    branchSlug: 'qualified-sandbox-task',
    priority: 'Medium',
    effort: 'Low',
    description: 'Verify the executor projection of a host-side qualification failure.',
    taskInput: {
      sources: ['User request'], facts: [], constraints: ['Keep lifecycle routing deterministic.'], decisions: [],
      alternatives: ['Use the canonical task renderer.', 'Add a second qualification writer.'],
      acceptanceCriteria: ['The task qualification is validated before publishing task state.'], openQuestions: []
    }
  } as const;
  const request = validateSandboxControlRequest({
    version: 5,
    id: requestId,
    family: 'task-create',
    candidate,
  }, boundManifest);

  try {
    const result = await executeRequest(boundManifest, '/manifest.json', request, {
      createTask: (value, options) => createTask(value, {
        ...options,
        repoRoot: root,
        dependencies: { createIssue: async () => { throw new Error('platform issue creation must not run'); } }
      })
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(output.control, { requestId, accepted: true, recovery: 'none' });
    assert.equal(output.error.code, 'TASK_CREATE_QUALIFICATION_INVALID');
    assert.deepEqual(fs.readdirSync(path.join(taskWorkspaceRoot(root), 'active')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('control broker ownership is acquired exclusively', onPlatforms('linux', 'darwin'), async () => {
  const root = createTempDir('agent-infra-control-owner-');
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
  const controlRootId = manifest.controlRootId;
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest, repoRoot: root, worktreeRoot: root, branch,
    channelDir: 'channel', publicStatusDir: 'public', processingDir: 'processing', runtimeDir: 'runtime'
  })}\n`);
  writeSandboxControlIdentitySentinel(publicStatusDir, {
    version: 1, mode: manifest.mode, taskId: manifest.taskId, generation: manifest.generation, controlRootId
  });
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

test('control broker rejects manifests missing required fields', async () => {
  const root = createTempDir('agent-infra-control-invalid-manifest-');
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, worktreeRoot: undefined })}\n`);
  try {
    await assert.rejects(
      serveSandboxControl(manifestPath),
      /SANDBOX_CONTROL_MANIFEST_INVALID/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manifest writer persists control directory names and reader resolves them from each manifest root', () => {
  const firstRoot = createTempDir('agent-infra-control-manifest-root-a-');
  const secondRoot = createTempDir('agent-infra-control-manifest-root-b-');
  const directoryNames = {
    channelDir: 'channel',
    publicStatusDir: 'public',
    processingDir: 'processing',
    runtimeDir: 'runtime'
  } as const;
  const directoryFields = Object.keys(directoryNames) as Array<keyof typeof directoryNames>;
  const makeSetup = (root: string) => {
    const paths = Object.fromEntries(Object.entries(directoryNames).map(([field, name]) => [field, path.join(root, name)])) as Record<keyof typeof directoryNames, string>;
    for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
    const manifestPath = path.join(root, 'manifest.json');
    const manifestDraft = { ...manifest, repoRoot: root, worktreeRoot: root, ...paths };
    return {
      root,
      ...paths,
      statusDir: paths.publicStatusDir,
      manifestPath,
      manifestDraft,
      token: manifest.token,
      generation: manifest.generation,
      controlRootId: manifest.controlRootId
    };
  };
  try {
    const firstSetup = makeSetup(firstRoot);
    finalizeSandboxControlManifest(firstSetup, {
      engine: manifest.engine,
      id: manifest.containerIdentity.id,
      labels: manifest.containerIdentity.labels
    });
    const persisted = fs.readFileSync(firstSetup.manifestPath, 'utf8');
    const persistedValue = JSON.parse(persisted) as Record<string, unknown>;
    for (const field of directoryFields) assert.equal(persistedValue[field], directoryNames[field]);
    const firstResolved = readSandboxControlManifest(firstSetup.manifestPath);
    for (const field of directoryFields) assert.equal(firstResolved[field], path.join(fs.realpathSync.native(firstRoot), directoryNames[field]));

    const secondSetup = makeSetup(secondRoot);
    fs.writeFileSync(secondSetup.manifestPath, persisted);
    const secondResolved = readSandboxControlManifest(secondSetup.manifestPath);
    for (const field of directoryFields) assert.equal(secondResolved[field], path.join(fs.realpathSync.native(secondRoot), directoryNames[field]));
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('manifest reader rejects absolute, traversing, and symbolic-link control paths for every field', onPlatforms('linux', 'darwin'), () => {
  const fields = ['channelDir', 'publicStatusDir', 'processingDir', 'runtimeDir'] as const;
  const names = { channelDir: 'channel', publicStatusDir: 'public', processingDir: 'processing', runtimeDir: 'runtime' } as const;
  for (const field of fields) {
    for (const invalidPath of ['absolute', 'traversal', 'symlink'] as const) {
      const root = createTempDir(`agent-infra-control-manifest-${field}-${invalidPath}-`);
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      const values: Record<string, string> = { ...names };
      for (const candidate of fields) {
        if (candidate !== field) fs.mkdirSync(path.join(root, names[candidate]));
      }
      if (invalidPath === 'absolute') values[field] = path.join(root, names[field]);
      else if (invalidPath === 'traversal') values[field] = `../${path.basename(outside)}`;
      else {
        fs.symlinkSync(outside, path.join(root, names[field]), 'dir');
      }
      const manifestPath = path.join(root, 'manifest.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...values })}\n`);
      try {
        assert.throws(() => readSandboxControlManifest(manifestPath), /SANDBOX_CONTROL_MANIFEST_INVALID/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test('manifest reader rejects fields outside the current structure', () => {
  const root = createTempDir('agent-infra-control-extra-field-');
  const manifestPath = path.join(root, 'manifest.json');
  const stored = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: 'channel',
    publicStatusDir: 'public',
    processingDir: 'processing',
    runtimeDir: 'runtime'
  };
  fs.mkdirSync(path.join(root, stored.channelDir), { recursive: true });
  fs.mkdirSync(path.join(root, stored.publicStatusDir));
  fs.mkdirSync(path.join(root, stored.processingDir));
  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...stored, unexpected: true })}\n`);
    assert.throws(() => readSandboxControlManifest(manifestPath), /SANDBOX_CONTROL_MANIFEST_INVALID/);
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      ...stored,
      containerIdentity: { ...stored.containerIdentity, unexpected: true }
    })}\n`);
    assert.throws(() => readSandboxControlManifest(manifestPath), /SANDBOX_CONTROL_MANIFEST_INVALID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement owner lookup failures fail closed instead of reclaiming the lease', () => {
  const root = createTempDir('agent-infra-control-owner-unknown-');
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
  const root = createTempDir('agent-infra-control-recovery-');
  const manifestPath = path.join(root, 'manifest.json');
  const oldManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: 'channel',
    publicStatusDir: 'public',
    processingDir: 'processing',
    runtimeDir: 'runtime'
  };
  for (const directory of ['channel', 'public', 'processing', 'runtime']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(oldManifest)}\n`);
  const lease = acquireSandboxControlReplacement(root);
  try {
    beginSandboxControlReplacement(root, lease);
    fs.writeFileSync(manifestPath, '{"engine":false}\n');
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
  const root = createTempDir('agent-infra-control-recovery-window-');
  const manifestPath = path.join(root, 'manifest.json');
  const oldManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: 'channel',
    publicStatusDir: 'public',
    processingDir: 'processing',
    runtimeDir: 'runtime'
  };
  for (const directory of ['channel', 'public', 'processing', 'runtime']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
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
  const root = createTempDir('agent-infra-control-quiesce-unknown-');
  const controlManifest = {
    ...manifest,
    repoRoot: root,
    worktreeRoot: root,
    channelDir: 'channel',
    publicStatusDir: 'public',
    processingDir: 'processing',
    runtimeDir: 'runtime'
  };
  for (const directory of ['channel', 'public', 'processing', 'runtime']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
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
  const root = createTempDir('agent-infra-control-snapshot-');
  try {
    const snapshot = captureSandboxControlCutoverSnapshot(root);
    fs.writeFileSync(path.join(root, 'broker.json'), 'changed\n');
    assert.throws(() => assertSandboxControlCutoverSnapshot(snapshot), /SANDBOX_CONTROL_OWNER_TRANSITION/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('typed control request is independent of source generation and request age', () => {
  const request = {
    version: 5,
    id: '12345678-1234-1234-1234-123456789abc',
    family: 'task-lifecycle',
    args: ['08', 'status'],
  };
  assert.equal(validateSandboxControlRequest(request, manifest).family, 'task-lifecycle');
});

test('pre-acceptance state errors expose the explicit retry contract', () => {
  for (const code of [
    'SANDBOX_CONTROL_BUSY',
    'SANDBOX_CONTROL_HANDOFF_ACTIVE',
    'SANDBOX_WORKTREE_BINDING_LOST'
  ]) {
    assert.deepEqual(controlError(new Error(code)), { code, message: code, retryable: true });
  }
  assert.equal(controlError(new Error('SANDBOX_CONTROL_REQUEST_REPLAYED')).retryable, false);
  assert.equal(controlError(new Error('SANDBOX_CONTROL_RESULT_UNKNOWN')).retryable, false);
});

test('control audit rotates at its fixed bound without recording manifest authority', () => {
  const root = createTempDir('agent-infra-control-audit-');
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
  const root = createTempDir('agent-infra-control-lease-');
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
  const root = createTempDir('agent-infra-control-lease-unknown-');
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
