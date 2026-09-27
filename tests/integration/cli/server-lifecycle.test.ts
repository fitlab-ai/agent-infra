import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

import { CLI_PATH, onPlatforms, gitSafeEnv, initIsolatedGitRepo, escapeRegExp } from '../../helpers.ts';
import { buildProcessTreeStopCommand, buildStopCommand, isProcessAlive } from '../../../lib/server/process-control.ts';
import { getProcessStartTime } from '../../../lib/server/process-state.ts';
import { terminateSandboxControlExecution } from '../../../lib/sandbox/control/state.ts';
import type { SandboxControlExecution } from '../../../lib/sandbox/control/protocol.ts';

// buildStopCommand is pure, so both platform branches are asserted on every OS.
// This is the win32 `taskkill` coverage that the platform-guarded lifecycle
// tests below cannot provide on a Linux/macOS CI runner.
test('buildStopCommand uses taskkill on win32 and SIGTERM elsewhere', () => {
  assert.deepEqual(buildStopCommand(4321, 'win32'), {
    kind: 'exec',
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F']
  });
  assert.deepEqual(buildStopCommand(4321, 'linux'), { kind: 'signal', signal: 'SIGTERM' });
  assert.deepEqual(buildStopCommand(4321, 'darwin'), { kind: 'signal', signal: 'SIGTERM' });
});

test('buildProcessTreeStopCommand targets the whole execution tree', () => {
  assert.deepEqual(buildProcessTreeStopCommand(42, 'win32'), {
    kind: 'exec', command: 'taskkill', args: ['/PID', '42', '/T', '/F']
  });
  assert.deepEqual(buildProcessTreeStopCommand(42, 'linux'), {
    kind: 'group-signal', pid: -42, signal: 'SIGTERM'
  });
  assert.deepEqual(buildProcessTreeStopCommand(42, 'darwin'), {
    kind: 'group-signal', pid: -42, signal: 'SIGTERM'
  });
});

