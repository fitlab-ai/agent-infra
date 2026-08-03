import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { envWithPrependedPath, writeNodeCommandShim } from '../../helpers.ts';

const HOOK = path.resolve('.agents/hooks/lifecycle-delegation.js');
const FIXTURES = path.resolve('tests/fixtures/lifecycle-hooks');

function run(input: string, client = 'claude-code', env = process.env) {
  return spawnSync('node', [HOOK, '--client', client], { cwd: path.resolve('.'), input, encoding: 'utf8', env });
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

test('lifecycle hook maps a native Claude start payload to automatic core correlation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-hook-'));
  const binDir = path.join(root, 'bin');
  const shim = path.join(root, 'internal-cli.mjs');
  fs.writeFileSync(shim, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  writeNodeCommandShim(path.join(binDir, 'agent-infra-internal'), shim);

  const result = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-start.json'), 'utf8'),
    'claude-code',
    envWithPrependedPath(process.env, binDir)
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    'task-orchestration', 'auto', 'hook-start',
    '--client', 'claude-code',
    '--native-agent', 'agent-infra-lifecycle-reviewer',
    '--child-id', 'claude-child',
    '--parent-id', 'claude-parent',
    '--spawn-mode', 'fresh'
  ]);

  const stop = run(
    fs.readFileSync(path.join(FIXTURES, 'claude-subagent-stop.json'), 'utf8'),
    'claude-code',
    envWithPrependedPath(process.env, binDir)
  );
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), [
    'task-orchestration', 'auto', 'hook-stop',
    '--client', 'claude-code',
    '--native-agent', 'agent-infra-lifecycle-reviewer',
    '--child-id', 'claude-child'
  ]);
});

test('lifecycle hook rejects malformed payloads before invoking core', () => {
  const result = run('{');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Lifecycle delegation hook received invalid JSON\n');
});
