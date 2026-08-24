import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { filePath, onPlatforms, sandboxControlSafeEnv } from '../../helpers.ts';
import { terminateProcessTree } from '../../../scripts/process-tree.js';
import {
  acquireTestRunLock,
  releaseTestRunLock,
  testRunLockEnv,
  testRunLockPath
} from '../../../scripts/test-run-lock.js';

const RUNNER = filePath('scripts/run-tests.js');

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null };

function waitForClose(child: ChildProcess): Promise<ProcessResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

test('project test scripts use the sandbox-control-safe runner', () => {
  const pkg = JSON.parse(fs.readFileSync(filePath('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const name of [
    'test:smoke',
    'test:core',
    'test:integration',
    'test',
    'test:coverage',
    'prepublishOnly'
  ]) {
    const script = pkg.scripts[name] ?? '';
    assert.equal(script.startsWith('node scripts/run-tests.js'), true);
  }
});

test('test runner lock serializes independent runs and permits inherited reentry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-lock-'));
  let first: Awaited<ReturnType<typeof acquireTestRunLock>> | undefined;
  let second: Awaited<ReturnType<typeof acquireTestRunLock>> | undefined;
  try {
    first = await acquireTestRunLock(root, { env: {} });
    assert.equal(first.owned, true);
    assert.equal(fs.existsSync(testRunLockPath(root)), true);

    const reentered = await acquireTestRunLock(root, { env: testRunLockEnv(first) });
    assert.equal(reentered.owned, false);

    let secondResolved = false;
    const secondPromise = acquireTestRunLock(root, { env: {}, retryMs: 10 }).then((lock) => {
      secondResolved = true;
      return lock;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondResolved, false);

    releaseTestRunLock(first);
    second = await secondPromise;
    assert.equal(second.owned, true);
    releaseTestRunLock(second);
    assert.equal(fs.existsSync(testRunLockPath(root)), false);
  } finally {
    releaseTestRunLock(second);
    releaseTestRunLock(first);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test runner lock recovers ownership left by a dead process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-stale-lock-'));
  const lockPath = testRunLockPath(root);
  let recovered: Awaited<ReturnType<typeof acquireTestRunLock>> | undefined;
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      version: 1,
      pid: 999_999_999,
      token: 'stale-owner',
      createdAt: Date.now()
    })}\n`);

    recovered = await acquireTestRunLock(root, { env: {}, retryMs: 10 });
    assert.equal(recovered.owned, true);
  } finally {
    releaseTestRunLock(recovered);
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test runner strips inherited sandbox control authority before loading tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-'));
  const fixture = path.join(root, 'environment.test.mjs');
  fs.writeFileSync(fixture, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('environment', () => {",
    "  assert.equal(Object.keys(process.env).some((key) =>",
    "    key.toUpperCase().startsWith('AGENT_INFRA_CONTROL_')",
    "  ), false);",
    "  assert.equal(process.env.AGENT_INFRA_TEST_SENTINEL, 'preserved');",
    "  assert.notEqual(process.env.NODE_TEST_CONTEXT, 'inherited-context');",
    '});',
    ''
  ].join('\n'));

  try {
    const result = spawnSync(process.execPath, [RUNNER, '--skip-build', fixture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        agent_infra_control_token: 'live-token',
        Agent_Infra_Control_Dir: path.join(root, 'live-channel'),
        aGeNt_InFrA_cOnTrOl_FuTuRe: 'future-authority',
        Node_Test_Context: 'inherited-context',
        AGENT_INFRA_TEST_SENTINEL: 'preserved'
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test runner strips inherited sandbox control authority before building', onPlatforms('linux', 'darwin'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-build-'));
  const npm = path.join(root, 'npm');
  const observed = path.join(root, 'observed.json');
  fs.writeFileSync(npm, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.AGENT_INFRA_TEST_OBSERVED, JSON.stringify(process.env));",
    'process.exitCode = 1;',
    ''
  ].join('\n'));
  fs.chmodSync(npm, 0o755);

  try {
    const result = spawnSync(process.execPath, [RUNNER, 'unused.test.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [root, process.env.PATH].filter(Boolean).join(path.delimiter),
        agent_infra_control_token: 'live-token',
        Agent_Infra_Control_Dir: 'live-channel',
        aGeNt_InFrA_cOnTrOl_FuTuRe: 'future-authority',
        AGENT_INFRA_TEST_OBSERVED: observed
      }
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const buildEnv = JSON.parse(fs.readFileSync(observed, 'utf8')) as NodeJS.ProcessEnv;
    assert.equal(Object.keys(buildEnv).some(
      (key) => key.toUpperCase().startsWith('AGENT_INFRA_CONTROL_')
    ), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test runner preserves a failing test exit code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-failure-'));
  const fixture = path.join(root, 'failure.test.mjs');
  fs.writeFileSync(fixture, [
    "import test from 'node:test';",
    "test('failure', () => { throw new Error('expected failure'); });",
    ''
  ].join('\n'));

  try {
    const result = spawnSync(process.execPath, [RUNNER, '--skip-build', fixture], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test runner forwards termination signals', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-signal-'));
  const fixture = path.join(root, 'signal.test.mjs');
  const ready = path.join(root, 'ready');
  fs.writeFileSync(fixture, [
    "import test from 'node:test';",
    "import fs from 'node:fs';",
    "test('wait', async () => {",
    "  fs.writeFileSync(process.env.AGENT_INFRA_TEST_READY, '');",
    "  await new Promise((resolve) => setTimeout(resolve, 60_000));",
    '});',
    ''
  ].join('\n'));

  const child = spawn(process.execPath, [RUNNER, '--skip-build', fixture], {
    env: { ...process.env, AGENT_INFRA_TEST_READY: ready },
    stdio: 'ignore'
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(ready), true, 'test process did not become ready');
    const close = waitForClose(child);
    child.kill('SIGTERM');
    const result = await close;
    assert.deepEqual(result, { code: null, signal: 'SIGTERM' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test runner terminates the complete build process group', onPlatforms('linux', 'darwin'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-tree-'));
  const npm = path.join(root, 'npm');
  const ready = path.join(root, 'grandchild.pid');
  const terminated = path.join(root, 'grandchild.terminated');
  fs.writeFileSync(npm, [
    '#!/usr/bin/env node',
    "import { spawn } from 'node:child_process';",
    "spawn(process.execPath, ['-e', `",
    "  process.on('SIGTERM', () => {",
    "    require('node:fs').writeFileSync(process.env.AGENT_INFRA_TEST_TERMINATED, String(process.pid));",
    "    process.exit(0);",
    "  });",
    "  require('node:fs').writeFileSync(process.env.AGENT_INFRA_TEST_READY, String(process.pid));",
    "  setInterval(() => {}, 1000);",
    "`], { env: process.env, stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));
  fs.chmodSync(npm, 0o755);

  const runner = spawn(process.execPath, [RUNNER, 'unused.test.mjs'], {
    env: {
      ...process.env,
      PATH: [root, process.env.PATH].filter(Boolean).join(path.delimiter),
      AGENT_INFRA_TEST_READY: ready,
      AGENT_INFRA_TEST_TERMINATED: terminated
    },
    stdio: 'ignore'
  });
  let grandchildPid: number | undefined;
  try {
    const readyDeadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(ready), true, 'build grandchild did not become ready');
    grandchildPid = Number(fs.readFileSync(ready, 'utf8'));
    const close = waitForClose(runner);
    runner.kill('SIGTERM');
    const result = await close;
    assert.deepEqual(result, { code: null, signal: 'SIGTERM' });

    const exitDeadline = Date.now() + 2_000;
    while (!fs.existsSync(terminated) && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(terminated), true, 'build grandchild did not receive SIGTERM');
    assert.equal(Number(fs.readFileSync(terminated, 'utf8')), grandchildPid);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // The expected path already terminated the process group.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows process tree termination invokes taskkill for the captured PID', async () => {
  const child = { pid: 1234, kill: () => assert.fail('direct fallback was not expected') } as unknown as ChildProcess;
  const killer = new EventEmitter() as ChildProcess;
  const calls: unknown[][] = [];
  const spawnProcess = ((...args: unknown[]) => {
    calls.push(args);
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  }) as never;

  await terminateProcessTree(child, 'SIGTERM', 'win32', spawnProcess);
  assert.deepEqual(calls, [[
    'taskkill',
    ['/pid', '1234', '/t', '/f'],
    { stdio: 'ignore', windowsHide: true }
  ]]);
});

