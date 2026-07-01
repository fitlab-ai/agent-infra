import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { streamCommand } from '../../../lib/server/streamer.ts';
import { runAi } from '../../../lib/server/runner.ts';
import { envWithPrependedPath, writeNodeCommandShim } from '../../helpers.ts';

test('streamCommand chunks output, redacts secrets, and always sends exit status', async () => {
  const messages: string[] = [];
  await streamCommand(
    { title: '/run code-task #7', chunkChars: 10 },
    async () => ({
      exitCode: 1,
      signal: null,
      stdout: 'abcdefghijklmnop token=secret-value',
      stderr: ''
    }),
    async (text) => {
      messages.push(text);
    }
  );
  assert.match(messages[0] ?? '', /started/);
  assert.ok(messages.some((message) => message.includes('abcdefghij')));
  assert.ok(messages.every((message) => !message.includes('secret-value')));
  assert.match(messages.at(-1) ?? '', /exitCode=1/);
});

test('streamCommand can forward output before process completion', async () => {
  const messages: string[] = [];
  await streamCommand(
    { title: '/task ls', chunkChars: 100 },
    async (emit) => {
      await emit?.('early output');
      assert.deepEqual(messages, ['started /task ls', 'early output']);
      return { exitCode: 0, signal: null, stdout: 'early output', stderr: '' };
    },
    async (text) => {
      messages.push(text);
    }
  );
  assert.match(messages.at(-1) ?? '', /exitCode=0/);
});

test('streamCommand sends streamed payload before finished when reply is slow', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-streamer-'));
  const binDir = path.join(tmpDir, 'bin');
  const aiJsPath = path.join(binDir, 'ai.js');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(aiJsPath, "process.stdout.write('payload');\n", 'utf8');
  writeNodeCommandShim(path.join(binDir, 'ai'), aiJsPath);

  const originalEnv: NodeJS.ProcessEnv = { ...process.env };
  Object.assign(process.env, envWithPrependedPath(process.env, binDir));
  const messages: string[] = [];

  try {
    await streamCommand(
      { title: 'ai task ls', chunkChars: 100, throttleMs: 0 },
      (emit) => runAi(['task', 'ls'], { onChunk: emit }),
      async (text) => {
        if (text === 'payload') await delay(30);
        messages.push(text);
      }
    );

    assert.deepEqual(messages, ['started ai task ls', 'payload', 'finished ai task ls exitCode=0 signal=null']);
  } finally {
    process.env = originalEnv;
  }
});
