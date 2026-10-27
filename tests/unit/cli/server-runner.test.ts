import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runAi } from '../../../lib/server/runner.ts';
import { createTempDir, envWithPrependedPath, writeNodeCommandShim } from '../../helpers.ts';

test('runAi spawns ai with argv and captures stdout/stderr', async () => {
  const result = await runAi(['task', 'status', '#7'], {
    spawn: async (file, args) => ({
      exitCode: 3,
      signal: null,
      stdout: `${file} ${args.join(' ')}`,
      stderr: 'err'
    })
  });
  assert.deepEqual(result, {
    exitCode: 3,
    signal: null,
    stdout: 'ai task status #7',
    stderr: 'err'
  });
});

test('runAi waits for asynchronous chunk callbacks before resolving', async () => {
  const tmpDir = createTempDir('server-runner-');
  const binDir = path.join(tmpDir, 'bin');
  const aiJsPath = path.join(binDir, 'ai.js');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(aiJsPath, "process.stdout.write('payload');\n", 'utf8');
  writeNodeCommandShim(path.join(binDir, 'ai'), aiJsPath);

  const originalEnv: NodeJS.ProcessEnv = { ...process.env };
  Object.assign(process.env, envWithPrependedPath(process.env, binDir));
  const chunks: string[] = [];

  try {
    const result = await runAi(['task', 'ls'], {
      onChunk: async (chunk) => {
        await delay(30);
        chunks.push(chunk);
      }
    });

    assert.equal(result.stdout, 'payload');
    assert.deepEqual(chunks, ['payload']);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test('runAi runs commands from the configured working directory', async () => {
  const tmpDir = createTempDir('server-runner-cwd-');
  const binDir = path.join(tmpDir, 'bin');
  const aiJsPath = path.join(binDir, 'ai.js');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(aiJsPath, "process.stdout.write(process.cwd());\n", 'utf8');
  writeNodeCommandShim(path.join(binDir, 'ai'), aiJsPath);

  const originalEnv: NodeJS.ProcessEnv = { ...process.env };
  Object.assign(process.env, envWithPrependedPath(process.env, binDir));
  try {
    const result = await runAi(['task', 'ls'], { cwd: tmpDir });
    assert.equal(fs.realpathSync.native(result.stdout), fs.realpathSync.native(tmpDir));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
