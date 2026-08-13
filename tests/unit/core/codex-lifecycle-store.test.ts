import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import { assertModeBits } from '../../helpers/platform.ts';

test('Codex lifecycle store persists only normalized evidence and consumes once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-store-'));
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0' });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-reviewer', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  store.apply({
    type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent',
    forkedFromId: null, sourceParentThreadId: 'parent'
  });
  const record = store.apply({
    type: 'app-settings', childThreadId: 'child', model: 'model', reasoningEffort: 'high'
  });
  assert.equal(record.state.status, 'start-ready');

  const raw = fs.readFileSync(record.path, 'utf8');
  assert.equal(raw.includes('prompt'), false);
  assert.equal(raw.includes('transcript'), false);
  assertModeBits(record.path, 0o600);

  store.apply({
    type: 'app-terminal', childThreadId: 'child', turnId: 'child-turn', status: 'completed'
  });
  store.apply({
    type: 'hook-stop', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  assert.throws(() => store.consume('child', 'receipt-1', 'stale-hash'), /hash is stale/);
  const consumed = store.consume('child', 'receipt-1', 'hash');
  assert.equal(consumed.consumer, 'receipt-1');
  assert.throws(() => store.consume('child', 'receipt-2'), /already consumed/);
});

test('Codex lifecycle store rejects ambiguous parent session and agent correlation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-store-'));
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0' });
  for (const toolUseId of ['tool-a', 'tool-b']) {
    store.apply({
      type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId,
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
    });
  }
  assert.throws(() => store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }), /ambiguous/);
});

test('Codex lifecycle store recovers a stale writer lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-store-'));
  const lock = path.join(root, '.write.lock');
  fs.writeFileSync(lock, 'stale');
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, stale, stale);

  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0' });
  const result = store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  });

  assert.equal(result.revision, 1);
  assert.equal(fs.existsSync(lock), false);
});

test('Codex lifecycle store marks stale active evidence expired before cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-store-'));
  let now = '2026-08-13T00:00:00.000Z';
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0', now: () => now });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash'
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  });

  now = '2026-08-13T01:00:00.000Z';
  assert.equal(store.expireBefore('2026-08-13T00:30:00.000Z'), 1);
  assert.equal(store.read('child').state.status, 'expired');
  assert.throws(() => store.consume('child', 'receipt'), /not stop-ready/);

  now = '2026-08-13T02:00:00.000Z';
  assert.equal(store.expireBefore('2026-08-13T01:30:00.000Z'), 1);
  assert.throws(() => store.read('child'), /not found uniquely/);
});
