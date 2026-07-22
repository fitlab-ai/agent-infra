import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { filePath, gitSafeEnv, INTERNAL_CLI_PATH } from '../../helpers.ts';

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-checks', ...args], {
    encoding: 'utf8', cwd: options.cwd, env: gitSafeEnv(options.env)
  });
}

test('platform-checks CLI advertises inspect, watch, run resolution and logs', () => {
  const output = run(['--help']);
  assert.equal(output.status, 0);
  for (const operation of ['inspect', 'watch', 'resolve-run', 'logs']) {
    assert.match(output.stdout, new RegExp(`platform-checks ${operation}`));
  }
});

test('platform-checks inspect returns only the structured required-check terminal state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-checks-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), ['---', `id: ${taskId}`, 'status: active', 'pr_number: 5', '---', ''].join('\n'));
    const fake = path.join(root, 'fake-gh.cjs');
    const checks = path.join(root, 'checks.json');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    fs.writeFileSync(checks, JSON.stringify([{ name: 'build', bucket: 'pass', workflow: 'CI', link: 'https://github.com/fitlab-ai/agent-infra/actions/runs/1' }]));
    const output = run(['inspect', taskId], { cwd: root, env: {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_CHECKS_PATH: checks
    } });
    assert.equal(output.status, 0, `${output.stderr}\n${output.stdout}`);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.checks.state, 'passed');
    assert.deepEqual(parsed.checks.required.map((check: { name: string }) => check.name), ['build']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-checks CLI validates numeric bounds and required arguments before I/O', () => {
  for (const args of [
    ['watch', 'TASK-1', '--interval-seconds', '0', '--deadline-seconds', '10'],
    ['resolve-run', 'TASK-1'],
    ['logs', 'TASK-1', '--run', 'nope']
  ]) {
    const output = run(args);
    assert.equal(output.status, 1, `${args.join(' ')}\n${output.stdout}\n${output.stderr}`);
    assert.equal(JSON.parse(output.stdout).error.code, 'CHECKS_PAYLOAD_INVALID');
  }
});
