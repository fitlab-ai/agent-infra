import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { streamCommand } from '../../../lib/server/streamer.ts';
import { runAi } from '../../../lib/server/runner.ts';
import { outboundToText, type DisplayMessage, type OutboundMessage } from '../../../lib/server/display.ts';
import { envWithPrependedPath, writeNodeCommandShim } from '../../helpers.ts';

function isDisplayKind<K extends DisplayMessage['kind']>(
  message: OutboundMessage,
  kind: K
): message is Extract<DisplayMessage, { kind: K }> {
  return typeof message !== 'string' && message.kind === kind;
}

test('streamCommand chunks output, redacts secrets, and always sends exit status', async () => {
  const messages: OutboundMessage[] = [];
  await streamCommand(
    { title: '/run code-task #7', chunkChars: 10 },
    async () => ({
      exitCode: 1,
      signal: null,
      stdout: 'abcdefghijklmnop token=secret-value',
      stderr: ''
    }),
    async (message) => {
      messages.push(message);
    }
  );
  assert.deepEqual(messages[0], { kind: 'stream-event', title: '/run code-task #7', phase: 'started' });
  assert.ok(messages.some((message) => isDisplayKind(message, 'stream-event') && message.text?.includes('abcdefghij')));
  assert.ok(messages.every((message) => !outboundToText(message).includes('secret-value')));
  assert.deepEqual(messages.at(-1), {
    kind: 'stream-event',
    title: '/run code-task #7',
    phase: 'finished',
    exitCode: 1,
    signal: null
  });
});

test('streamCommand can forward output before process completion', async () => {
  const messages: OutboundMessage[] = [];
  await streamCommand(
    { title: '/task ls', chunkChars: 100 },
    async (emit) => {
      await emit?.('early output');
      assert.deepEqual(messages.map(outboundToText), ['started /task ls', 'early output']);
      return { exitCode: 0, signal: null, stdout: 'early output', stderr: '' };
    },
    async (message) => {
      messages.push(message);
    }
  );
  assert.equal(outboundToText(messages.at(-1) ?? ''), 'finished /task ls exitCode=0 signal=null');
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
  const messages: OutboundMessage[] = [];

  try {
    await streamCommand(
      { title: 'ai task ls', chunkChars: 100, throttleMs: 0 },
      (emit) => runAi(['task', 'ls'], { onChunk: emit }),
      async (message) => {
        if (outboundToText(message) === 'payload') await delay(30);
        messages.push(message);
      }
    );

    assert.deepEqual(messages.map(outboundToText), [
      'started ai task ls',
      'payload',
      'finished ai task ls exitCode=0 signal=null'
    ]);
  } finally {
    process.env = originalEnv;
  }
});

test('streamCommand keeps old adapter text fallback stable through outboundToText', async () => {
  const textFallback: string[] = [];
  await streamCommand(
    { title: 'ai task ls', chunkChars: 100 },
    async (emit) => {
      await emit?.('payload');
      return { exitCode: 0, signal: null, stdout: 'payload', stderr: '' };
    },
    async (message) => {
      textFallback.push(outboundToText(message));
    }
  );

  assert.deepEqual(textFallback, ['started ai task ls', 'payload', 'finished ai task ls exitCode=0 signal=null']);
});
