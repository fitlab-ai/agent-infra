#!/usr/bin/env node

import spawn from 'cross-spawn';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from './process-tree.js';
import { acquireTestRunLock, releaseTestRunLock, testRunLockEnv } from './test-run-lock.js';
import { testConcurrencyFromEnv } from './test-concurrency.js';
import { validateManifest } from './test-build-manifest.js';

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => {
    const normalized = key.toUpperCase();
    return normalized !== 'NODE_TEST_CONTEXT'
      && !normalized.startsWith('AGENT_INFRA_CONTROL_')
      && normalized !== 'AGENT_INFRA_TASK_ID'
      && normalized !== 'AGENT_INFRA_RUNTIME_DIR';
  })
);
const testIsolationModule = fileURLToPath(new URL('./test-status-mount-isolation.cjs', import.meta.url));
env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require=${testIsolationModule}`].filter(Boolean).join(' ');
const signals = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM']
  : ['SIGHUP', 'SIGINT', 'SIGTERM'];
let activeChild;
let receivedSignal;
let terminationPromise;
let testRunLock;
let hostControlService;
let hostControlReadyDir;

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

async function startHostControlTestService(projectRoot) {
  if (!testRunLock?.owned || String(process.platform) === 'win32') return;
  const testRoot = process.platform === 'darwin'
    ? fs.realpathSync.native(os.homedir())
    : os.tmpdir();
  hostControlReadyDir = fs.mkdtempSync(path.join(testRoot, '.agent-infra-host-control-'));
  const readyPath = path.join(hostControlReadyDir, 'ready');
  env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = path.join(hostControlReadyDir, 'host-control.sock');
  hostControlService = spawn(process.execPath, [
    '--experimental-strip-types', '--no-warnings',
    path.join(projectRoot, 'scripts', 'test-host-control-service.ts')
  ], {
    cwd: projectRoot,
    env: { ...env, NODE_OPTIONS: '', AGENT_INFRA_TEST_HOST_CONTROL_READY: readyPath },
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (fs.existsSync(readyPath)) { resolve(true); return; }
      if (hostControlService.exitCode !== null || hostControlService.signalCode !== null) {
        reject(new Error('host-control test service failed to start'));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('host-control test service did not become ready'));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function stopHostControlTestService() {
  const child = hostControlService;
  hostControlService = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
  }
  if (hostControlReadyDir) fs.rmSync(hostControlReadyDir, { recursive: true, force: true });
  delete env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
  hostControlReadyDir = undefined;
}

function normalizeArgument(value) {
  return value.replaceAll('\\', '/');
}

function isLogicalTestSelection(value) {
  const normalized = normalizeArgument(value);
  return normalized.startsWith('tests/')
    && !normalized.startsWith('tests/fixtures/')
    && normalized.endsWith('.test.ts');
}

function mapLogicalTestSelection(value) {
  const normalized = normalizeArgument(value);
  if (!isLogicalTestSelection(normalized)) return value;
  return `dist/${normalized.slice(0, -3)}.js`;
}

function mapCoverageValue(value) {
  const normalized = normalizeArgument(value);
  if ((normalized === 'tests' || normalized.startsWith('tests/')) && !normalized.startsWith('tests/fixtures/')) {
    return `dist/${normalized}`;
  }
  return value;
}

function mapTestArguments(inputArgs) {
  const mapped = [];
  let requiresTestBuild = false;
  for (let index = 0; index < inputArgs.length; index += 1) {
    const value = inputArgs[index];
    if (value === '--test-coverage-exclude') {
      mapped.push(value);
      const next = inputArgs[index + 1];
      if (next !== undefined) {
        mapped.push(mapCoverageValue(next));
        requiresTestBuild ||= mapCoverageValue(next) !== next;
        index += 1;
      }
      continue;
    }
    if (value.startsWith('--test-coverage-exclude=')) {
      const coverageValue = value.slice('--test-coverage-exclude='.length);
      mapped.push(`--test-coverage-exclude=${mapCoverageValue(coverageValue)}`);
      requiresTestBuild ||= mapCoverageValue(coverageValue) !== coverageValue;
      continue;
    }
    const next = mapLogicalTestSelection(value);
    requiresTestBuild ||= next !== value || normalizeArgument(value).startsWith('dist/tests/');
    mapped.push(next);
  }
  return { args: mapped, requiresTestBuild };
}

async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args[0] === '--skip-build';
  if (skipBuild) args.shift();
  const mapped = mapTestArguments(args);
  const testConcurrency = testConcurrencyFromEnv(env);
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  testRunLock = await acquireTestRunLock(projectRoot);
  Object.assign(env, testRunLockEnv(testRunLock));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (skipBuild && mapped.requiresTestBuild) {
    const manifest = validateManifest(projectRoot);
    if (manifest.ok === false) throw new Error(manifest.message);
  }
  const buildSucceeded = skipBuild
    ? true
    : finish(await run(npm, ['run', 'build'])) && finish(await run(npm, ['run', 'build:test']));
  if (!buildSucceeded) return;
  await startHostControlTestService(projectRoot);
  finish(await run(process.execPath, [
    '--no-warnings',
    '--test',
    '--test-concurrency',
    String(testConcurrency),
    ...mapped.args
  ]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    if (receivedSignal) {
      finish({ code: null, signal: receivedSignal });
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } finally {
    await stopHostControlTestService();
    releaseTestRunLock(testRunLock);
    for (const signal of signals) {
      process.off(signal, forwardSignal);
    }
  }
}

export { isLogicalTestSelection, mapCoverageValue, mapLogicalTestSelection, mapTestArguments };
