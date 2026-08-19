import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  createCodexLifecycleStore,
  hasActiveCodexLifecycleEvidence
} from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import { assertModeBits } from '../../helpers/platform.ts';

const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-store-'));
  fixtureRoots.add(root);
  return root;
}

test('Codex lifecycle store persists only normalized evidence and consumes once', () => {
  const root = temporaryRoot();
  let now = '2026-08-14T00:00:00.500Z';
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0', now: () => now });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-reviewer', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  });
  now = '2026-08-14T00:00:01.000Z';
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  store.apply({
    type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent',
    forkedFromId: null, sourceParentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-reviewer'
  });
  const record = store.apply({
    type: 'app-settings', childThreadId: 'child', model: 'model', reasoningEffort: 'high'
  });
  assert.equal(record.state.status, 'start-ready');
  assert.equal(
    (store.read('child') as ReturnType<typeof store.read> & { spawnObservedAt?: string }).spawnObservedAt,
    '2026-08-14T00:00:00.500Z'
  );
  assert.equal(hasActiveCodexLifecycleEvidence(root, {
    nativeAgent: 'agent-infra-lifecycle-reviewer',
    hookDefinitionHash: 'hash'
  }), true);

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
  assert.equal(hasActiveCodexLifecycleEvidence(root, {
    nativeAgent: 'agent-infra-lifecycle-reviewer',
    hookDefinitionHash: 'hash'
  }), false);
  assert.equal(store.findByParent('parent')[0]?.consumer, 'receipt-1');
  assert.deepEqual(store.consume('child', 'receipt-1', 'hash'), consumed);
  assert.throws(() => store.consume('child', 'receipt-2'), /already consumed/);
});

test('Codex lifecycle store rejects ambiguous parent session and agent correlation', () => {
  const root = temporaryRoot();
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
    parentThreadId: 'parent',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }), /ambiguous/);
});

test('Codex lifecycle store keeps the first spawn observation across replay and leaves legacy records fail-closed', () => {
  const root = temporaryRoot();
  let now = '2026-08-14T00:00:00.500Z';
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0', now: () => now });
  const event = {
    type: 'hook-spawn' as const, sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash'
  };
  const first = store.apply(event);

  now = '2026-08-14T00:00:01.000Z';
  store.apply(event);
  assert.equal(JSON.parse(fs.readFileSync(first.path, 'utf8')).spawnObservedAt, '2026-08-14T00:00:00.500Z');

  const legacy = JSON.parse(fs.readFileSync(first.path, 'utf8'));
  delete legacy.spawnObservedAt;
  fs.writeFileSync(first.path, `${JSON.stringify(legacy, null, 2)}\n`);
  now = '2026-08-14T00:00:02.000Z';
  store.apply(event);
  assert.equal(JSON.parse(fs.readFileSync(first.path, 'utf8')).spawnObservedAt, null);
});

test('Codex lifecycle store correlates a real child session through its host-resolved parent', () => {
  const root = temporaryRoot();
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0' });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  });

  const result = store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
  });

  assert.equal(result.state.status, 'observed-child');
  assert.equal(result.state.child?.sessionId, 'parent');
});

test('Codex lifecycle store recovers a stale writer lock', () => {
  const root = temporaryRoot();
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
  const root = temporaryRoot();
  let now = '2026-08-13T00:00:00.000Z';
  const store = createCodexLifecycleStore({ root, cliVersion: '0.147.0', now: () => now });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash: 'hash'
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
    parentThreadId: 'parent',
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
