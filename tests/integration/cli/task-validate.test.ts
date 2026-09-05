import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { gitSafeEnv, initIsolatedGitRepo } from '../../helpers/git.ts';
import { envWithPrependedPath, sandboxRow, writeSandboxEngineFixture } from '../../helpers.ts';
import { sandboxControlPaths } from '../../../lib/sandbox/workspace-view.ts';
import { SANDBOX_CONTROL_STATUS_STALE_MS } from '../../../lib/sandbox/control/protocol.ts';

const SHORT_ID_SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');
const internalCli = path.resolve('bin/internal-cli.ts');
const CANONICAL_AGENT_CLIENTS = [
  'claude-code',
  'codex',
  'antigravity-cli',
  'opencode',
  'traecli'
].map((id) => ({ id, enabled: true, installInSandbox: true }));

function spawnTaskValidate(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', internalCli, 'task-validate', ...args], {
    cwd, encoding: 'utf8', env
  });
}

// Drives the fake broker's status.json through parked -> healthy while the
// blocking `task-validate --scope inplace` child process is running, mirroring
// what a real broker process inside the sandbox container would do.
const STATE_DRIVER_SOURCE = `
const fs = require('node:fs');
const [statusPath, leasePath, dockerLogPath, diagnosticsLogPath] = process.argv.slice(2);
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readStatus() { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); }
function writeStatus(patch) {
  const current = readStatus();
  const temporaryPath = statusPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporaryPath, JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }) + '\\n');
  fs.renameSync(temporaryPath, statusPath);
}
function logDiagnostic(message) {
  fs.appendFileSync(diagnosticsLogPath, message + '\\n');
}
function pollUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    sleep(20);
  }
  return false;
}
if (!pollUntil(() => {
  if (fs.existsSync(leasePath)) return true;
  writeStatus({ state: 'healthy', reasonCode: null, activeRequestId: null });
  return false;
}, 20000)) {
  logDiagnostic('state-driver: timed out waiting for lease.json to appear');
  process.exit(1);
}
writeStatus({ state: 'parked', reasonCode: 'SANDBOX_CONTROL_HANDOFF_ACTIVE' });
function sawStart() {
  if (!fs.existsSync(dockerLogPath)) return false;
  return fs.readFileSync(dockerLogPath, 'utf8').trim().split('\\n').filter(Boolean).some((line) => {
    const call = JSON.parse(line);
    const args = call[0] === '--context' ? call.slice(2) : call;
    return args[0] === 'start';
  });
}
if (!pollUntil(sawStart, 20000)) {
  logDiagnostic('state-driver: timed out waiting for a docker start call');
  process.exit(1);
}
writeStatus({ state: 'healthy', activeRequestId: null });
process.exit(0);
`;

// Keeps precondition fixtures fresh while the blocking CLI child starts. A real
// broker continuously publishes status; a one-shot fixture can become stale
// under a busy full-suite run before task-validate reads it.
const STATUS_HEARTBEAT_SOURCE = `
const fs = require('node:fs');
const [statusPath, patchJson, readyPath] = process.argv.slice(2);
const patch = JSON.parse(patchJson);
function publish() {
  const current = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const temporaryPath = statusPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporaryPath, JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }) + '\\n');
  fs.renameSync(temporaryPath, statusPath);
}
publish();
fs.writeFileSync(readyPath, 'ready\\n');
setInterval(publish, 20);
`;

function startStateDriver(tmpDir: string, statusPath: string, leasePath: string, dockerLogPath: string) {
  const driverPath = path.join(tmpDir, 'state-driver.js');
  const diagnosticsLogPath = path.join(tmpDir, 'state-driver.log');
  fs.writeFileSync(driverPath, STATE_DRIVER_SOURCE, 'utf8');
  const child = spawn(process.execPath, [driverPath, statusPath, leasePath, dockerLogPath, diagnosticsLogPath], { stdio: 'ignore' });
  return {
    child,
    status: () => `exitCode=${child.exitCode}, signalCode=${child.signalCode}`,
    diagnostics: () => {
      try { return fs.readFileSync(diagnosticsLogPath, 'utf8'); } catch { return ''; }
    }
  };
}

function startStatusHeartbeat(tmpDir: string, statusPath: string, patch: Record<string, unknown>) {
  const heartbeatPath = path.join(tmpDir, 'status-heartbeat.js');
  const readyPath = path.join(tmpDir, 'status-heartbeat.ready');
  fs.writeFileSync(heartbeatPath, STATUS_HEARTBEAT_SOURCE, 'utf8');
  const child = spawn(process.execPath, [heartbeatPath, statusPath, JSON.stringify(patch), readyPath], { stdio: 'ignore' });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath) && child.exitCode === null && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.equal(fs.existsSync(readyPath), true, 'status heartbeat did not become ready');
  return child;
}

