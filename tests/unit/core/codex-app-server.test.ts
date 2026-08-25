import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  hasCodexRuntimeLiveness,
  parseCodexHooksList,
  parseCodexThreadResolution,
  parseCodexTurnCompleted,
  resolveCodexSpawnedChild,
  resolveCodexTerminal,
  resolveCodexThread,
  validateCodexLifecycleHookConfig
} from '../../../lib/agent-clients/adapters/codex-lifecycle/app-server.ts';

const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return root;
}

test('App Server thread resolution combines read-only identity with rollout settings', () => {
  assert.deepEqual(parseCodexThreadResolution({
    thread: {
      id: 'child', parentThreadId: 'parent', forkedFromId: null,
      source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }
    }
  }, [
    { type: 'session_meta', payload: {
      id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } },
    { type: 'turn_context', payload: { model: 'actual-model', effort: 'high' } }
  ]), {
    thread: {
      type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent',
      forkedFromId: null, sourceParentThreadId: 'parent',
      nativeAgent: 'agent-infra-lifecycle-executor'
    },
    settings: {
      type: 'app-settings', childThreadId: 'child', model: 'actual-model', reasoningEffort: 'high'
    }
  });
});

test('App Server parsers fail closed for malformed identity, settings, and terminal payloads', () => {
  assert.throws(() => parseCodexThreadResolution({ thread: { id: 'child' } }, []), /invalid/);
  assert.throws(() => parseCodexThreadResolution({
    thread: { id: 'child', parentThreadId: 'parent', forkedFromId: null, source: 'cli' }
  }, [
    { type: 'session_meta', payload: {
      id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } },
    { type: 'turn_context', payload: { model: 'model', effort: null } }
  ]), /invalid/);
  assert.throws(() => parseCodexThreadResolution({
    thread: {
      id: 'child', parentThreadId: 'parent', forkedFromId: null,
      source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } }
    }
  }, [
    { type: 'session_meta', payload: {
      id: 'wrong-child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } },
    { type: 'turn_context', payload: { model: 'model', effort: 'high' } }
  ]), /invalid/);
  assert.throws(() => parseCodexTurnCompleted({ threadId: 'child', turn: { id: 'turn', status: 'mystery' } }), /invalid/);
});

test('App Server hook discovery requires every enabled lifecycle hook', () => {
  const command = (phase: string) =>
    `node "$(git rev-parse --show-toplevel)/.agents/hooks/lifecycle-delegation.js" --client codex --event ${phase}`;
  const hooks = ([
    ['preToolUse', '^collaborationspawn_agent$', 'pre-tool'],
    ['postToolUse', '', 'post-tool'],
    ['subagentStart', '', 'subagent-start'],
    ['subagentStop', '', 'subagent-stop']
  ] as const).map(([eventName, matcher, phase]) => ({
    eventName,
    matcher,
    command: command(phase),
    enabled: true,
    source: 'project',
    sourcePath: '/workspace/.codex/hooks.json',
    trustStatus: 'trusted',
    currentHash: `hash-${phase}`,
    isManaged: false,
    pluginId: null
  }));
  assert.equal(parseCodexHooksList({ data: [{ cwd: '/workspace', hooks, warnings: [], errors: [] }] }, '/workspace').length, 4);
  assert.throws(
    () => parseCodexHooksList({ data: [{ cwd: '/workspace', hooks: hooks.slice(1), warnings: [], errors: [] }] }, '/workspace'),
    /not loaded/
  );
});

test('parent rollout resolves exactly one trusted lifecycle child for a spawn tool call', () => {
  const root = temporaryRoot('codex-parent-rollout-');
  const rollout = path.join(root, 'rollout-parent.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'tool',
      arguments: JSON.stringify({
        agent_type: 'agent-infra-lifecycle-executor', task_name: 'analysis_executor_r1',
        model: 'executor-model', reasoning_effort: 'xhigh'
      })
    } }),
    JSON.stringify({ type: 'event_msg', payload: {
      type: 'item_completed', thread_id: 'parent', turn_id: 'turn',
      item: {
        type: 'SubAgentActivity', id: 'tool', kind: 'started',
        agent_thread_id: 'child', agent_path: '/root/analysis_executor_r1'
      }
    } })
  ].join('\n'));
  assert.equal(resolveCodexSpawnedChild(rollout, {
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool', nativeAgent: 'agent-infra-lifecycle-executor',
    taskName: 'analysis_executor_r1', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }), 'child');
  assert.throws(() => resolveCodexSpawnedChild(rollout, {
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool', nativeAgent: 'agent-infra-lifecycle-reviewer',
    taskName: 'analysis_executor_r1'
  }), /does not match/);
});

