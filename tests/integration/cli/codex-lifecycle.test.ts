import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import {
  envWithPrependedPath,
  INTERNAL_CLI_PATH,
  sandboxControlSafeEnv,
  writeNodeCommandShim
} from '../../helpers.ts';
import { createCodexCapabilityStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/capability-store.ts';
import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  activateCodexOrchestrationDelegation,
  prepareCodexOrchestrationDelegation
} from '../../../lib/task/codex-orchestration.ts';
import {
  beginOrResumeOrchestration,
  completeOrchestrationStage,
  dispatchOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';
const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-cli-'));
  fixtureRoots.add(root);
  const bin = path.join(root, 'bin');
  const codex = path.join(root, 'codex.mjs');
  const rollout = path.join(root, 'rollout-child.jsonl');
  fs.mkdirSync(path.join(root, '.agents', 'workspace'), { recursive: true });
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: {
      id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'model', effort: 'high' } })
  ].join('\n'));
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
            path: ${JSON.stringify(rollout)},
            source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } },
            turns: message.params.includeTurns ? [{ id: 'child-turn', status: process.env.TURN_STATUS || 'completed' }] : []
          }
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
  for (const file of [
    '.codex/agents/agent-infra-lifecycle-executor.toml',
    '.codex/agents/agent-infra-lifecycle-reviewer.toml',
    '.agents/hooks/lifecycle-delegation.js',
    '.agents/skills/run-task/SKILL.md',
    '.agents/rules/lifecycle-orchestration.md'
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'managed lifecycle contract\n');
  }
  return {
    root,
    env: envWithPrependedPath(sandboxControlSafeEnv({
      ...process.env,
      AGENT_INFRA_RUNTIME_DIR: undefined,
      AGENT_INFRA_TASK_ID: undefined,
      AGENT_INFRA_EXECUTOR_MANIFEST: undefined,
      AGENT_INFRA_CODEX_CONTROLLER_CONTEXT: undefined
    }), bin),
    hookDefinitionHash: crypto.createHash('sha256').update(hooks).digest('hex')
  };
}

function run(root: string, env: NodeJS.ProcessEnv, args: string[], input = '') {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'codex-lifecycle', ...args], {
    cwd: root, env, input, encoding: 'utf8'
  });
}

test('compiled codex-lifecycle CLI rechecks its generated executable identity', () => {
  const { root, env } = fixture();
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\ncurrent_step: requirement-analysis\nagent_infra_version: v0.9.12-alpha.0\n---\n\n# Task\n`);

  const result = run(root, env, ['capability-arm', '--task-id', taskId]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'armed');
  assert.equal(payload.error, null);
  assert.equal(payload.buildIdentity.protocolVersion, 3);
  assert.match(payload.buildIdentity.internalExecutableBuildHash, /^[0-9a-f]{64}$/u);
});

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
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const childState = JSON.parse(child.stdout);
  assert.equal(childState.status, 'observed-child');
  assert.equal(childState.evidence.child.sessionId, 'parent');
  assert.equal(childState.evidence.child.parentThreadId, 'parent');
});

