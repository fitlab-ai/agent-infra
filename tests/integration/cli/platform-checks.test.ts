import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { createTempDir, filePath, gitSafeEnv, INTERNAL_CLI_PATH, taskWorkspaceProject } from '../../helpers.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-checks', ...args], {
    encoding: 'utf8', cwd: options.cwd, env: gitSafeEnv(options.env)
  });
}

function boundFactLine(number = 5) {
  return `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
    identity: { resource: { kind: 'number', value: number }, repository: 'fitlab-ai/agent-infra', url: `https://github.com/fitlab-ai/agent-infra/pull/${number}`, head: { repository: 'fitlab-ai/agent-infra', ref: 'feature', sha: 'a'.repeat(40) }, base: { repository: 'fitlab-ai/agent-infra', ref: 'main', sha: 'b'.repeat(40) } }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
  })))}`;
}

function opaqueBoundFactLine() {
  return `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
    identity: { resource: { kind: 'id', value: 'pr-42' }, repository: 'opaque/project', url: 'https://opaque.example/changes/pr-42', head: { repository: 'opaque/project', ref: 'feature', sha: 'a'.repeat(40) }, base: { repository: 'opaque/project', ref: 'main', sha: 'b'.repeat(40) } }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
  })))}`;
}

function createOpaqueChecksTask(root: string) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(taskWorkspaceRoot(root), 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    project: taskWorkspaceProject(root),
    platform: {
      type: 'trae',
      providers: {
        trae: {
          source: filePath('tests/fixtures/platform-providers/opaque-identity-provider.mjs'),
          config: { repository: 'opaque/project', runId: 42, jobId: 99, logText: 'build failed' }
        }
      }
    }
  }));
  fs.writeFileSync(path.join(taskDir, 'task.md'), ['---', `id: ${taskId}`, 'status: active', opaqueBoundFactLine(), '---', ''].join('\n'));
  return taskId;
}

test('platform-checks CLI advertises inspect, watch, run resolution and logs', () => {
  const output = run(['--help']);
  assert.equal(output.status, 0);
  for (const operation of ['inspect', 'watch', 'resolve-run', 'logs']) {
    assert.match(output.stdout, new RegExp(`platform-checks ${operation}`));
  }
});

test('platform-checks inspect fails when a non-required check fails', () => {
  const root = createTempDir('platform-checks-cli-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(taskWorkspaceRoot(root),  'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), platform: { type: 'github' } }));
    fs.writeFileSync(path.join(taskDir, 'task.md'), ['---', `id: ${taskId}`, 'status: active', boundFactLine(), '---', ''].join('\n'));
    const fake = path.join(root, 'fake-gh.cjs');
    const checks = path.join(root, 'checks.json');
    const requiredChecks = path.join(root, 'required-checks.json');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    fs.writeFileSync(requiredChecks, JSON.stringify([{ name: 'build', bucket: 'pass', workflow: 'CI' }]));
    fs.writeFileSync(checks, JSON.stringify([
      { name: 'build', bucket: 'pass', workflow: 'CI' },
      { name: 'minimum baseline', bucket: 'fail', workflow: 'CI' }
    ]));
    const output = run(['inspect', taskId], { cwd: root, env: {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_CHECKS_PATH: checks,
      GH_FAKE_REQUIRED_CHECKS_PATH: requiredChecks
    } });
    assert.equal(output.status, 1, `${output.stderr}\n${output.stdout}`);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.checks.state, 'failed');
    assert.equal(parsed.readiness.state, 'checks-failed');
    assert.deepEqual(parsed.checks.required.map((check: { name: string }) => check.name), [
      'build', 'minimum baseline'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-checks inspect fails closed for conflicting, unknown, and contradictory mergeability', () => {
  const root = createTempDir('platform-readiness-cli-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(taskWorkspaceRoot(root),  'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), platform: { type: 'github' } }));
    fs.writeFileSync(path.join(taskDir, 'task.md'), ['---', `id: ${taskId}`, 'status: active', boundFactLine(), '---', ''].join('\n'));
    const fake = path.join(root, 'fake-gh.cjs');
    const checks = path.join(root, 'checks.json');
    const pr = path.join(root, 'pr.json');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    fs.writeFileSync(checks, JSON.stringify([{ name: 'build', bucket: 'pass' }]));
    const cases = [
      { value: { mergeable: false, mergeable_state: 'dirty' }, exit: 1, state: 'conflicting' },
      { value: { mergeable: null, mergeable_state: 'unknown' }, exit: 2, state: 'pending' },
      { value: { mergeable: true, mergeable_state: 'dirty' }, exit: 2, state: 'pending' }
    ];
    for (const scenario of cases) {
      fs.writeFileSync(pr, JSON.stringify(scenario.value));
      const output = run(['inspect', taskId], { cwd: root, env: {
        AGENT_INFRA_GH_BIN: process.execPath,
        AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
        GH_FAKE_CHECKS_PATH: checks,
        GH_FAKE_PR_PATH: pr
      } });
      assert.equal(output.status, scenario.exit, `${output.stderr}\n${output.stdout}`);
      assert.equal(JSON.parse(output.stdout).readiness.state, scenario.state);
    }
    fs.writeFileSync(pr, JSON.stringify({ mergeable: true, mergeable_state: 'clean' }));
    fs.writeFileSync(checks, JSON.stringify([{ name: 'build', bucket: 'fail' }]));
    const failed = run(['inspect', taskId], { cwd: root, env: {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_CHECKS_PATH: checks,
      GH_FAKE_PR_PATH: pr
    } });
    assert.equal(failed.status, 1, `${failed.stderr}\n${failed.stdout}`);
    assert.equal(JSON.parse(failed.stdout).readiness.state, 'checks-failed');
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

test('platform-checks CLI resolves a named check run through the configured provider', () => {
  const root = createTempDir('platform-check-run-dispatch-');
  try {
    const taskId = createOpaqueChecksTask(root);
    const output = run(['resolve-run', taskId, '--check-name', 'build'], { cwd: root });
    assert.equal(output.status, 0, `${output.stderr}\n${output.stdout}`);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.status, 'no-op');
    assert.deepEqual(parsed.resolution, { status: 'resolved', runId: 42, jobId: 99 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-checks CLI fetches the requested run and job logs through the configured provider', () => {
  const root = createTempDir('platform-check-logs-dispatch-');
  try {
    const taskId = createOpaqueChecksTask(root);
    const output = run(['logs', taskId, '--run', '42', '--job', '99'], { cwd: root });
    assert.equal(output.status, 0, `${output.stderr}\n${output.stdout}`);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.status, 'no-op');
    assert.deepEqual(parsed.logs, { runId: 42, jobId: 99, text: 'build failed' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-checks preserves deterministic check errors without degradation', () => {
  const root = createTempDir('platform-checks-cli-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(taskWorkspaceRoot(root),  'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), platform: { type: 'github' } }));
    fs.writeFileSync(path.join(taskDir, 'task.md'), ['---', `id: ${taskId}`, 'status: active', boundFactLine(), '---', ''].join('\n'));
    const fake = path.join(root, 'fake-gh.cjs');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    const output = run(['inspect', taskId], { cwd: root, env: {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_CHECKS_FAIL: 'checks API unavailable'
    } });
    assert.equal(output.status, 1, `${output.stderr}\n${output.stdout}`);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error.code, 'PLATFORM_REQUEST_FAILED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
