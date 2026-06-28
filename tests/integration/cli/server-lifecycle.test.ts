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
  const result = spawnSync(process.execPath, [CLI_PATH, 'server', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: gitSafeEnv({ HOME: dir, USERPROFILE: dir })
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The default runtime paths include an opaque per-repo-hash segment
// (~/.agent-infra/<kind>/<project>/<repo-hash>/server.*), so locate the files by
// searching under the pinned-HOME tree rather than reconstructing the hash.
function findUnder(root: string, name: string): string | null {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function logPathOf(dir: string): string | null {
  return findUnder(path.join(dir, '.agent-infra', 'logs', PROJECT), 'server.log');
}

function pidPathOf(dir: string): string | null {
  return findUnder(path.join(dir, '.agent-infra', 'run', PROJECT), 'server.pid');
}

function readPid(dir: string): number | null {
  const pidPath = pidPathOf(dir);
  if (pidPath === null) return null;
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
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

      // Starting again must detect the stale pid, clean it, and spawn a fresh daemon.
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
