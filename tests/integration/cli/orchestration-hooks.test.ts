import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { envWithPrependedPath, writeNodeCommandShim } from '../../helpers.ts';

const HOOK = path.resolve('.agents/hooks/lifecycle-delegation.js');
const FIXTURES = path.resolve('tests/fixtures/lifecycle-hooks');

interface RunOptions {
  client?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  event?: string;
  hook?: string;
}

type LocalCliState = 'missing' | 'working' | 'broken' | 'source-with-stale-dist';

function run(input: string, options: RunOptions = {}) {
  const {
    client = 'claude-code',
    cwd = path.resolve('.'),
    env = process.env,
    event,
    hook = HOOK
  } = options;
  const args = [hook, '--client', client, ...(event ? ['--event', event] : [])];
  return spawnSync('node', args, { cwd, input, encoding: 'utf8', env });
}

function createHookFixture(localCliState: LocalCliState) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-hook-'));
  const repoDir = path.join(root, 'repo');
  const hook = path.join(repoDir, '.agents', 'hooks', 'lifecycle-delegation.js');
  const cwd = path.join(repoDir, 'nested');
  const binDir = path.join(root, 'bin');
  const pathCli = path.join(root, 'path-internal-cli.mjs');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.copyFileSync(HOOK, hook);
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({
      type: 'module',
      ...(localCliState === 'source-with-stale-dist' ? { name: '@fitlab-ai/agent-infra' } : {})
    })
  );
  fs.writeFileSync(pathCli, "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ source: 'path', args: process.argv.slice(2), ...(input ? { input: JSON.parse(input) } : {}) })))\n");
  writeNodeCommandShim(path.join(binDir, 'agent-infra-internal'), pathCli);

  if (localCliState !== 'missing') {
    const localCli = path.join(repoDir, 'dist', 'bin', 'internal-cli.js');
    fs.mkdirSync(path.dirname(localCli), { recursive: true });
    const localCliSource = localCliState === 'broken' || localCliState === 'source-with-stale-dist'
      ? "process.stderr.write('Local lifecycle CLI failed\\n'); process.exit(23)\n"
      : "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ source: 'local', args: process.argv.slice(2), ...(input ? { input: JSON.parse(input) } : {}) })))\n";
    fs.writeFileSync(localCli, localCliSource);
  }

  if (localCliState === 'source-with-stale-dist') {
    const sourceCli = path.join(repoDir, 'bin', 'internal-cli.ts');
    fs.mkdirSync(path.dirname(sourceCli), { recursive: true });
    fs.writeFileSync(sourceCli, "process.stdout.write(JSON.stringify({ source: 'source', args: process.argv.slice(2) }))\n");
  }

  fs.mkdirSync(path.join(repoDir, '.codex'), { recursive: true });
  fs.copyFileSync(path.resolve('.codex/hooks.json'), path.join(repoDir, '.codex', 'hooks.json'));

  return { cwd, env: envWithPrependedPath(process.env, binDir), hook };
}

test('lifecycle hook ignores unrelated subagents without touching orchestration state', () => {
  const result = run(JSON.stringify({
    hook_event_name: 'SubagentStart',
    agent_name: 'general-purpose',
    task_id: 'TASK-20260101-000001'
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('lifecycle hook falls back to PATH and maps native Claude payloads', () => {
  const fixture = createHookFixture('missing');

  const result = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-start.json'), 'utf8'),
    fixture
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    source: 'path',
    args: [
      'task-orchestration', 'auto', 'hook-start',
      '--client', 'claude-code',
      '--native-agent', 'agent-infra-lifecycle-reviewer',
      '--child-id', 'claude-child',
      '--parent-id', 'claude-parent',
      '--spawn-mode', 'fresh'
    ]
  });

  const stop = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-stop.json'), 'utf8'),
    fixture
  );
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), {
    source: 'path',
    args: [
      'task-orchestration', 'auto', 'hook-stop',
      '--client', 'claude-code',
      '--native-agent', 'agent-infra-lifecycle-reviewer',
      '--child-id', 'claude-child'
    ]
  });
});

test('lifecycle hook prefers the repository-local CLI independently of cwd', () => {
  const fixture = createHookFixture('working');

  const start = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-start.json'), 'utf8'),
    fixture
  );
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).source, 'local');

  const stop = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-stop.json'), 'utf8'),
    fixture
  );
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), {
    source: 'local',
    args: [
      'task-orchestration', 'auto', 'hook-stop',
      '--client', 'claude-code',
      '--native-agent', 'agent-infra-lifecycle-reviewer',
      '--child-id', 'claude-child'
    ]
  });
});

