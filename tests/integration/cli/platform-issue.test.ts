import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function run(args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-issue', ...args], { encoding: 'utf8' });
}

test('platform-issue CLI validates closed option combinations before I/O', () => {
  for (const args of [
    ['sync', 'TASK-20260101-000001', '--agent', 'codex'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--base', 'main'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--in-labels', 'from-diff'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--in-labels', 'none', '--base', 'main'],
    ['sync', 'TASK-20260101-000001', '--agent', 'codex', '--close-reason', 'completed'],
    ['inspect', 'TASK-20260101-000001', '--dry-run']
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).error.code, 'ISSUE_PAYLOAD_INVALID');
  }
});

test('platform-issue CLI advertises the four intent operations', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /platform-issue inspect/);
  assert.match(result.stdout, /platform-issue create/);
  assert.match(result.stdout, /platform-issue bind/);
  assert.match(result.stdout, /platform-issue sync/);
});