test('parent rollout child correlation fails closed for missing, duplicate, or mismatched activities', () => {
  const root = temporaryRoot('codex-parent-rollout-');
  const rollout = path.join(root, 'rollout-parent.jsonl');
  const call = { type: 'response_item', payload: {
    type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'tool',
    arguments: JSON.stringify({
      agent_type: 'agent-infra-lifecycle-executor', task_name: 'analysis_executor_r1'
    })
  } };
  const activity = { type: 'event_msg', payload: {
    type: 'item_completed', thread_id: 'parent', turn_id: 'turn',
    item: {
      type: 'SubAgentActivity', id: 'tool', kind: 'started',
      agent_thread_id: 'child', agent_path: '/root/analysis_executor_r1'
    }
  } };
  const expected = {
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', taskName: 'analysis_executor_r1'
  };
  const invalidActivities = [
    [],
    [activity, activity],
    [{ ...activity, payload: { ...activity.payload, item: { ...activity.payload.item, id: 'other-tool' } } }],
    [{ ...activity, payload: { ...activity.payload, thread_id: 'other-parent' } }],
    [{ ...activity, payload: { ...activity.payload, turn_id: 'other-turn' } }],
    [{ ...activity, payload: { ...activity.payload, item: null } }]
  ];
  for (const activities of invalidActivities) {
    fs.writeFileSync(rollout, [call, ...activities].map((record) => JSON.stringify(record)).join('\n'));
    assert.throws(
      () => resolveCodexSpawnedChild(rollout, expected),
      { message: 'Codex parent rollout child activity was not found uniquely' }
    );
  }
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
  const root = temporaryRoot('codex-app-server-');
  const server = path.join(root, 'server.mjs');
  const rollout = path.join(root, 'rollout-child.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: {
      id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'model', effort: 'high' } })
  ].join('\n'));
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      let result = {};
      if (message.method === 'thread/read') result = { thread: {
        id: 'child', parentThreadId: 'parent', forkedFromId: null,
        path: ${JSON.stringify(rollout)},
        source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
        turns: message.params.includeTurns ? [{ id: 'turn', status: 'completed', items: [] }] : []
      } };
      if (message.method === 'thread/resume') {
        process.stdout.write(JSON.stringify({ id: message.id, error: {
          code: -32600, message: 'thread already has an active writer'
        } }) + '\\n');
        return;
      }
      if (message.method === 'thread/unsubscribe') result = { status: 'unsubscribed' };
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

test('App Server resolver waits for delayed rollout settings', async () => {
  const root = temporaryRoot('codex-app-server-');
  const server = path.join(root, 'server.mjs');
  const rollout = path.join(root, 'rollout-child.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: {
    id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
  } }));
  fs.writeFileSync(server, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    let scheduled = false;
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      let result = {};
      if (message.method === 'thread/read') {
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => fs.appendFileSync(${JSON.stringify(rollout)},
            '\\n' + JSON.stringify({ type: 'turn_context', payload: { model: 'model', effort: 'high' } })), 700);
        }
        result = { thread: {
          id: 'child', parentThreadId: 'parent', forkedFromId: null,
          path: ${JSON.stringify(rollout)},
          source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
          turns: []
        } };
      }
      if (message.method === 'thread/unsubscribe') result = { status: 'unsubscribed' };
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  const resolved = await resolveCodexThread('child', {
    command: process.execPath, args: [server], timeoutMs: 2_000
  });
  assert.deepEqual(resolved.resolution.settings, {
    type: 'app-settings', childThreadId: 'child', model: 'model', reasoningEffort: 'high'
  });
});

