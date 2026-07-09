import test from 'node:test';
import assert from 'node:assert/strict';

import feishuFactory, { createFeishuAdapter } from '../../../lib/server/adapters/feishu/index.ts';
import {
  createFeishuTransport,
  normalizeMessage,
  toFeishuCreateData
} from '../../../lib/server/adapters/feishu/transport.ts';
import {
  cleanFeishuText,
  renderFeishuMessage
} from '../../../lib/server/adapters/feishu/renderer.ts';
import type { FeishuMessagePayload, FeishuTransport } from '../../../lib/server/adapters/feishu/transport.ts';
import type { AdapterCtx, InboundMessage } from '../../../lib/server/adapters/_contract.ts';
import type { OutboundMessage } from '../../../lib/server/display.ts';

// Build an im.message.receive_v1 event the way the SDK delivers it: content is a
// JSON string, mentions are injected as "@_user_N" placeholders in the text.
function receiveEvent(text: string): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_123', union_id: 'on_123', user_id: 'u_123' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text })
    }
  };
}

test('normalizeMessage maps a receive_v1 event and strips @-mentions', () => {
  const normalized = normalizeMessage(receiveEvent('@_user_1 /ping'));
  assert.equal(normalized.text, '/ping');
  assert.equal(normalized.chatId, 'oc_chat');
  assert.equal(normalized.messageId, 'om_1');
  assert.equal(normalized.userId, 'ou_123');
});

test('normalizeMessage falls back through sender id types', () => {
  const event = receiveEvent('hi') as { sender: { sender_id: Record<string, unknown> } };
  delete event.sender.sender_id.open_id;
  assert.equal(normalizeMessage(event).userId, 'on_123');
});

test('normalizeMessage throws on a malformed event (missing message fields)', () => {
  assert.throws(() => normalizeMessage({ message: { chat_id: 'oc' } }), /malformed/);
});

test('normalizeMessage throws when content is not JSON', () => {
  const event = { message: { message_id: 'om_1', chat_id: 'oc', content: 'not-json' } };
  assert.throws(() => normalizeMessage(event), /not valid JSON/);
});

// A fake transport: records sends and exposes a hook to fire an inbound event,
// standing in for the real long connection so the adapter wiring is testable
// without the SDK.
function fakeTransport(): {
  transport: FeishuTransport;
  sends: Array<{ chatId: string; message: FeishuMessagePayload }>;
  fire: (raw: unknown) => Promise<void>;
  stopped: () => boolean;
} {
  const sends: Array<{ chatId: string; message: FeishuMessagePayload }> = [];
  let onMessage: ((raw: unknown) => Promise<void>) | null = null;
  let stopped = false;
  return {
    sends,
    stopped: () => stopped,
    fire: async (raw) => {
      if (!onMessage) throw new Error('transport not started');
      await onMessage(raw);
    },
    transport: {
      start: async (handler) => {
        onMessage = handler;
      },
      stop: async () => {
        stopped = true;
      },
      send: async (chatId, message) => {
        sends.push({ chatId, message });
      }
    }
  };
}

function makeCtx(dispatched: InboundMessage[]): AdapterCtx {
  return {
    config: {
      repoRoot: '/tmp/none',
      pidFile: '/tmp/none/server.pid',
      log: { path: '/tmp/none/server.log', rotateAtBytes: 1024 },
      heartbeatMs: 30_000,
      adapters: {}
    },
    logger: { info: () => {}, ok: () => {}, err: () => {}, close: () => {} },
    dispatch: async (message) => {
      dispatched.push(message);
    },
    signal: new AbortController().signal
  };
}

test('an inbound /ping dispatches a normalized message and reply routes a card to send', async () => {
  const fake = fakeTransport();
  const dispatched: InboundMessage[] = [];
  const adapter = createFeishuAdapter({ appId: 'x' }, fake.transport);

  await adapter.start(makeCtx(dispatched));
  await fake.fire(receiveEvent('@_user_1 /ping'));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.text, '/ping');
  assert.equal(dispatched[0]?.adapter, 'feishu');

  await dispatched[0]?.reply('pong v9.9.9');
  assert.equal(fake.sends[0]?.chatId, 'oc_chat');
  assert.equal(fake.sends[0]?.message.msg_type, 'interactive');
  const content = JSON.parse(fake.sends[0]?.message.content ?? '{}');
  assert.equal(content.header.title.content, 'agent-infra');
  assert.equal(content.elements[0].text.content, 'pong v9.9.9');
});

test('a non-ping inbound reply also routes a card to send', async () => {
  const fake = fakeTransport();
  const dispatched: InboundMessage[] = [];
  const adapter = createFeishuAdapter({ appId: 'x' }, fake.transport);

  await adapter.start(makeCtx(dispatched));
  await fake.fire(receiveEvent('/version'));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.text, '/version');

  await dispatched[0]?.reply('agent-infra v9.9.9');
  assert.equal(JSON.parse(fake.sends[0]?.message.content ?? '{}').elements[0].text.content, 'agent-infra v9.9.9');
});

