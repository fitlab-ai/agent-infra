import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';

function runCli(args: string[]) {
  return spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8' });
}

test('ai task without subcommand prints USAGE and exits non-zero', () => {
  const out = runCli(['task']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task <command>/);
  assert.match(out.stdout, /ls \[--all/);
  assert.match(out.stdout, /show <N \| #N \| TASK-id>/);
});

test('ai task --help prints USAGE and exits zero', () => {
  const out = runCli(['task', '--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task <command>/);
});

test('ai task ls --help prints subcommand USAGE', () => {
  const out = runCli(['task', 'ls', '--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task ls/);
});

test('ai task show --help prints subcommand USAGE', () => {
  const out = runCli(['task', 'show', '--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task show/);
});

test('ai task status --help prints subcommand USAGE', () => {
  const out = runCli(['task', 'status', '--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task status/);
});

test('ai task <unknown> reports error', () => {
  const out = runCli(['task', 'wat']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Unknown task command: wat/);
});

test('agent-infra USAGE mentions the task subcommand', () => {
  const out = runCli(['help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /agent-infra task/);
});
