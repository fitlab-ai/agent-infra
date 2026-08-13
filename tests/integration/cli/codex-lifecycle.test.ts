import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  envWithPrependedPath,
  INTERNAL_CLI_PATH,
  writeNodeCommandShim
} from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-cli-'));
  const bin = path.join(root, 'bin');
  const codex = path.join(root, 'codex.mjs');
  fs.mkdirSync(path.join(root, '.agents', 'workspace'), { recursive: true });
  fs.writeFileSync(codex, `
    import readline from 'node:readline';
    if (process.argv[2] === '--version') {
      process.stdout.write('codex-cli 0.147.0\\n');
    } else if (process.argv[2] === 'app-server') {
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (!message.id) return;
        const result = message.method === 'thread/read' ? {
          thread: {
            id: 'child', parentThreadId: 'parent', forkedFromId: null,
            source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } },
            turns: message.params.includeTurns ? [{ id: 'child-turn', status: 'completed' }] : []
          }
        } : message.method === 'thread/resume' ? {
          thread: { id: 'child' }, model: 'model', reasoningEffort: 'high'
        } : message.method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : {};
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
      });
    } else {
      process.exit(2);
    }
  `);
  writeNodeCommandShim(path.join(bin, 'codex'), codex);
  const hooks = '{"hooks":{}}\n';
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), hooks);
  return {
    root,
    env: envWithPrependedPath(process.env, bin),
    hookDefinitionHash: crypto.createHash('sha256').update(hooks).digest('hex')
  };
}

function run(root: string, env: NodeJS.ProcessEnv, args: string[], input = '') {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'codex-lifecycle', ...args], {
    cwd: root, env, input, encoding: 'utf8'
  });
}

test('codex-lifecycle CLI records normalized hook identity across invocations', () => {
  const { root, env } = fixture();
  const spawn = run(root, env, ['hook-event', '--event', 'pre-tool'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash'
  }));
  assert.equal(spawn.status, 0, spawn.stderr);
  assert.equal(JSON.parse(spawn.stdout).status, 'observed-spawn');

  const child = run(root, env, ['hook-event', '--event', 'subagent-start'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'observed-child');
});

test('codex-lifecycle CLI rejects unknown and duplicate options', () => {
  const { root, env } = fixture();
  for (const args of [
    ['unknown'],
    ['hook-event', '--event', 'pre-tool', '--event', 'pre-tool'],
    ['consume', '--child-id', 'child']
  ]) {
    const result = run(root, env, args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
  }
});

test('codex-lifecycle resolve-stop fails until the stop hook makes evidence ready', () => {
  const { root, env, hookDefinitionHash } = fixture();
  for (const [event, payload] of [
    ['pre-tool', {
      sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash
    }],
    ['subagent-start', {
      sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }]
  ] as const) {
    const result = run(root, env, ['hook-event', '--event', event], JSON.stringify(payload));
    assert.equal(result.status, 0, result.stderr);
  }
  const start = run(root, env, ['resolve-start', '--child-id', 'child']);
  assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);

  const premature = run(root, env, ['resolve-stop', '--child-id', 'child']);
  assert.equal(premature.status, 1);
  assert.equal(JSON.parse(premature.stdout).status, 'failed');

  const stopHook = run(root, env, ['hook-event', '--event', 'subagent-stop'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.equal(stopHook.status, 0, stopHook.stderr);
  const ready = run(root, env, ['resolve-stop', '--child-id', 'child']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'stop-ready');
});