test('inbound messages expose structured replyDisplay for feishu rendering', async () => {
  const fake = fakeTransport();
  const dispatched: InboundMessage[] = [];
  const adapter = createFeishuAdapter({ appId: 'x' }, fake.transport);

  await adapter.start(makeCtx(dispatched));
  await fake.fire(receiveEvent('/version'));
  await dispatched[0]?.replyDisplay?.({ kind: 'status-card', title: 'Status', tone: 'success', fields: [['state', 'ok']] });

  const content = JSON.parse(fake.sends[0]?.message.content ?? '{}');
  assert.equal(content.header.title.content, 'Status');
  assert.equal(content.header.template, 'green');
  assert.equal(content.elements[0].fields[0].text.content, '**state**\nok');
});

test('a malformed inbound message is dropped (logged) without dispatching', async () => {
  const fake = fakeTransport();
  const dispatched: InboundMessage[] = [];
  const errors: string[] = [];
  const ctx = makeCtx(dispatched);
  ctx.logger.err = (message: string) => errors.push(message);
  const adapter = createFeishuAdapter({ appId: 'x' }, fake.transport);

  await adapter.start(ctx);
  await fake.fire({ message: { chat_id: 'oc' } });

  assert.deepEqual(dispatched, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /feishu: dropped message/);
});

test('sendMessage and stop delegate to the transport', async () => {
  const fake = fakeTransport();
  const adapter = createFeishuAdapter({ appId: 'x' }, fake.transport);

  await adapter.start(makeCtx([]));
  await adapter.sendMessage({ chatId: 'oc_target' }, 'hello');
  await adapter.sendDisplayMessage?.({ chatId: 'oc_target' }, { kind: 'markdown', markdown: '**hello**' });
  assert.equal(fake.sends[0]?.chatId, 'oc_target');
  assert.equal(JSON.parse(fake.sends[0]?.message.content ?? '{}').elements[0].text.content, 'hello');
  assert.equal(JSON.parse(fake.sends[1]?.message.content ?? '{}').elements[0].text.content, '**hello**');

  await adapter.stop();
  assert.equal(fake.stopped(), true);
});

test('feishu renderer strips ANSI and maps payloads to create data', () => {
  assert.equal(cleanFeishuText('\u001b[31mred\u001b[0m\nnext'), 'red\nnext');

  const rendered = renderFeishuMessage({
    kind: 'table',
    title: 'Tasks',
    columns: ['name', 'state'],
    rows: [['task', 'active']]
  });
  const cardData = toFeishuCreateData('oc_chat', rendered);
  assert.equal(cardData.receive_id, 'oc_chat');
  assert.equal(cardData.msg_type, 'interactive');
  assert.equal(cardData.content, rendered.content);
  const content = JSON.parse(rendered.content);
  assert.equal(content.header.title.content, 'Tasks');
  assert.match(content.elements[0].text.content, /name \\| state/);
});

test('feishu renderer maps stream events and command results to interactive cards', () => {
  const stream = JSON.parse(renderFeishuMessage({
    kind: 'stream-event',
    title: 'ai task ls',
    phase: 'finished',
    exitCode: 0,
    signal: null
  }).content);
  assert.equal(stream.header.template, 'green');
  assert.match(stream.elements[0].text.content, /exitCode=0/);

  const result = JSON.parse(renderFeishuMessage({
    kind: 'command-result',
    title: 'ai task ls',
    exitCode: 1,
    signal: null,
    stdout: 'out',
    stderr: 'err'
  }).content);
  assert.equal(result.header.template, 'red');
  assert.match(result.elements[0].text.content, /err/);
});

test('feishu renderer returns an interactive fallback for unknown display kinds', () => {
  const unknown = { kind: 'future-kind' } as unknown as OutboundMessage;
  const rendered = renderFeishuMessage(unknown);
  const content = JSON.parse(rendered.content);
  assert.equal(rendered.msg_type, 'interactive');
  assert.equal(content.header.title.content, 'agent-infra');
  assert.match(content.elements[0].text.content, /unknown display kind/);
});

// CD-1: an enabled-but-misconfigured feishu adapter must fail loudly rather than
// be counted as loaded while the long connection silently never opens.
test('createFeishuTransport throws when appSecret is missing', () => {
  assert.throws(
    () => createFeishuTransport({ appId: 'cli_0123456789abcdef' }),
    /appId and appSecret are required/
  );
});

test('createFeishuTransport throws when appId is missing', () => {
  assert.throws(() => createFeishuTransport({ appSecret: 's' }), /appId and appSecret are required/);
});

test('the default factory throws on missing credentials (so loadAdapters skips it)', () => {
  assert.throws(() => feishuFactory({ enabled: true }), /appId and appSecret are required/);
});

// CD-2: a non-empty but malformed appId is silently rejected by the SDK, so the
// adapter would otherwise load while the long connection never opens.
test('createFeishuTransport throws on a malformed appId', () => {
  assert.throws(
    () => createFeishuTransport({ appId: 'not-a-cli-id', appSecret: 's' }),
    /appId must match cli_\[0-9a-fA-F\]\{16\}/
  );
});

test('the default factory throws on a malformed appId (so loadAdapters skips it)', () => {
  assert.throws(
    () => feishuFactory({ enabled: true, appId: 'not-a-cli-id', appSecret: 's' }),
    /appId must match/
  );
});
