#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { acquireTestRunLock, releaseTestRunLock } from './test-run-lock.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
/** @type {Array<[string, string[]]>} */
const commands = [
  [process.execPath, [tsc, '-p', 'tsconfig.json']],
  [process.execPath, [path.join(projectRoot, 'scripts', 'build.js')]],
  [process.execPath, [path.join(projectRoot, 'scripts', 'build-inline.js')]]
];

let lock;
let childSignal;
try {
  lock = await acquireTestRunLock(projectRoot);
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd: projectRoot, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal) {
      childSignal = result.signal;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  releaseTestRunLock(lock);
}

if (childSignal) process.kill(process.pid, childSignal);
