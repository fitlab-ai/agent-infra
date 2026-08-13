import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  hasCodexRuntimeLiveness,
  parseCodexThreadResolution,
  parseCodexTurnCompleted,
  resolveCodexTerminal,
  resolveCodexThread,
  validateCodexLifecycleHookConfig
} from '../../../lib/agent-clients/adapters/codex-lifecycle/app-server.ts';

test('App Server thread resolution exposes only identity and resolved settings', () => {
  assert.deepEqual(parseCodexThreadResolution({
    thread: {
      id: 'child', parentThreadId: 'parent', forkedFromId: null,
      source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }
    },
    model: 'actual-model', reasoningEffort: 'high'
  }), {
    thread: {
      type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent',
      forkedFromId: null, sourceParentThreadId: 'parent'
    },
    settings: {
      type: 'app-settings', childThreadId: 'child', model: 'actual-model', reasoningEffort: 'high'
    }
  });
});

test('App Server parsers fail closed for malformed identity, settings, and terminal payloads', () => {
  assert.throws(() => parseCodexThreadResolution({ thread: { id: 'child' } }), /invalid/);
  assert.throws(() => parseCodexThreadResolution({
    thread: { id: 'child', parentThreadId: 'parent', forkedFromId: null, source: 'cli' },
    model: 'model', reasoningEffort: null
  }), /invalid/);
  assert.throws(() => parseCodexTurnCompleted({ threadId: 'child', turn: { id: 'turn', status: 'mystery' } }), /invalid/);
});

test('App Server terminal parser preserves completed and failed host states', () => {
  assert.deepEqual(parseCodexTurnCompleted({
    threadId: 'child', turn: { id: 'turn', status: 'completed', items: [] }
  }), { type: 'app-terminal', childThreadId: 'child', turnId: 'turn', status: 'completed' });
  assert.deepEqual(parseCodexTurnCompleted({
    threadId: 'child', turn: { id: 'turn', status: 'failed', items: [], error: { message: 'boom' } }
  }), { type: 'app-terminal', childThreadId: 'child', turnId: 'turn', status: 'failed' });
});

test('App Server resolver correlates request ids against a JSONL server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-'));
  const server = path.join(root, 'server.mjs');
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      let result = {};
      if (message.method === 'thread/read') result = { thread: {
        id: 'child', parentThreadId: 'parent', forkedFromId: null,
        source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
        turns: message.params.includeTurns ? [{ id: 'turn', status: 'completed', items: [] }] : []
      }, model: 'model', reasoningEffort: 'high' };
      if (message.method === 'thread/resume') process.exit(9);
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  const options = { command: process.execPath, args: [server], timeoutMs: 2_000 };
  const start = await resolveCodexThread('child', options);
  assert.equal(start.resolution.settings.model, 'model');
  assert.equal(start.resolution.thread.parentThreadId, 'parent');
  const stop = await resolveCodexTerminal('child', options);
  assert.equal(stop.status, 'completed');
});

test('App Server terminal resolver rejects a response for the wrong child thread', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-'));
  const server = path.join(root, 'server.mjs');
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      const result = message.method === 'thread/read' ? { thread: {
        id: 'wrong-child',
        turns: [{ id: 'turn', status: 'completed', items: [] }]
      } } : {};
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  await assert.rejects(
    resolveCodexTerminal('child', { command: process.execPath, args: [server], timeoutMs: 2_000 }),
    /wrong child thread/
  );
});

test('App Server resolver fails closed instead of resuming when read omits settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-'));
  const server = path.join(root, 'server.mjs');
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      if (message.method === 'thread/resume') process.exit(9);
      const result = message.method === 'thread/read' ? { thread: {
        id: 'child', parentThreadId: 'parent', forkedFromId: null,
        source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }, turns: []
      } } : {};
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  await assert.rejects(
    resolveCodexThread('child', { command: process.execPath, args: [server], timeoutMs: 2_000 }),
    /settings are unavailable without thread\/resume/
  );
});

test('Codex preflight validates exact lifecycle hooks and current spawn identity', () => {
  const hooks = JSON.parse(fs.readFileSync(path.resolve('.codex/hooks.json'), 'utf8'));
  assert.doesNotThrow(() => validateCodexLifecycleHookConfig(hooks));
  assert.throws(() => validateCodexLifecycleHookConfig({
    hooks: { PreToolUse: [], PostToolUse: [], SubagentStart: [], SubagentStop: [] }
  }), /hooks are invalid/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-liveness-'));
  fs.writeFileSync(path.join(root, `${'a'.repeat(64)}.json`), JSON.stringify({
    state: {
      status: 'observed-spawn',
      spawn: {
        sessionId: 'session', turnId: 'turn', toolUseId: 'tool', hookDefinitionHash: 'hash'
      }
    }
  }));
  assert.equal(hasCodexRuntimeLiveness(root, 'hash', {
    sessionId: 'session', turnId: 'turn', toolUseId: 'tool'
  }), true);
  assert.equal(hasCodexRuntimeLiveness(root, 'hash', {
    sessionId: 'old-session', turnId: 'turn', toolUseId: 'tool'
  }), false);
  assert.equal(hasCodexRuntimeLiveness(root, 'hash'), false);
});
