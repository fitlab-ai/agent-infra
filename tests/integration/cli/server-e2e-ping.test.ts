import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH, filePath, onPlatforms, gitSafeEnv, initIsolatedGitRepo } from '../../helpers.ts';
import { VERSION } from '../../../lib/version.ts';

// End-to-end /ping → pong proof (HD-1 / PL-1). A real built daemon subprocess
// loads the plain-ESM test injection adapter from tests/fixtures via the
// AGENT_INFRA_SERVER_TEST_ADAPTERS_DIR seam, which injects a "/ping" message
// through the actual loadAdapters → start → ctx.dispatch → reply path. The reply
// is written to the server log, where this test asserts on it. No real feishu.

const PROJECT = 'e2e-ping';
const TEST_ADAPTERS_DIR = filePath('tests/fixtures/server-adapters');

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-e2e-ping-'));
  initIsolatedGitRepo(dir);
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', '.airc.json'), JSON.stringify({ project: PROJECT }));
  fs.writeFileSync(
    path.join(dir, '.agents', 'server.json'),
    JSON.stringify({ heartbeatMs: 100, adapters: { 'ping-inject': { enabled: true } } })
  );
  return dir;
}

// HOME pins runtime paths under the temp dir (hermetic); the test-adapters dir
// env makes the built daemon resolve the .js fixture. start and stop must share
// this exact cwd+env so stop reads the same pid file the daemon wrote.
function serverEnv(dir: string): NodeJS.ProcessEnv {
  return gitSafeEnv({ HOME: dir, USERPROFILE: dir, AGENT_INFRA_SERVER_TEST_ADAPTERS_DIR: TEST_ADAPTERS_DIR });
}

function runServer(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, 'server', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: serverEnv(dir)
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

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

function readLog(dir: string): string {
  const logPath = findUnder(path.join(dir, '.agent-infra', 'logs', PROJECT), 'server.log');
  if (logPath === null) return '';
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test(
  'a daemon-injected /ping is dispatched and answered with pong v<VERSION>',
  onPlatforms('linux', 'darwin'),
  async () => {
    const dir = makeRepo();
    try {
      const started = runServer(dir, 'start');
      assert.equal(started.status, 0, started.stderr);

      const expected = `ping-inject reply: pong ${VERSION}`;
      const answered = await waitFor(() => readLog(dir).includes(expected));
      assert.ok(answered, `expected the daemon log to contain "${expected}"; got:\n${readLog(dir)}`);
    } finally {
      runServer(dir, 'stop');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
