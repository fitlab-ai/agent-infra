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
  for (const operation of ['inspect', 'resolve-external', 'create', 'bind', 'sync', 'summary-context', 'summary-sync']) {
    assert.match(output.stdout, new RegExp(`platform-pr ${operation}`));
  }
});

function externalFixture(taskContent: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-pr-external-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  fs.writeFileSync(path.join(taskDir, 'task.md'), taskContent.replaceAll('{task-id}', taskId));
  const closing = path.join(root, 'closing.json');
  const calls = path.join(root, 'calls.jsonl');
  const fake = path.join(root, 'fake-gh.cjs');
  fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
  const candidate = {
    number: 771, id: 'PR_771', url: 'https://github.com/fitlab-ai/agent-infra/pull/771',
    state: 'MERGED', title: 'Community fix', body: '', isDraft: false,
    headRefName: 'community-fix', headRefOid: 'a'.repeat(40), headRepository: { nameWithOwner: 'contributor/agent-infra' },
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), baseRepository: { nameWithOwner: 'fitlab-ai/agent-infra' },
    mergedAt: '2026-08-07T01:00:00Z', mergeCommit: { oid: 'c'.repeat(40) },
    labels: { nodes: [] }, assignees: { nodes: [] }, milestone: null
  };
  fs.writeFileSync(closing, JSON.stringify([
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page-2' } },
    { previousCursor: 'page-2', nodes: [candidate], pageInfo: { hasNextPage: false, endCursor: null } }
  ]));
  const env = {
    AGENT_INFRA_GH_BIN: process.execPath,
    AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
    GH_FAKE_CLOSING_PRS_PATH: closing,
    GH_FAKE_ARGS_PATH: calls
  };
  return { root, taskId, taskDir, calls, env };
}

test('platform-pr resolve-external preserves normal tasks and fails explicitly when an empty inventory lacks an Issue', () => {
  const withArtifact = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    fs.writeFileSync(path.join(withArtifact.taskDir, 'analysis.md'), '# analysis\n');
    const normal = run(['resolve-external', withArtifact.taskId, '--agent', 'codex'], { cwd: withArtifact.root, env: withArtifact.env });
    assert.equal(normal.status, 0, normal.stderr || normal.stdout);
    assert.equal(JSON.parse(normal.stdout).mode, 'normal');
    const calls = fs.readFileSync(withArtifact.calls, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((call) => call.some((arg) => arg.includes('closedByPullRequestsReferences'))), false);
  } finally {
    fs.rmSync(withArtifact.root, { recursive: true, force: true });
  }

  const withoutIssue = externalFixture('---\nid: {task-id}\nstatus: active\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const failed = run(['resolve-external', withoutIssue.taskId, '--agent', 'codex'], { cwd: withoutIssue.root, env: withoutIssue.env });
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).error.code, 'EXTERNAL_DELIVERY_ISSUE_REQUIRED');
  } finally {
    fs.rmSync(withoutIssue.root, { recursive: true, force: true });
  }
});

test('platform-pr resolve-external paginates, binds one merged fork PR, audits evidence, and replays idempotently', () => {
  const f = externalFixture('---\nid: {task-id}\nstatus: active\nissue_number: 767\n---\n\n# Task\n\n## Activity Log\n');
  try {
    const args = ['resolve-external', f.taskId, '--agent', 'codex'];
    const first = run(args, { cwd: f.root, env: f.env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.mode, 'external');
    assert.equal(firstResult.authorization, 'unique');
    assert.equal(firstResult.selected.number, 771);
    const content = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.match(content, /^pr_number: 771$/m);
    assert.equal((content.match(/\*\*Bind External PR\*\*/g) || []).length, 1);

    const replay = run(['resolve-external', f.taskId, '--agent', 'claude'], { cwd: f.root, env: f.env });
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(replay.stdout).status, 'no-op');
    const replayContent = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.equal((replayContent.match(/\*\*Bind External PR\*\*/g) || []).length, 1);

    const explicitReplay = run(['resolve-external', f.taskId, '--agent', 'codex', '--pr', '771'], { cwd: f.root, env: f.env });
    assert.equal(explicitReplay.status, 0, explicitReplay.stderr || explicitReplay.stdout);
    assert.equal(JSON.parse(explicitReplay.stdout).status, 'no-op');
    const explicitReplayContent = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
    assert.equal((explicitReplayContent.match(/\*\*Bind External PR\*\*/g) || []).length, 1);

    const calls = fs.readFileSync(f.calls, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((call) => call.some((arg) => arg.includes('closedByPullRequestsReferences'))).length, 6);
    assert.equal(calls.some((call) => call.includes('POST') && call.some((arg) => /\/pulls$/.test(arg))), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
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
    ['resolve-external', 'TASK-1', '--agent', 'codex', '--pr', 'x'],
    ['sync', 'TASK-1', '--agent', 'codex'],
    ['summary-sync', 'TASK-1', '--agent', 'codex']
  ]) {
    const output = run(args);
    assert.equal(output.status, 1, `${args.join(' ')}\n${output.stdout}\n${output.stderr}`);
    assert.equal(JSON.parse(output.stdout).error.code, 'PR_PAYLOAD_INVALID');
  }
});
