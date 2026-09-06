#!/usr/bin/env node

import spawn from 'cross-spawn';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from './process-tree.js';
import { acquireTestRunLock, releaseTestRunLock, testRunLockEnv } from './test-run-lock.js';

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => {
    const normalized = key.toUpperCase();
    return normalized !== 'NODE_TEST_CONTEXT'
      && !normalized.startsWith('AGENT_INFRA_CONTROL_')
      && normalized !== 'AGENT_INFRA_TASK_ID'
      && normalized !== 'AGENT_INFRA_RUNTIME_DIR';
  })
);
const args = process.argv.slice(2);
const skipBuild = args[0] === '--skip-build';
if (skipBuild) args.shift();
const signals = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM']
  : ['SIGHUP', 'SIGINT', 'SIGTERM'];
let activeChild;
let receivedSignal;
let terminationPromise;
let testRunLock;

function forwardSignal(signal) {
  receivedSignal ??= signal;
  if (!activeChild || terminationPromise) return;
  terminationPromise = terminateProcessTree(activeChild, signal);
}

for (const signal of signals) {
  process.on(signal, forwardSignal);
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32'
    });
    activeChild = child;
    terminationPromise = undefined;
    if (receivedSignal) forwardSignal(receivedSignal);
    child.once('error', async (error) => {
      if (activeChild === child) activeChild = undefined;
      if (terminationPromise) await terminationPromise;
      reject(error);
    });
    child.once('close', async (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (terminationPromise) await terminationPromise;
      resolve({ code, signal });
    });
  });
}

function finish(result) {
  const signal = result.signal ?? receivedSignal;
  if (signal) {
    for (const registeredSignal of signals) {
      process.off(registeredSignal, forwardSignal);
    }
    process.kill(process.pid, signal);
    return false;
  }
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    return false;
  }
  return true;
}

try {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  testRunLock = await acquireTestRunLock(projectRoot);
  Object.assign(env, testRunLockEnv(testRunLock));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const buildSucceeded = skipBuild || finish(await run(npm, ['run', 'build']));
  if (buildSucceeded) {
    finish(await run(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      '--test',
      ...args
    ]));
  }
} catch (error) {
  if (receivedSignal) {
    finish({ code: null, signal: receivedSignal });
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  releaseTestRunLock(testRunLock);
  for (const signal of signals) {
    process.off(signal, forwardSignal);
  }
}
