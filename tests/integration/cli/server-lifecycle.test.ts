import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH, onPlatforms, gitSafeEnv, initIsolatedGitRepo, escapeRegExp } from '../../helpers.ts';
import { buildStopCommand, isProcessAlive } from '../../../lib/server/process-control.ts';

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

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-lifecycle-'));
  initIsolatedGitRepo(dir);
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  // Fast heartbeat so the test observes liveness quickly.
  fs.writeFileSync(path.join(dir, '.agents', 'server.json'), JSON.stringify({ heartbeatMs: 100 }));
  return dir;
}

function runServer(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, 'server', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: gitSafeEnv()
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readPid(dir: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(dir, '.agents', 'server.pid'), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
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
    const logPath = path.join(dir, '.agents', 'server.log');
    let pid: number | null = null;
    try {
      const started = runServer(dir, 'start');
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /server started \(pid \d+\)/);

      pid = readPid(dir);
      assert.ok(pid !== null && pid > 0, 'pid file should contain a live pid');
      const livePid = pid;

      // PL-1: the daemon must stay alive and emit a heartbeat (not exit on start).
      const beat = await waitFor(
        () => fs.existsSync(logPath) && /\[INFO\] heartbeat/.test(fs.readFileSync(logPath, 'utf8'))
      );
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
      assert.equal(fs.existsSync(path.join(dir, '.agents', 'server.pid')), false, 'pid file removed on stop');
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
  'server start clears a stale pid file left by a dead daemon',
  onPlatforms('linux', 'darwin'),
  async () => {
    const dir = makeRepo();
    let pid: number | null = null;
    try {
      // A short-lived probe process gives a pid that is guaranteed dead.
      const probe = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const stalePid = probe.pid ?? 999_999;
      fs.writeFileSync(path.join(dir, '.agents', 'server.pid'), `${stalePid}\n`);

      const started = runServer(dir, 'start');
      assert.equal(started.status, 0, started.stderr);
      pid = readPid(dir);
      assert.ok(pid !== null && pid !== stalePid, 'stale pid should be replaced by a fresh daemon pid');
      assert.ok(await waitFor(() => isProcessAlive(pid as number)), 'fresh daemon should be alive');
    } finally {
      if (pid !== null && isProcessAlive(pid)) {
        runServer(dir, 'stop');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