async function removeFixtureAfterChildExit(tmpDir: string, child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function inplaceFixture({ includeContainer = true }: { includeContainer?: boolean } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-validate-inplace-'));
  const project = 'demo';
  const branch = 'feature-inplace-fixture';
  const containerName = `${project}-dev-${branch}`;
  const taskId = 'TASK-20260101-000002';
  const dockerFixture = writeSandboxEngineFixture(tmpDir, {
    project,
    dockerStdoutForPs: includeContainer ? sandboxRow(containerName, branch, project) : ''
  });
  const repoDir = dockerFixture.repoDir;
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, env: gitSafeEnv() });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, env: gitSafeEnv() });
  spawnSync('git', ['switch', '-c', branch], { cwd: repoDir, env: gitSafeEnv() });
  const taskDir = path.join(repoDir, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nbranch: ${branch}\nstatus: active\n---\n# Task\n`);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'committed\n');
  const allocation = spawnSync('node', [SHORT_ID_SCRIPT, 'alloc', taskId], { cwd: repoDir, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(allocation.status, 0, allocation.stderr);
  const shortId = allocation.stdout.trim();
  spawnSync('git', ['add', '.'], { cwd: repoDir, env: gitSafeEnv() });
  const commit = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: repoDir, env: gitSafeEnv() });
  assert.equal(commit.status, 0, commit.stderr?.toString());

  const generation = 'inplace-fixture-generation';
  const control = sandboxControlPaths({
    base: path.join(tmpDir, '.agent-infra', 'sandbox-control'),
    project, container: containerName,
    identity: { mode: 'task-bound', taskId, shortId }
  });
  for (const dir of [control.channelDir, control.statusDir, control.processingDir, control.runtimeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(control.manifestPath, `${JSON.stringify({
    engine: 'docker-desktop', repoRoot: repoDir, worktreeRoot: repoDir,
    project, container: containerName, containerIdentity: { id: 'fixture-container-id', labels: {} },
    authorityEvidence: {
      version: 1, provider: 'docker-desktop', lockDomain: 'a'.repeat(64), routeKind: 'context',
      routeSelector: { context: 'desktop-linux' }, normalizedEndpoint: 'docker-context://desktop-linux',
      endpointFingerprint: 'b'.repeat(64), daemonIdentity: { kind: 'docker-server-id', fingerprint: 'c'.repeat(64) },
      apiVersion: { major: 1, minor: 50 }, authorityFingerprint: 'd'.repeat(64)
    },
    branch, mode: 'task-bound', taskId, token: 'fixture-token', generation,
    channelDir: control.channelDir, publicStatusDir: control.statusDir,
    processingDir: control.processingDir, runtimeDir: control.runtimeDir
  })}\n`);
  const statusPath = path.join(control.statusDir, 'status.json');
  const writeStatus = (overrides: Record<string, unknown>) => {
    fs.writeFileSync(statusPath, `${JSON.stringify({
      version: 3, generation, broker: { pid: 999999, startTime: 123456789, brokerId: 'fixture-broker' },
      state: 'healthy', reasonCode: null, activeRequestId: null, updatedAt: Date.now(),
      taskView: { state: 'current', taskId, observedSource: 'active', receipt: null, reasonCode: null },
      ...overrides
    })}\n`);
  };
  writeStatus({});

  const env = {
    ...envWithPrependedPath(gitSafeEnv(), dockerFixture.binDir),
    HOME: tmpDir, USERPROFILE: tmpDir,
    DOCKER_LOG_PATH: dockerFixture.logPath
  };

  return { tmpDir, repoDir, branch, taskId, containerName, project, generation, control, statusPath, dockerFixture, env, writeStatus };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-validate-'));
  initIsolatedGitRepo(root);
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root, env: gitSafeEnv() });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env: gitSafeEnv() });
  const id = 'TASK-20260101-000001';
  const branch = 'agent-infra-feature-validation-fixture';
  spawnSync('git', ['switch', '-c', branch], { cwd: root, env: gitSafeEnv() });
  const taskDir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'fixture', agentClients: CANONICAL_AGENT_CLIENTS }));
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${id}\nbranch: ${branch}\nstatus: active\n---\n# Task\n`);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
  const allocation = spawnSync('node', [SHORT_ID_SCRIPT, 'alloc', id], { cwd: root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(allocation.status, 0, allocation.stderr);
  spawnSync('git', ['add', '.'], { cwd: root, env: gitSafeEnv() });
  const commit = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env: gitSafeEnv() });
  assert.equal(commit.status, 0, commit.stderr?.toString());
  return { root, id, branch };
}

