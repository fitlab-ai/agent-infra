import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageDispatcher } from '../../../lib/server/daemon.ts';
import { outboundToText, type DisplayMessage, type OutboundMessage } from '../../../lib/server/display.ts';
import type { InboundMessage } from '../../../lib/server/adapters/_contract.ts';
import type { ServerConfig } from '../../../lib/server/config.ts';
import type { RunnerResult } from '../../../lib/server/runner.ts';
import type { StatusModel } from '../../../lib/task/commands/status.ts';

const config: ServerConfig = {
  repoRoot: '/tmp/repo',
  pidFile: '/tmp/server.pid',
  log: { path: '/tmp/server.log', rotateAtBytes: 1024 },
  heartbeatMs: 30_000,
  adapters: {},
  auth: { users: { 'test:u1': { role: 'read' }, 'test:exec': { role: 'exec' } } },
  stream: { chunkChars: 100, throttleMs: 0 }
};

function inbound(text: string, userId = 'u1'): { message: InboundMessage; textReplies: string[]; displayReplies: OutboundMessage[] } {
  const textReplies: string[] = [];
  const displayReplies: OutboundMessage[] = [];
  return {
    textReplies,
    displayReplies,
    message: {
      adapter: 'test',
      userId,
      chatId: 'c1',
      text,
      messageId: 'm1',
      raw: {},
      reply: async (replyText) => {
        textReplies.push(replyText);
      },
      replyDisplay: async (display) => {
        displayReplies.push(display);
      }
    }
  };
}

function displayKind(message: OutboundMessage): DisplayMessage['kind'] {
  if (typeof message === 'string') throw new Error(`expected display message, got ${message}`);
  return message.kind;
}

const statusModel: StatusModel = {
  taskId: 'TASK-20260101-000001',
  shortId: '#01',
  title: 'demo title',
  metadata: [['current_step', 'code']],
  workflowWarnings: [],
  artifacts: { count: 1, groups: [{ stage: 'plan', files: ['plan.md'] }] },
  workflow: {
    state: 'in-progress',
    step: 'Code Task (Round 1)',
    agent: 'codex',
    startedAt: '2026-07-02 20:00:00+08:00',
    doneAt: '-',
    stale: 'no'
  },
  runtime: {
    mode: 'none',
    status: '-',
    run: '-',
    tmux: '-',
    startedAt: '-',
    finishedAt: '-',
    exitCode: '-',
    log: '-'
  },
  git: {
    current: 'feat',
    frontmatter: 'feat',
    match: 'yes',
    exists: 'yes',
    uncommitted: 'clean',
    aheadBehind: '-'
  }
};

test('dispatcher sends builtin replies through text fallback when structured reply is unavailable', async () => {
  const replies: string[] = [];
  const message: InboundMessage = {
    ...inbound('/ping').message,
    reply: async (text) => {
      replies.push(text);
    },
    replyDisplay: undefined
  };
  const dispatch = createMessageDispatcher({ config, logger: { info: () => {} } });

  await dispatch(message);

  assert.equal(replies.length, 1);
  assert.match(replies[0] ?? '', /^pong /);
});

test('dispatcher sends ai command streams as structured messages', async () => {
  const { message, displayReplies } = inbound('/task ls');
  const dispatch = createMessageDispatcher({
    config,
    logger: { info: () => {} },
    runAi: async (_argv, options): Promise<RunnerResult> => {
      await options?.onChunk?.('tasks');
      return { exitCode: 0, signal: null, stdout: 'tasks', stderr: '' };
    }
  });

  await dispatch(message);

  assert.deepEqual(displayReplies.map(displayKind), ['stream-event', 'stream-event', 'stream-event']);
  assert.deepEqual(displayReplies.map(outboundToText), [
    'started ai task ls',
    'tasks',
    'finished ai task ls exitCode=0 signal=null'
  ]);
});

test('dispatcher renders /task status directly from StatusModel', async () => {
  const { message, displayReplies } = inbound('/task status #01');
  const dispatch = createMessageDispatcher({
    config,
    logger: { info: () => {} },
    buildStatusModel: () => statusModel
  });

  await dispatch(message);

  assert.equal(displayReplies.length, 1);
  assert.equal(displayKind(displayReplies[0] ?? ''), 'status-card');
  assert.match(outboundToText(displayReplies[0] ?? ''), /Task TASK-20260101-000001/);
});

test('dispatcher falls back to streaming text path when /task status direct model fails', async () => {
  const { message, displayReplies } = inbound('/task status #missing');
  const dispatch = createMessageDispatcher({
    config,
    logger: { info: () => {} },
    buildStatusModel: () => {
      throw new Error('not found');
    },
    runAi: async (): Promise<RunnerResult> => ({ exitCode: 1, signal: null, stdout: '', stderr: 'not found' })
  });

  await dispatch(message);

  assert.deepEqual(displayReplies.map(outboundToText), [
    'started ai task status #missing',
    'not found',
    'finished ai task status #missing exitCode=1 signal=null'
  ]);
});
