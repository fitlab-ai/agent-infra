import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalTaskCreateCandidate, validateTaskCreateCandidate } from '../../../lib/task/create.ts';

const internalCli = path.resolve('bin/internal-cli.ts');
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_INFRA_CONTROL_')
    && key !== 'AGENT_INFRA_TASK_ID'
    && key !== 'AGENT_INFRA_RUNTIME_DIR'
    && key !== 'AGENT_INFRA_EXECUTOR_MANIFEST')
);

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-cli-'));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 }, platform: { type: null }, delivery: { remote: 'origin', baseRef: 'main' } }));
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  return root;
}

function candidate() {
  return {
    version: 1,
    idempotencyKey: '12345678-1234-4123-8123-123456789abc',
    agent: 'codex',
    title: 'Create through internal CLI',
    type: 'feature',
    branchSlug: 'create-through-internal-cli',
    priority: 'Medium',
    effort: 'Low',
    description: 'Create a task through the deterministic host command.',
    taskInput: {
      sources: ['Integration test'], facts: [], constraints: [], decisions: [], alternatives: [],
      acceptanceCriteria: ['A task is persisted.'], openQuestions: []
    }
  };
}

async function waitForRequestAsync(requestsDir: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = fs.readdirSync(requestsDir).find((name) => name.endsWith('.json'));
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a request in ${requestsDir}`);
}

async function runControlledTaskCreate(responseFor: (requestId: string) => object): Promise<{
  requestId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const root = fixture();
  const input = path.join(root, 'candidate.json');
  const channelDir = path.join(root, 'control');
  const requestsDir = path.join(channelDir, 'requests');
  const responsesDir = path.join(channelDir, 'responses');
  const statusDir = path.join(root, 'status');
  const generation = 'task-create-test-generation';
  fs.writeFileSync(input, JSON.stringify(candidate()));
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir);
  fs.mkdirSync(statusDir);
  fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
    version: 2,
    generation,
    broker: { pid: process.pid, startTime: 0, brokerId: 'task-create-test-broker' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: Date.now()
  })}\n`);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
    cwd: root,
    env: {
      ...hostEnvironment,
      AGENT_INFRA_CONTROL_TOKEN: 'task-create-test-token',
      AGENT_INFRA_CONTROL_GENERATION: generation,
      AGENT_INFRA_CONTROL_DIR: channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const result = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  try {
    const requestName = await waitForRequestAsync(requestsDir, 2_000);
    const requestId = requestName.slice(0, -5);
    fs.writeFileSync(path.join(responsesDir, `${requestId}.accepted.json`), `${JSON.stringify({
      version: 2, id: requestId, phase: 'accepted', exitCode: null, stdout: '', stderr: '', error: null
    })}\n`);
    fs.writeFileSync(path.join(responsesDir, `${requestId}.json`), `${JSON.stringify(responseFor(requestId))}\n`);
    return { requestId, exitCode: await result, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await result.catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('task-create internal CLI persists a task and replays as no-op', () => {
  const root = fixture();
  const input = path.join(root, 'candidate.json');
  fs.writeFileSync(input, JSON.stringify(candidate()));
  try {
    const first = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const applied = JSON.parse(first.stdout);
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.operations.at(-1), { name: 'task:verify', status: 'pass', reasonCode: null });
    assert.match(applied.task.id, /^TASK-\d{8}-\d{6}$/);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', applied.task.id, 'task.md')), true);

    const second = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const replayed = JSON.parse(second.stdout);
    assert.equal(replayed.status, 'no-op');
    assert.equal(replayed.task.id, applied.task.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-create preserves controlled candidate content without changing the raw candidate digest', () => {
  const root = fixture();
  const input = path.join(root, 'candidate.json');
  const raw = {
    ...candidate(),
    title: 'Optical detail `@2x`',
    description: 'Description `@2x`; contact test@example.com; mention @alice; URL https://example.com/@2x',
    taskInput: {
      sources: ['source `@2x`'],
      facts: ['fact `@2x`'],
      constraints: ['constraint `@2x`'],
      decisions: ['decision `@2x`'],
      alternatives: ['alternative `@2x`'],
      acceptanceCriteria: ['acceptance `@2x`'],
      openQuestions: ['question `@2x`']
    }
  };
  const expectedDigest = createHash('sha256')
    .update(canonicalTaskCreateCandidate(validateTaskCreateCandidate(raw)))
    .digest('hex');
  fs.writeFileSync(input, JSON.stringify(raw));
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const taskId = JSON.parse(result.stdout).task.id as string;
    const task = fs.readFileSync(path.join(root, '.agents', 'workspace', 'active', taskId, 'task.md'), 'utf8');
    assert.match(task, /^# 任务：Optical detail `@2x`$/m);
    assert.match(task, /Description `@2x`; contact test@example.com; mention @alice; URL https:\/\/example\.com\/@2x/);
    for (const field of ['source', 'fact', 'constraint', 'decision', 'alternative', 'acceptance', 'question']) {
      assert.match(task, new RegExp('^- ' + field + ' `@2x`$', 'm'));
    }
    assert.match(task, new RegExp(`^task_create_candidate_digest: ${expectedDigest}$`, 'm'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-create internal CLI rejects symbolic-link input without writing', () => {
  const root = fixture();
  const real = path.join(root, 'candidate.json');
  const linked = path.join(root, 'candidate-link.json');
  fs.writeFileSync(real, JSON.stringify(candidate()));
  fs.symlinkSync(real, linked);
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', linked], {
      cwd: root, encoding: 'utf8', env: hostEnvironment
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'TASK_CREATE_INPUT_INVALID');
    assert.deepEqual(fs.readdirSync(path.join(root, '.agents', 'workspace', 'active')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-create internal CLI returns controlled recovery evidence when the broker is unavailable', () => {
  const root = fixture();
  const input = path.join(root, 'candidate.json');
  fs.writeFileSync(input, JSON.stringify(candidate()));
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-create', '--input', input], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...hostEnvironment,
        AGENT_INFRA_CONTROL_TOKEN: 'controlled-token',
        AGENT_INFRA_CONTROL_GENERATION: 'controlled-generation',
        AGENT_INFRA_CONTROL_DIR: path.join(root, 'control'),
        AGENT_INFRA_CONTROL_STATUS_DIR: path.join(root, 'status')
      }
    });
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.error.code, 'SANDBOX_CONTROL_BROKER_UNAVAILABLE');
    assert.deepEqual(payload.control, {
      requestId: null,
      accepted: false,
      recovery: 'new-request-id'
    });
    assert.deepEqual(fs.readdirSync(path.join(root, '.agents', 'workspace', 'active')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-create preserves accepted evidence for a broker result-unknown terminal', async () => {
  const result = await runControlledTaskCreate((requestId) => ({
    version: 2, id: requestId, phase: 'rejected', exitCode: null, stdout: '',
    stderr: 'SANDBOX_CONTROL_RESULT_UNKNOWN: accepted execution ended without a provable result\n',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'SANDBOX_CONTROL_RESULT_UNKNOWN: result unknown', retryable: false }
  }));
  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'SANDBOX_CONTROL_RESULT_UNKNOWN');
  assert.deepEqual(payload.control, {
    requestId: result.requestId,
    accepted: true,
    recovery: 'same-request-id'
  });
});

test('task-create preserves accepted evidence when an accepted terminal response is invalid', async () => {
  const result = await runControlledTaskCreate((requestId) => ({
    version: 2, id: requestId, phase: 'completed', exitCode: 0, stdout: '', stderr: '', error: null,
    outputState: 'available', payload: null
  }));
  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'SANDBOX_CONTROL_RESPONSE_INVALID');
  assert.deepEqual(payload.control, {
    requestId: result.requestId,
    accepted: true,
    recovery: 'same-request-id'
  });
});
