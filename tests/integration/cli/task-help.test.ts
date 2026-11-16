import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';

const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('AGENT_INFRA_CONTROL_')
  && !['AGENT_INFRA_SANDBOX', 'AGENT_INFRA_TASK_ID', 'AGENT_INFRA_RUNTIME_DIR'].includes(key)
)) as NodeJS.ProcessEnv;

function runCli(args: string[], env: NodeJS.ProcessEnv = hostEnv) {
  return spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env });
}

test('ai task without subcommand prints USAGE and exits non-zero', () => {
  const out = runCli(['task']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Usage: ai task <command>/);
  assert.match(out.stdout, /ls \[--all/);
  assert.match(out.stdout, /show \[--task <ref> \| -t <ref>\]/);
});

test('public root help in a task-bound workspace preserves each command’s output and exit code', () => {
  const taskEnv = {
    ...hostEnv,
    AGENT_INFRA_SANDBOX: '1',
    AGENT_INFRA_TASK_ID: 'TASK-20261116-150024',
    AGENT_INFRA_CONTROL_GENERATION: 'generation-1',
    AGENT_INFRA_CONTROL_DIR: '/control',
    AGENT_INFRA_CONTROL_STATUS_DIR: '/status',
    AGENT_INFRA_RUNTIME_DIR: '/runtime'
  };

  for (const command of ['task', 't', 'sandbox', 's', 'server', 'data', 'agent-client', 'run']) {
    const host = runCli([command]);
    const bound = runCli([command], taskEnv);
    assert.match(host.stdout, /Usage: ai /, `${command}: host root usage`);
    assert.equal(bound.status, host.status, `${command}: exit code`);
    assert.equal(bound.stdout, host.stdout, `${command}: stdout`);
    assert.equal(bound.stderr, host.stderr, `${command}: stderr`);
  }
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

test('ai task log --help prints subcommand USAGE', () => {
  const out = runCli(['task', 'log', '--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task log/);
});

test('ai task grep --help prints subcommand USAGE', () => {
  const out = runCli(['task', 'grep', '--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai task grep/);
});

test('ai task <unknown> reports error', () => {
  const out = runCli(['task', 'wat']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Unknown task command: wat/);
});

test('top-level USAGE lists the task command under Commands', () => {
  const out = runCli(['help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Usage: ai <command>/);
  assert.match(out.stdout, /^\s+task, t\s+Read-only views/m);
});
