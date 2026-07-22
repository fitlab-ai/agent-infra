import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { filePath, gitSafeEnv, INTERNAL_CLI_PATH } from '../../helpers.ts';

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-pr', ...args], {
    encoding: 'utf8', cwd: options.cwd, env: gitSafeEnv(options.env)
  });
}

test('platform-pr CLI advertises all PR and summary intents', () => {
  const output = run(['--help']);
  assert.equal(output.status, 0);
  for (const operation of ['inspect', 'create', 'bind', 'sync', 'summary-context', 'summary-sync']) {
    assert.match(output.stdout, new RegExp(`platform-pr ${operation}`));
  }
});

test('platform-pr create binds one remote PR and replay performs no duplicate POST', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-cli-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
    const taskId = 'TASK-20260101-000001';
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---', `id: ${taskId}`, 'type: feature', 'status: active', 'issue_number: 7', '---', '',
      '# Task', '', '## Activity Log', ''
    ].join('\n'));
    const title = path.join(root, 'title.txt');
    const body = path.join(root, 'body.md');
    const pulls = path.join(root, 'pulls.json');
    const calls = path.join(root, 'calls.jsonl');
    const fake = path.join(root, 'fake-gh.cjs');
    fs.writeFileSync(title, 'feat: create adapter\n');
    fs.writeFileSync(body, 'Body\n\nCloses #7\n');
    fs.writeFileSync(pulls, '[]');
    fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
    const env = {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
      GH_FAKE_PRS_PATH: pulls,
      GH_FAKE_ARGS_PATH: calls
    };
    const args = ['create', taskId, '--agent', 'codex', '--base', 'main', '--head', 'feature', '--title-file', title, '--body-file', body];
    const created = run(args, { cwd: root, env });
    assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
    assert.equal(JSON.parse(created.stdout).status, 'applied');
    assert.match(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'), /^pr_number: 1$/m);

    const replay = run(args, { cwd: root, env });
    assert.equal(replay.status, 0, `${replay.stderr}\n${replay.stdout}`);
    assert.equal(JSON.parse(replay.stdout).status, 'no-op');
    const records = fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.equal(records.filter((call) => call.includes('POST') && call.some((item) => /\/pulls$/.test(item))).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-pr CLI rejects incomplete and conflicting payloads before I/O', () => {
  for (const args of [
    ['create', 'TASK-1', '--agent', 'codex'],
    ['bind', 'TASK-1', '--agent', 'codex', '--pr', 'x'],
    ['sync', 'TASK-1', '--agent', 'codex'],
    ['summary-sync', 'TASK-1', '--agent', 'codex']
  ]) {
    const output = run(args);
    assert.equal(output.status, 1, `${args.join(' ')}\n${output.stdout}\n${output.stderr}`);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_PAYLOAD_INVALID');
  }
});