test('App Server thread resolver default budget waits for fresh metadata and rejects a stable fork', async () => {
  const root = temporaryRoot('codex-app-server-');
  const server = path.join(root, 'server.mjs');
  const rollout = path.join(root, 'rollout-child.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: {
      id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'model', effort: 'high' } })
  ].join('\n'));
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    let reads = 0;
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      let result = {};
      if (message.method === 'thread/read') {
        reads += 1;
        result = { thread: {
          id: 'child', parentThreadId: 'parent',
          forkedFromId: process.env.STABLE_FORK === 'true' || reads <= Number(process.env.FRESH_AFTER ?? 1)
            ? 'transient-source'
            : null,
          path: ${JSON.stringify(rollout)},
          source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
          turns: []
        } };
      }
      if (message.method === 'thread/unsubscribe') result = { status: 'unsubscribed' };
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  const options = {
    command: process.execPath, args: [server], timeoutMs: 2_000,
    threadRetryMs: 1,
    env: { ...process.env, FRESH_AFTER: '5' }
  };
  const resolved = await resolveCodexThread('child', options);
  assert.equal(resolved.resolution.thread.forkedFromId, null);
  await assert.rejects(
    resolveCodexThread('child', {
      ...options,
      env: { ...process.env, STABLE_FORK: 'true' }
    }),
    /fresh thread metadata is unavailable/
  );
});

test('App Server terminal resolver rejects a response for the wrong child thread', async () => {
  const root = temporaryRoot('codex-app-server-');
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

test('App Server terminal resolver distinguishes active turns from malformed terminal evidence', async () => {
  const root = temporaryRoot('codex-app-server-');
  const server = path.join(root, 'server.mjs');
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      const status = process.env.TURN_STATUS;
      const turns = status === 'none' ? [] : [{ id: status === 'missing-id' ? '' : 'turn', status }];
      const result = message.method === 'thread/read' ? { thread: { id: 'child', turns } } : {};
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  const options = (status: string) => ({
    command: process.execPath, args: [server], timeoutMs: 2_000,
    env: { ...process.env, TURN_STATUS: status }
  });
  await assert.rejects(resolveCodexTerminal('child', options('none')), /CODEX_TURN_NOT_TERMINAL/);
  await assert.rejects(resolveCodexTerminal('child', options('inProgress')), /CODEX_TURN_NOT_TERMINAL/);
  await assert.rejects(resolveCodexTerminal('child', options('missing-id')), /completion is invalid/);
  await assert.rejects(resolveCodexTerminal('child', options('mystery')), /completion is invalid/);
});

test('App Server terminal resolver binds the hook turn and waits through a transient failure', async () => {
  const root = temporaryRoot('codex-app-server-');
  const server = path.join(root, 'server.mjs');
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    let reads = 0;
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      let result = {};
      if (message.method === 'thread/read') {
        reads += 1;
        const targetStatus = process.env.STABLE_FAILURE === 'true' || reads === 1 ? 'failed' : 'completed';
        result = { thread: { id: 'child', turns: [
          { id: 'target-turn', status: targetStatus },
          { id: 'unrelated-latest-turn', status: 'completed' }
        ] } };
      }
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  const options = {
    command: process.execPath, args: [server], timeoutMs: 2_000,
    terminalReadAttempts: 2, terminalRetryMs: 1
  };
  assert.deepEqual(await resolveCodexTerminal('child', 'target-turn', options), {
    type: 'app-terminal', childThreadId: 'child', turnId: 'target-turn', status: 'completed'
  });
  assert.deepEqual(await resolveCodexTerminal('child', 'target-turn', {
    ...options,
    env: { ...process.env, STABLE_FAILURE: 'true' }
  }), {
    type: 'app-terminal', childThreadId: 'child', turnId: 'target-turn', status: 'failed'
  });
});

test('App Server resolver fails closed when rollout settings are unavailable', async () => {
  const root = temporaryRoot('codex-app-server-');
  const server = path.join(root, 'server.mjs');
  fs.writeFileSync(server, `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (!message.id) return;
      const result = message.method === 'thread/read' ? { thread: {
        id: 'child', parentThreadId: 'parent', forkedFromId: null,
        path: ${JSON.stringify(path.join(root, 'rollout-child.jsonl'))},
        source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }, turns: []
      } } : {};
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    });
  `);
  await assert.rejects(
    resolveCodexThread('child', {
      command: process.execPath, args: [server], timeoutMs: 2_000,
      rolloutReadAttempts: 2, rolloutRetryMs: 1
    }),
    /rollout metadata is unavailable/
  );
});

test('Codex preflight validates exact lifecycle hooks and current spawn identity', () => {
  const hooks = JSON.parse(fs.readFileSync(path.resolve('.codex/hooks.json'), 'utf8'));
  assert.doesNotThrow(() => validateCodexLifecycleHookConfig(hooks));
  assert.throws(() => validateCodexLifecycleHookConfig({
    hooks: { PreToolUse: [], PostToolUse: [], SubagentStart: [], SubagentStop: [] }
  }), /hooks are invalid/);

  const root = temporaryRoot('codex-lifecycle-liveness-');
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