test('Windows process tree termination falls back when taskkill fails', async () => {
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 1234,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      return true;
    }
  } as unknown as ChildProcess;
  const killer = new EventEmitter() as ChildProcess;
  const spawnProcess = (() => {
    queueMicrotask(() => killer.emit('error', new Error('taskkill unavailable')));
    queueMicrotask(() => killer.emit('close', 1));
    return killer;
  }) as never;

  await terminateProcessTree(child, 'SIGTERM', 'win32', spawnProcess);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('Windows process tree termination kills the complete build tree', onPlatforms('win32'), async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-test-runner-win-tree-'));
  const build = path.join(root, 'build.mjs');
  const ready = path.join(root, 'processes.json');
  fs.writeFileSync(build, [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.env.AGENT_INFRA_TEST_READY, JSON.stringify([process.pid, child.pid]));",
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));

  const buildProcess = spawn(process.execPath, [build], {
    env: {
      ...process.env,
      AGENT_INFRA_TEST_READY: ready
    },
    stdio: 'ignore'
  });
  let processIds: number[] = [];
  try {
    const readyDeadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(ready), true, 'Windows build processes did not become ready');
    processIds = JSON.parse(fs.readFileSync(ready, 'utf8')) as number[];
    await terminateProcessTree(buildProcess, 'SIGTERM');
    await waitForClose(buildProcess);

    const exitDeadline = Date.now() + 5_000;
    let alive = processIds;
    while (alive.length > 0 && Date.now() < exitDeadline) {
      alive = alive.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (alive.length > 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(alive, [], 'Windows build descendants survived runner termination');
  } finally {
    if (buildProcess.exitCode === null && buildProcess.signalCode === null) {
      spawnSync('taskkill', ['/pid', String(buildProcess.pid), '/t', '/f'], { stdio: 'ignore' });
    }
    for (const pid of processIds) {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox control safe env strips mixed-case authority keys', () => {
  assert.deepEqual(sandboxControlSafeEnv({
    agent_infra_control_token: 'live-token',
    Agent_Infra_Control_Dir: 'live-channel',
    aGeNt_InFrA_cOnTrOl_FuTuRe: 'future-authority',
    AGENT_INFRA_TEST_SENTINEL: 'preserved'
  }), {
    AGENT_INFRA_TEST_SENTINEL: 'preserved'
  });
});
