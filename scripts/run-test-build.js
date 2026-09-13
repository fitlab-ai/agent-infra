#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest } from './test-build-manifest.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const generatedDirectories = [
  path.join(projectRoot, 'dist', 'tests'),
  path.join(projectRoot, 'dist', 'scripts')
];

for (const directory of generatedDirectories) {
  fs.rmSync(directory, { recursive: true, force: true });
}

const result = spawnSync(process.execPath, [tsc, '-p', path.join(projectRoot, 'tsconfig.test-build.json')], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit'
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
if (result.status !== 0) process.exit(result.status ?? 1);

writeManifest(projectRoot);
