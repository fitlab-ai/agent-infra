import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type net from 'node:net';
import { spawn } from 'node:child_process';

import { hostControlRequestForCommand, requestHostControl, HostControlClientError } from '../../../lib/host-control/client.ts';
import { dispatchHostControlCommand } from '../../../lib/host-control/command.ts';
import { hostControlAuditPath } from '../../../lib/host-control/audit.ts';
import { startHostControlServer } from '../../../lib/host-control/server.ts';
import { filePath, onPlatforms } from '../../helpers.ts';

test('direct CLI preserves unknown execution after a response disconnect', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-cli-disconnect-')));
  let socket: net.Socket | undefined;
  const server = await startHostControlServer({
    endpoint: path.join(root, 'control.sock'),
    dispatch: async () => {
      socket!.destroy();
      return { stdout: '{}\n', stderr: '', exitCode: 0 };
    }
  });
  server.server.on('connection', (connected) => { socket = connected; });
  try {
    const child = spawn(process.execPath, [filePath('dist/bin/internal-cli.js'), 'task-artifact', '--help'], {
      cwd: root, env: { ...process.env, AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT: server.endpoint },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.changed, null);
    assert.equal(result.error.code, 'HOST_CONTROL_RESPONSE_INVALID');
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('host-control has one endpoint owner and close is scoped to that instance', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-owner-')));
  const options = {
    endpoint: path.join(root, 'control.sock'),
    dispatch: async () => ({ stdout: '{}\n', stderr: '', exitCode: 0 })
  };
  const first = await startHostControlServer(options);
  let second: typeof first | undefined;
  try {
    await assert.rejects(async () => { second = await startHostControlServer(options); }, /FILE_LOCK_BUSY/);
    await first.close();
    second = await startHostControlServer(options);
    await first.close();
    const response = await requestHostControl({
      endpoint: second.endpoint, request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    });
    assert.equal(response.exitCode, 0);
  } finally {
    await first.close();
    await second?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-control shutdown drains dispatched work even after caller disconnects', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-drain-')));
  let finishWork!: () => void;
  const work = new Promise<void>((resolve) => { finishWork = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const server = await startHostControlServer({
    endpoint: path.join(root, 'control.sock'),
    dispatch: async () => { markStarted(); await work; return { stdout: '{}\n', stderr: '', exitCode: 0 }; }
  });
  let socket: net.Socket | undefined;
  server.server.on('connection', (connected) => { socket = connected; });
  let closed = false;
  try {
    const request = requestHostControl({
      endpoint: server.endpoint, timeoutMs: 2_000,
      request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    });
    const rejected = assert.rejects(request, /HOST_CONTROL_RESPONSE_INVALID/);
    await started;
    socket!.destroy();
    await rejected;
    const closing = server.close().then(() => { closed = true; });
    await delay(20);
    assert.equal(closed, false);
    finishWork();
    await closing;
    assert.equal(closed, true);
  } finally {
    finishWork();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-control timeout after dispatch preserves execution uncertainty', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-timeout-')));
  let executed = false;
  let finishWork!: () => void;
  const work = new Promise<void>((resolve) => { finishWork = resolve; });
  const server = await startHostControlServer({
    endpoint: path.join(root, 'control.sock'),
    dispatch: async () => {
      executed = true;
      await work;
      return { stdout: '{}\n', stderr: '', exitCode: 0 };
    }
  });
  try {
    await assert.rejects(requestHostControl({
      endpoint: server.endpoint, timeoutMs: 500,
      request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    }), (error: unknown) => {
      assert.ok(error instanceof HostControlClientError);
      assert.equal(executed, true);
      assert.equal(error.retryable, false);
      assert.equal(error.changed, null);
      return true;
    });
  } finally {
    finishWork();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-control propagates real command results and audits domain failure', onPlatforms('linux', 'darwin'), async () => {
  const base = process.platform === 'darwin' ? fs.realpathSync.native(os.homedir()) : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'host-control-service-'));
  const endpoint = path.join(root, 'run', 'host-control.sock');
  const previous = process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
  process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = endpoint;
  const server = await startHostControlServer({ endpoint, dispatch: dispatchHostControlCommand });
  try {
    const help = await requestHostControl({
      endpoint, request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    });
    assert.equal(help.status, 'completed');
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Usage:/u);

    const invalid = await requestHostControl({
      endpoint, request: hostControlRequestForCommand('task-artifact', ['TASK-20260904-002407', 'inspect', '--family', 'invalid'], root)
    });
    assert.equal(invalid.status, 'completed');
    assert.notEqual(invalid.exitCode, 0);
    assert.equal(JSON.parse(invalid.stdout).status, 'failed');
    const entries = fs.readFileSync(hostControlAuditPath(endpoint), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.phase, entry.outcome]), [
      ['accepted', 'in-progress'], ['completed', 'success'],
      ['accepted', 'in-progress'], ['completed', 'failure']
    ]);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
    else process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-control client fails closed when the fixed endpoint is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-missing-'));
  try {
    await assert.rejects(requestHostControl({
      endpoint: path.join(root, 'missing.sock'),
      request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    }), (error: unknown) => error instanceof HostControlClientError && error.retryable && error.code === 'HOST_CONTROL_ENDPOINT_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const fault of ['accepted-audit', 'dispatch', 'completed-audit'] as const) {
  test(`host-control distinguishes execution state after ${fault} failure`, onPlatforms('linux', 'darwin'), async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-failure-')));
    const endpoint = path.join(root, 'run', 'host-control.sock');
    const phases: string[] = [];
    let executed = false;
    const server = await startHostControlServer({
      endpoint,
      dispatch: async () => {
        executed = true;
        if (fault === 'dispatch') throw new Error('WORKER_TERMINATED');
        return { exitCode: 0, stdout: '{}\n', stderr: '' };
      },
      audit: (entry) => {
        phases.push(entry.phase);
        if (fault === 'accepted-audit' && entry.phase === 'accepted') throw new Error('AUDIT_UNAVAILABLE');
        if (fault === 'completed-audit' && entry.phase === 'completed') throw new Error('AUDIT_UNAVAILABLE');
      }
    });
    try {
      const response = await requestHostControl({ endpoint, request: hostControlRequestForCommand('task-artifact', ['--help'], root) });
      assert.equal(executed, fault !== 'accepted-audit');
      assert.equal(response.status, executed ? 'unknown' : 'rejected');
      assert.equal(JSON.parse(response.stdout).changed, executed ? null : false);
      assert.notEqual(response.exitCode, 0);
      assert.equal(phases.includes('rejected'), !executed);
    } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
