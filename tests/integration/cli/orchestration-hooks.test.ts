import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HOOK = path.resolve('.agents/hooks/lifecycle-delegation.js');

function run(input: string) {
  return spawnSync('node', [HOOK], { cwd: path.resolve('.'), input, encoding: 'utf8' });
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

test('lifecycle hook rejects malformed payloads before invoking core', () => {
  const result = run('{');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Lifecycle delegation hook received invalid JSON\n');
});