test('snapshot validation runs at the task commit and removes its temporary worktree', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.root, 'tracked.txt'), 'dirty host state\n');
  const command = [
    f.id, '--scope', 'snapshot', '--format', 'json', '--',
    process.execPath, '-e',
    "const fs=require('node:fs');if(process.env.AGENT_INFRA_VALIDATION_SCOPE!=='snapshot'||fs.readFileSync('tracked.txt','utf8')!=='committed\\n')process.exit(9)"
  ];
  const result = spawnTaskValidate(f.root, gitSafeEnv(), command);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'applied');
  assert.equal(payload.changed, false);
  const evidence = payload.evidence;
  assert.equal(evidence.taskId, f.id);
  assert.equal(evidence.branch, f.branch);
  assert.equal(evidence.scope, 'snapshot');
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.cleanup, 'completed');
  const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: f.root, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(worktrees.stdout.match(/^worktree /gm)?.length, 1);
});

test('inplace validation refuses to run when the broker is not idle', (t) => {
  const f = inplaceFixture();
  let heartbeat: ReturnType<typeof spawn> | undefined;
  t.after(() => removeFixtureAfterChildExit(f.tmpDir, heartbeat));
  f.writeStatus({ state: 'busy', activeRequestId: 'other-request' });
  heartbeat = startStatusHeartbeat(f.tmpDir, f.statusPath, { state: 'busy', activeRequestId: 'other-request' });
  const result = spawnTaskValidate(f.repoDir, f.env, [
    f.taskId, '--scope', 'inplace', '--format', 'json', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error.code, 'SANDBOX_VALIDATION_BROKER_NOT_IDLE');
  assert.equal(f.dockerFixture.readDockerCalls().some((call) => call[0] === 'stop'), false);
});

test('inplace validation refuses to run when the broker status is stale', (t) => {
  const f = inplaceFixture();
  t.after(() => fs.rmSync(f.tmpDir, { recursive: true, force: true }));
  f.writeStatus({ updatedAt: Date.now() - SANDBOX_CONTROL_STATUS_STALE_MS - 1_000 });
  const result = spawnTaskValidate(f.repoDir, f.env, [
    f.taskId, '--scope', 'inplace', '--format', 'json', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error.code, 'SANDBOX_VALIDATION_BROKER_STATUS_STALE');
});

test('inplace validation refuses to run when the manifest generation does not match the broker status', (t) => {
  const f = inplaceFixture();
  t.after(() => fs.rmSync(f.tmpDir, { recursive: true, force: true }));
  f.writeStatus({ generation: 'a-different-generation' });
  const result = spawnTaskValidate(f.repoDir, f.env, [
    f.taskId, '--scope', 'inplace', '--format', 'json', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error.code, 'SANDBOX_VALIDATION_BROKER_STATUS_STALE');
});

test('inplace validation refuses to run when no matching container exists', (t) => {
  const f = inplaceFixture({ includeContainer: false });
  let heartbeat: ReturnType<typeof spawn> | undefined;
  t.after(() => removeFixtureAfterChildExit(f.tmpDir, heartbeat));
  heartbeat = startStatusHeartbeat(f.tmpDir, f.statusPath, { state: 'healthy', activeRequestId: null });
  const result = spawnTaskValidate(f.repoDir, f.env, [
    f.taskId, '--scope', 'inplace', '--format', 'json', '--', process.execPath, '-e', 'process.exit(0)'
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'failed');
  assert.equal(payload.error.code, 'SANDBOX_VALIDATION_CONTAINER_NOT_FOUND');
});

test('inplace validation stops, runs, restarts the container, and restores broker health', (t) => {
  const f = inplaceFixture();
  let driver: ReturnType<typeof startStateDriver> | undefined;
  t.after(() => removeFixtureAfterChildExit(f.tmpDir, driver?.child));
  const leasePath = path.join(f.control.root, 'lease.json');
  driver = startStateDriver(f.tmpDir, f.statusPath, leasePath, f.dockerFixture.logPath);

  const result = spawnTaskValidate(f.repoDir, f.env, [
    f.taskId, '--scope', 'inplace', '--format', 'json', '--',
    process.execPath, '-e',
    "if(process.env.AGENT_INFRA_VALIDATION_SCOPE!=='inplace')process.exit(9)"
  ]);
  assert.equal(
    result.status,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nstate-driver ${driver.status()}\nstate-driver diagnostics:\n${driver.diagnostics()}`
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'applied');
  const evidence = payload.evidence;
  assert.equal(evidence.taskId, f.taskId);
  assert.equal(evidence.branch, f.branch);
  assert.equal(evidence.scope, 'inplace');
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.cleanup, 'completed');

  const dockerVerbs = f.dockerFixture.readDockerCalls().map((call) => call[0]!).filter((verb) => ['ps', 'stop', 'start'].includes(verb));
  assert.deepEqual(dockerVerbs, ['ps', 'stop', 'ps', 'start']);

  assert.equal(fs.existsSync(leasePath), false);
  const finalStatus = JSON.parse(fs.readFileSync(f.statusPath, 'utf8'));
  assert.equal(finalStatus.state, 'healthy');
  assert.equal(finalStatus.activeRequestId, null);

  const currentBranch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: f.repoDir, encoding: 'utf8', env: gitSafeEnv() });
  assert.equal(currentBranch.stdout.trim(), f.branch);
});