test('lifecycle hook forwards exact host-observed model and effort evidence', () => {
  const fixture = createHookFixture('working');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claude-subagent-start.json'), 'utf8'));
  payload.model = 'host-model-v2';
  payload.reasoning_effort = 'high';
  payload.model_fallback_reason = 'requested model was temporarily unavailable';
  payload.reasoning_effort_fallback_reason = 'requested effort was unavailable';

  const result = run(JSON.stringify(payload), fixture);

  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout).args as string[];
  assert.deepEqual(args.slice(-8), [
    '--actual-model', 'host-model-v2',
    '--actual-reasoning-effort', 'high',
    '--model-fallback-reason', 'requested model was temporarily unavailable',
    '--reasoning-effort-fallback-reason', 'requested effort was unavailable'
  ]);
});

test('lifecycle hook fails closed when the repository-local CLI fails', () => {
  const fixture = createHookFixture('broken');

  const result = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-start.json'), 'utf8'),
    fixture
  );
  assert.equal(result.status, 23);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Local lifecycle CLI failed\n');
});

test('lifecycle hook prefers checkout source over a stale dist CLI', () => {
  const fixture = createHookFixture('source-with-stale-dist');

  const result = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-stop.json'), 'utf8'),
    fixture
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).source, 'source');
});

test('lifecycle hook rejects malformed payloads before invoking core', () => {
  const result = run('{');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Lifecycle delegation hook received invalid JSON\n');
});

test('lifecycle hook normalizes Codex spawn and child events through stdin', () => {
  const fixture = createHookFixture('working');
  const pre = run(
    fs.readFileSync(path.join(FIXTURES, 'codex-lifecycle-start.json'), 'utf8'),
    { ...fixture, client: 'codex', event: 'pre-tool', hook: fixture.hook }
  );
  assert.equal(pre.status, 0, pre.stderr);
  const parsed = JSON.parse(pre.stdout);
  assert.deepEqual(parsed.args, ['codex-lifecycle', 'hook-event', '--event', 'pre-tool', '--bridge', 'true']);
  assert.deepEqual({
    sessionId: parsed.input.sessionId,
    turnId: parsed.input.turnId,
    toolUseId: parsed.input.toolUseId,
    nativeAgent: parsed.input.nativeAgent,
    requestedModel: parsed.input.requestedModel,
    requestedReasoningEffort: parsed.input.requestedReasoningEffort
  }, {
    sessionId: 'codex-parent',
    turnId: 'codex-parent-turn',
    toolUseId: 'codex-spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor',
    requestedModel: 'gpt-5.6-sol',
    requestedReasoningEffort: 'high'
  });
  assert.match(parsed.input.hookDefinitionHash, /^[a-f0-9]{64}$/);

  const startPayload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex-lifecycle-stop.json'), 'utf8'));
  const child = run(JSON.stringify({ ...startPayload, hook_event_name: 'SubagentStart' }), {
    ...fixture, client: 'codex', event: 'subagent-start', hook: fixture.hook
  });
  assert.equal(child.status, 0, child.stderr);
  const childParsed = JSON.parse(child.stdout);
  assert.deepEqual(childParsed.args, ['codex-lifecycle', 'hook-event', '--event', 'subagent-start', '--bridge', 'true']);
  assert.equal(childParsed.input.sessionId, 'codex-parent');
  assert.equal(childParsed.input.turnId, 'codex-child-turn');
  assert.equal(childParsed.input.childThreadId, 'codex-child');
});

test('lifecycle hook forwards completed Codex waits and ignores timed out waits', () => {
  const fixture = createHookFixture('working');
  const base = {
    hook_event_name: 'PostToolUse', session_id: 'codex-parent', turn_id: 'parent-turn',
    tool_use_id: 'wait-tool', tool_name: 'collaborationwait_agent', tool_input: {}
  };
  const completed = run(JSON.stringify({
    ...base, tool_response: JSON.stringify({ message: 'Wait completed.', timed_out: false })
  }), { ...fixture, client: 'codex', event: 'post-tool', hook: fixture.hook });
  assert.equal(completed.status, 0, completed.stderr);
  const parsed = JSON.parse(completed.stdout);
  assert.equal(parsed.input.toolName, 'collaborationwait_agent');
  assert.equal(parsed.input.sessionId, 'codex-parent');

  const timedOut = run(JSON.stringify({
    ...base, tool_response: JSON.stringify({ message: 'Wait timed out.', timed_out: true })
  }), { ...fixture, client: 'codex', event: 'post-tool', hook: fixture.hook });
  assert.equal(timedOut.status, 0, timedOut.stderr);
  assert.equal(timedOut.stdout, '');
});

test('Codex PostToolUse forwards a current-loop capability marker from an ordinary tool response', () => {
  const fixture = createHookFixture('working');
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789_TOKEN';
  const result = run(JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'codex-parent',
    turn_id: 'capability-turn',
    tool_use_id: 'capability-tool',
    tool_name: 'functions.exec',
    tool_input: {},
    tool_response: { content: [{ text: `agent-infra-codex-capability:${token}` }] }
  }), { ...fixture, client: 'codex', event: 'post-tool', hook: fixture.hook });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.input.capabilityToken, token);
  assert.equal(parsed.input.sessionId, 'codex-parent');
  assert.equal(parsed.input.toolUseId, 'capability-tool');
});
