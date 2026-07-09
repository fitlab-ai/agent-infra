import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commandResult,
  normalizeOutbound,
  outboundToText,
  replyOutbound,
  statusCard,
  streamEvent,
	  tableMessage
	} from '../../../lib/server/display.ts';
import type { OutboundMessage } from '../../../lib/server/display.ts';

test('normalizeOutbound preserves display messages and wraps plain text', () => {
  assert.deepEqual(normalizeOutbound('hello'), { kind: 'text', text: 'hello' });
  const message = statusCard('Build', 'running', [['step', 'test']]);
  assert.equal(normalizeOutbound(message), message);
});

test('outboundToText renders table, status, stream, and command result fallbacks', () => {
  assert.equal(
    outboundToText(tableMessage(['name', 'state'], [['task', 'active']], 'Tasks')),
    'Tasks\nname | state\n--- | ---\ntask | active'
  );
  assert.equal(outboundToText(statusCard('Deploy', 'success', [['env', 'prod']], 'done')), 'Deploy\nenv: prod\ndone');
  assert.equal(outboundToText(streamEvent('ai task ls', 'started')), 'started ai task ls');
  assert.equal(outboundToText(streamEvent('ai task ls', 'chunk', 'payload')), 'payload');
  assert.equal(
    outboundToText(streamEvent('ai task ls', 'finished', undefined, 0, null)),
    'finished ai task ls exitCode=0 signal=null'
  );
  assert.equal(
    outboundToText(commandResult('ai task ls', 1, null, 'out', 'err')),
    'finished ai task ls exitCode=1 signal=null\nout\nerr'
	  );
	});

test('outboundToText returns a visible fallback for unknown display kinds', () => {
  const unknown = { kind: 'future-kind' } as unknown as OutboundMessage;
  assert.equal(outboundToText(unknown), '[unknown: future-kind]');
});

test('replyOutbound prefers structured replies and falls back to text replies', async () => {
  const structured: unknown[] = [];
  await replyOutbound(
    {
      reply: async () => {
        throw new Error('text fallback should not be used');
      },
      replyDisplay: async (message) => {
        structured.push(message);
      }
    },
    streamEvent('ai task ls', 'started')
  );
  assert.deepEqual(structured, [{ kind: 'stream-event', title: 'ai task ls', phase: 'started' }]);

  const text: string[] = [];
  await replyOutbound(
    {
      reply: async (message) => {
        text.push(message);
      }
    },
    streamEvent('ai task ls', 'finished', undefined, 0, null)
  );
  assert.deepEqual(text, ['finished ai task ls exitCode=0 signal=null']);
});