test('codex-lifecycle bridge ignores managed hooks without a running delegation', () => {
  const { root, env, hookDefinitionHash } = fixture();
  const spawn = run(root, env, ['hook-event', '--event', 'pre-tool', '--bridge', 'true'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash
  }));
  assert.equal(spawn.status, 0, `${spawn.stderr}\n${spawn.stdout}`);
  assert.equal(JSON.parse(spawn.stdout).status, 'observed-spawn');

  const events = [
    ['subagent-start', {
      sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }],
    ['post-tool', {
      sessionId: 'parent', turnId: 'turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }],
    ['subagent-stop', {
      sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }]
  ] as const;

  for (const [event, payload] of events) {
    const result = run(root, env, ['hook-event', '--event', event, '--bridge', 'true'], JSON.stringify(payload));
    assert.equal(result.status, 0, `${event}: ${result.stderr}\n${result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'ignored', changed: false, evidence: null, diagnostics: [], error: null
    });
  }
});

test('Codex SubagentStop bridge records stop before parent reconciliation seals terminal evidence', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\ncurrent_step: requirement-analysis\nagent_infra_version: v0.9.11-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  beginOrResumeOrchestration(taskId, {
    repoRoot: root,
    client: 'codex',
    modelPolicy: {
      executor: { model: 'model', reasoningEffort: 'high' },
      reviewer: { model: 'review-model', reasoningEffort: 'high' }
    },
    id: () => 'run-1'
  });
  const buildIdentity = {
    protocolVersion: 3,
    packageVersion: '0.9.9-alpha.0',
    internalExecutableBuildHash: 'a'.repeat(64),
    lifecycleContractHash: 'b'.repeat(64)
  } as const;
  const capabilityStore = createCodexCapabilityStore({
    root: path.join(root, '.agents', 'workspace', '.runtime', 'codex-capabilities'),
    token: () => 'capability-token'
  });
  const armed = capabilityStore.arm({ taskId, buildIdentity });
  capabilityStore.attest({
    token: armed.token,
    sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'capability-tool',
    hookDefinitionHash, buildIdentity
  });
  const preflight = async () => ({
    cliVersion: '0.147.0', hookDefinitionHash, staticReady: true as const,
    discoveredHooks: [], runtimeLiveness: false, diagnostics: [],
    hookProvenance: {
      hookSource: 'project' as const,
      hookSourcePathDigest: 'c'.repeat(64), hookSourceHash: 'd'.repeat(64)
    }
  });
  await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'model', requestedReasoningEffort: 'high',
    capabilityToken: armed.token
  }, {
    repoRoot: root,
    buildIdentity,
    capabilityStore,
    preflight,
    orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'receipt-1' }
  });
  dispatchOrchestrationDelegation(taskId, { repoRoot: root });
  const store = createCodexLifecycleStore({
    root: path.join(root, '.agents', 'workspace', '.runtime', 'codex-lifecycle'),
    cliVersion: '0.147.0'
  });
  for (const event of [
    {
      type: 'hook-spawn' as const, sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash
    },
    {
      type: 'hook-child' as const, sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook' as const
    },
    {
      type: 'app-thread' as const, childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null,
      sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
    },
    { type: 'app-settings' as const, childThreadId: 'child', model: 'model', reasoningEffort: 'high' }
  ]) store.apply(event);
  const activated = await activateCodexOrchestrationDelegation('child', {
    repoRoot: root,
    store,
    buildIdentity,
    preflight,
    resolveThread: async () => ({
      resolution: {
        thread: {
          type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null,
          sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
        },
        settings: { type: 'app-settings', childThreadId: 'child', model: 'model', reasoningEffort: 'high' }
      },
      reroutes: [], diagnostics: []
    })
  });
  assert.equal(activated.run?.pendingDelegation?.status, 'activated');
  completeOrchestrationStage(taskId, {
    stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
  }, { repoRoot: root });

  const stopped = run(root, { ...env, TURN_STATUS: 'failed' }, [
    'hook-event', '--event', 'subagent-stop', '--bridge', 'true'
  ], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  const payload = JSON.parse(stopped.stdout);
  assert.equal(payload.status, 'start-ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir, 'orchestration.json'), 'utf8')).pendingDelegation.status, 'stage-completed');
  assert.equal(store.read('child').state.terminal, null);
  assert.equal(store.read('child').state.stop?.turnId, 'child-turn');
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
      sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }]
  ] as const) {
    const result = run(root, env, ['hook-event', '--event', event], JSON.stringify(payload));
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  }
  const start = run(root, env, ['resolve-start', '--child-id', 'child']);
  assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);

  const premature = run(root, env, ['resolve-stop', '--child-id', 'child']);
  assert.equal(premature.status, 1);
  assert.equal(JSON.parse(premature.stdout).status, 'failed');

  const stopHook = run(root, env, ['hook-event', '--event', 'subagent-stop'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.equal(stopHook.status, 0, stopHook.stderr);
  const ready = run(root, env, ['resolve-stop', '--child-id', 'child']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'stop-ready');
});
