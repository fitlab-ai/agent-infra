import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTER_CONTRACT_VERSION, type Adapter, type InboundMessage } from '../../../lib/server/adapters/_contract.ts';

// Structural tripwire: bumping the contract version is a deliberate, breaking
// change for subtasks B/C, so it must be an intentional test update too.
test('adapter contract exposes a stable integer version constant', () => {
  assert.equal(typeof ADAPTER_CONTRACT_VERSION, 'number');
  assert.equal(Number.isInteger(ADAPTER_CONTRACT_VERSION), true);
  assert.equal(ADAPTER_CONTRACT_VERSION, 1);
});

test('display methods are optional and do not require a contract version bump', () => {
  const inbound: InboundMessage = {
    adapter: 'test',
    userId: 'u1',
    chatId: 'c1',
    text: '/ping',
    messageId: 'm1',
    raw: {},
    reply: async () => {}
  };
  const adapter: Adapter = {
    name: 'test',
    start: async () => {},
    stop: async () => {},
    sendMessage: async () => {}
  };

  assert.equal(inbound.replyDisplay, undefined);
  assert.equal(adapter.sendDisplayMessage, undefined);
  assert.equal(ADAPTER_CONTRACT_VERSION, 1);
});