test('sandbox execution termination waits for the entire POSIX process group', onPlatforms('linux', 'darwin'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-process-group-'));
  const childPidPath = path.join(root, 'child.pid');
  const leader = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
    `fs.writeFileSync(${JSON.stringify(childPidPath)},String(child.pid))`,
    "process.on('SIGTERM',()=>process.exit(0))",
    "setInterval(()=>{},1000)"
  ].join(';')], { detached: true, stdio: 'ignore' });
  leader.unref();
  assert.ok(leader.pid);
  let startTime: number | null = null;
  const readyDeadline = Date.now() + 2_000;
  while (Date.now() < readyDeadline) {
    startTime = getProcessStartTime(leader.pid!);
    if (startTime && fs.existsSync(childPidPath)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.ok(startTime);
  assert.equal(fs.existsSync(childPidPath), true);
  const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  const execution: SandboxControlExecution = {
    version: 2,
    generation: 'test',
    requestId: '12345678-1234-1234-1234-123456789abc',
    nonce: 'nonce',
    child: { pid: leader.pid!, startTime: startTime!, processGroupId: leader.pid! },
    phase: 'running',
    updatedAt: Date.now()
  };
  try {
    assert.equal(terminateSandboxControlExecution(execution, { timeoutMs: 500 }), true);
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    try { process.kill(-leader.pid!, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PROJECT = 'lifecycle';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-lifecycle-'));
  initIsolatedGitRepo(dir);
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', '.airc.json'), JSON.stringify({ project: PROJECT }));
  // Fast heartbeat so the test observes liveness quickly. No log.path override:
  // the test pins HOME to `dir` (see runServer), so the real default runtime
  // paths (~/.agent-infra/{logs,run}/<project>/) resolve under the temp dir and
  // stay hermetic.
  fs.writeFileSync(path.join(dir, '.agents', 'server.json'), JSON.stringify({ heartbeatMs: 100 }));
  return dir;
}

// The daemon resolves its runtime paths from os.homedir(); pinning HOME (and
// USERPROFILE on Windows) to the temp dir keeps logs/PID out of the real home.
function runServer(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return runServerFrom(dir, dir, ...args);
}

function runServerFrom(cwd: string, home: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, 'server', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitSafeEnv({ HOME: home, USERPROFILE: home })
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function logPathOf(dir: string): string | null {
  const file = path.join(dir, '.agent-infra', 'logs', PROJECT, 'server.log');
  return fs.existsSync(file) ? file : null;
}

function pidPathOf(dir: string): string | null {
  const file = path.join(dir, '.agent-infra', 'run', PROJECT, 'server.pid');
  return fs.existsSync(file) ? file : null;
}

function readPid(dir: string): number | null {
  const pidPath = pidPathOf(dir);
  if (pidPath === null) return null;
  try {
    const record = JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid?: unknown };
    const pid = record.pid;
    return typeof pid === 'number' && Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test(
  'server start stays alive and heartbeats, status reports running, stop shuts down cleanly',
  onPlatforms('linux', 'darwin'),
  async () => {
    const dir = makeRepo();
    let pid: number | null = null;
    try {
      const started = runServer(dir, 'start');
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /server started \(pid \d+\)/);

      pid = readPid(dir);
      assert.ok(pid !== null && pid > 0, 'pid file should contain a live pid');
      const livePid = pid;

      // PL-1: the daemon must stay alive and emit a heartbeat (not exit on start).
      const beat = await waitFor(() => {
        const logPath = logPathOf(dir);
        return logPath !== null && /\[INFO\] heartbeat/.test(fs.readFileSync(logPath, 'utf8'));
      });
      assert.ok(beat, 'a heartbeat line should appear in the log');
      assert.ok(isProcessAlive(livePid), 'daemon process should still be running before stop');

      const status = runServer(dir, 'status');
      assert.match(status.stdout, /server: running/);
      assert.match(status.stdout, new RegExp(`pid: ${escapeRegExp(String(livePid))}`));
      assert.match(status.stdout, /adapters: \(none\)/);

      const logs = runServer(dir, 'logs');
      assert.match(logs.stdout, /\[INFO\] heartbeat/);

      const stopped = runServer(dir, 'stop');
      assert.equal(stopped.status, 0, stopped.stderr);
      const exited = await waitFor(() => !isProcessAlive(livePid));
      assert.ok(exited, 'daemon should exit after stop');
      assert.equal(pidPathOf(dir), null, 'pid file removed on stop');
      pid = null;
    } finally {
      if (pid !== null && isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // best effort cleanup
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'linked worktree commands share the primary worktree config, pid, and log',
  onPlatforms('linux', 'darwin'),
  async () => {
    const primary = makeRepo();
    const linked = path.join(os.tmpdir(), `${path.basename(primary)}-linked`);
    let pid: number | null = null;
    try {
      fs.writeFileSync(path.join(primary, '.agents', 'server.json'), JSON.stringify({
        heartbeatMs: 100
      }));
      execFileSync('git', ['-C', primary, 'add', '.agents'], { env: gitSafeEnv() });
      execFileSync('git', ['-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'server config'], { env: gitSafeEnv() });
      execFileSync('git', ['-C', primary, 'worktree', 'add', '-b', 'linked-server-test', linked], { env: gitSafeEnv() });
      fs.writeFileSync(path.join(linked, '.agents', 'server.json'), JSON.stringify({
        heartbeatMs: 10_000
      }));

      const started = runServerFrom(linked, primary, 'start');
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /server started \(pid \d+\)/);
      pid = readPid(primary);
      assert.ok(pid !== null && pid > 0, 'primary runtime path should contain the shared pid record');

      const primaryLog = path.join(primary, '.agent-infra', 'logs', PROJECT, 'server.log');
      assert.ok(await waitFor(() => fs.existsSync(primaryLog) && /\[INFO\] heartbeat/.test(fs.readFileSync(primaryLog, 'utf8'))));

      const status = runServerFrom(primary, primary, 'status');
      assert.match(status.stdout, /server: running/);
      assert.match(status.stdout, /server\.log/);
      const logs = runServerFrom(linked, primary, 'logs');
      assert.match(logs.stdout, /\[INFO\] heartbeat/);

      const stopped = runServerFrom(primary, primary, 'stop');
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.ok(await waitFor(() => !isProcessAlive(pid as number)));
      assert.equal(pidPathOf(primary), null);
      pid = null;
    } finally {
      if (pid !== null && isProcessAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* best effort cleanup */ }
      }
      fs.rmSync(linked, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }
);

test(
  'server start fails outside a Git worktree without writing a pid record',
  onPlatforms('linux', 'darwin'),
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-outside-git-'));
    try {
      const started = runServerFrom(dir, dir, 'start');
      assert.notEqual(started.status, 0);
      assert.match(started.stderr, /server: current directory is not inside a git repository/);
      assert.equal(pidPathOf(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'foreground and direct daemon entrypoints change cwd to the primary worktree',
  onPlatforms('linux'),
  async () => {
    const primary = makeRepo();
    const linked = path.join(os.tmpdir(), `${path.basename(primary)}-foreground-linked`);
    const primaryLog = path.join(primary, '.agent-infra', 'logs', PROJECT, 'server.log');
    try {
      fs.writeFileSync(path.join(primary, '.agents', 'server.json'), JSON.stringify({
        heartbeatMs: 100
      }));
      execFileSync('git', ['-C', primary, 'add', '.agents'], { env: gitSafeEnv() });
      execFileSync('git', ['-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'server config'], { env: gitSafeEnv() });
      execFileSync('git', ['-C', primary, 'worktree', 'add', '-b', 'linked-foreground-test', linked], { env: gitSafeEnv() });

      for (const args of [['start', '--foreground'], ['__daemon']]) {
        const child = spawn(process.execPath, [CLI_PATH, 'server', ...args], {
          cwd: linked,
          stdio: 'ignore',
          env: gitSafeEnv({ HOME: primary, USERPROFILE: primary })
        });
        assert.ok(child.pid);
        try {
          assert.ok(await waitFor(() => fs.existsSync(primaryLog) && /\[INFO\] heartbeat/.test(fs.readFileSync(primaryLog, 'utf8'))));
          assert.ok(await waitFor(() => {
            try {
              return fs.readlinkSync(`/proc/${child.pid}/cwd`) === primary;
            } catch {
              return false;
            }
          }));
        } finally {
          if (isProcessAlive(child.pid)) child.kill('SIGTERM');
          assert.ok(await waitFor(() => !isProcessAlive(child.pid as number)));
        }
      }
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
      fs.rmSync(primary, { recursive: true, force: true });
    }
  }
);

test(
  'server start clears a stale pid file left by a crashed daemon',
  onPlatforms('linux', 'darwin'),
  async () => {
    const dir = makeRepo();
    let pid: number | null = null;
    try {
      // Start a daemon, then SIGKILL it WITHOUT `stop` so the pid file is left
      // behind pointing at a now-dead process (a crash).
      assert.equal(runServer(dir, 'start').status, 0);
      const crashedPid = readPid(dir);
      assert.ok(crashedPid !== null, 'first daemon should write a pid file');
      process.kill(crashedPid, 'SIGKILL');
      assert.ok(await waitFor(() => !isProcessAlive(crashedPid)), 'crashed daemon should be gone');
      assert.ok(pidPathOf(dir) !== null, 'stale pid file should remain after a crash');

      const staleStatus = runServer(dir, 'status');
      assert.equal(staleStatus.status, 0, staleStatus.stderr);
      assert.match(staleStatus.stdout, /server: stopped/);
      assert.equal(pidPathOf(dir), null, 'status should remove the stale pid file');

      // Starting again after status cleanup must spawn a fresh daemon.
      assert.equal(runServer(dir, 'start').status, 0);
      pid = readPid(dir);
      assert.ok(pid !== null && pid !== crashedPid, 'stale pid should be replaced by a fresh daemon pid');
      assert.ok(await waitFor(() => isProcessAlive(pid as number)), 'fresh daemon should be alive');
    } finally {
      if (pid !== null && isProcessAlive(pid)) {
        runServer(dir, 'stop');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
    'server status and stop fail closed for invalid, legacy, and reused pid records without signaling unrelated processes',
  onPlatforms('linux', 'darwin'),
  async () => {
    const dir = makeRepo();
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    try {
      assert.equal(runServer(dir, 'start').status, 0);
      const pidPath = pidPathOf(dir);
      assert.ok(pidPath !== null, 'server start should create a pid record');
      assert.equal(runServer(dir, 'stop').status, 0);

      fs.writeFileSync(pidPath, 'invalid pid record\n');
      assert.match(runServer(dir, 'status').stdout, /legacy pid record/);
      assert.equal(fs.existsSync(pidPath), true, 'status must preserve an invalid record for the previous version');
      fs.unlinkSync(pidPath);

      assert.ok(typeof unrelated.pid === 'number');
      const unrelatedPid = unrelated.pid;
      assert.ok(await waitFor(() => isProcessAlive(unrelatedPid)), 'unrelated child should be alive');

      fs.writeFileSync(pidPath, `${unrelatedPid}\n`);
      assert.match(runServer(dir, 'stop').stderr, /legacy pid record/);
      assert.ok(isProcessAlive(unrelatedPid), 'stop must not trust or signal a legacy pid record');
      assert.equal(fs.existsSync(pidPath), true, 'stop must preserve the legacy record');
      fs.unlinkSync(pidPath);

      const startTime = getProcessStartTime(unrelatedPid);
      assert.ok(startTime !== null, 'unrelated child identity should be queryable');
      const mismatchedRecord = `${JSON.stringify({
        version: 1,
        pid: unrelatedPid,
        startTime: `${startTime}-from-previous-process`
      })}\n`;

      fs.writeFileSync(pidPath, mismatchedRecord);
      assert.match(runServer(dir, 'status').stdout, /legacy pid record/);
      assert.ok(isProcessAlive(unrelatedPid), 'status must not signal an unrelated process');
      assert.equal(fs.existsSync(pidPath), true, 'status must preserve the mismatched record');

      assert.match(runServer(dir, 'stop').stderr, /legacy pid record/);
      assert.ok(isProcessAlive(unrelatedPid), 'stop must not signal an unrelated process');
      assert.equal(fs.existsSync(pidPath), true, 'stop must preserve the mismatched record');
    } finally {
      if (typeof unrelated.pid === 'number' && isProcessAlive(unrelated.pid)) {
        process.kill(unrelated.pid, 'SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  'daemon removes its own pid record on direct graceful termination and repeated stop is idempotent',
  onPlatforms('linux', 'darwin'),
  async () => {
    const dir = makeRepo();
    let pid: number | null = null;
    try {
      assert.equal(runServer(dir, 'start').status, 0);
      pid = readPid(dir);
      assert.ok(pid !== null, 'daemon should publish a pid record');
      const ready = await waitFor(() => {
        const logPath = logPathOf(dir);
        return logPath !== null && /\[INFO\] heartbeat/.test(fs.readFileSync(logPath, 'utf8'));
      });
      assert.ok(ready, 'daemon signal handlers should be installed before direct SIGTERM');
      process.kill(pid, 'SIGTERM');
      assert.ok(await waitFor(() => !isProcessAlive(pid as number)), 'daemon should exit after SIGTERM');
      assert.ok(await waitFor(() => pidPathOf(dir) === null), 'daemon should remove its own pid record');
      pid = null;

      const firstStop = runServer(dir, 'stop');
      const secondStop = runServer(dir, 'stop');
      assert.match(firstStop.stdout, /server is not running/);
      assert.match(secondStop.stdout, /server is not running/);
    } finally {
      if (pid !== null && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
