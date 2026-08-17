import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, filePath } from '../../helpers.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-comment-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\ntype: feature\nissue_number: 7\n---\n\n# Task\n`);
  const commentsPath = path.join(root, 'comments.json');
  fs.writeFileSync(commentsPath, '[]');
  const fakeGhPath = path.join(root, 'fake-gh.cjs');
  fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fakeGhPath);
  const env = {
    ...process.env,
    AGENT_INFRA_GH_BIN: process.execPath,
    AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fakeGhPath]),
    GH_FAKE_COMMENTS_PATH: commentsPath,
    GH_FAKE_ISSUE_NUMBER: '7',
    GH_FAKE_USER: 'codex',
    GH_FAKE_PERMISSIONS: JSON.stringify({ triage: true, push: true, admin: false })
  };
  return { root, taskId, commentsPath, env };
}

function runComment(args: string[], f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-comment', ...args], {
    cwd: f.root, env: f.env, encoding: 'utf8'
  });
}

test('platform internal commands expose stable JSON and idempotent task comment sync', () => {
  const f = fixture();
  const context = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-context', 'resolve'], {
    cwd: f.root, env: f.env, encoding: 'utf8'
  });
  assert.equal(context.status, 0, context.stderr || context.stdout);
  assert.equal(JSON.parse(context.stdout).platform.repository, 'fitlab-ai/agent-infra');

  const command = [INTERNAL_CLI_PATH, 'platform-comment', 'sync', f.taskId, '--kind', 'task', '--agent', 'codex'];
  const first = spawnSync(process.execPath, command, { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'applied');
  assert.equal(JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')).length, 1);

  const second = spawnSync(process.execPath, command, { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'no-op');
  assert.equal(JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')).length, 1);
});

test('platform internal commands reject invalid payloads with exit code 1', () => {
  const result = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-comment', 'sync', 'TASK-20260101-000001'], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'COMMENT_PAYLOAD_INVALID');
});

test('summary sync creates, updates and converges on one marker while preserving supplied audit content', () => {
  const f = fixture();
  try {
    const bodyPath = path.join(f.root, 'summary.md');
    fs.writeFileSync(bodyPath, 'Decision recorded; verification pending.\n');
    const args = ['sync', f.taskId, '--kind', 'summary', '--body-file', bodyPath, '--agent', 'codex'];

    const created = runComment(args, f);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.equal(JSON.parse(created.stdout).status, 'applied');
    let comments = JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')) as Array<{ body: string }>;
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Decision recorded; verification pending\./);

    fs.writeFileSync(bodyPath, 'Original failure: FAILURE_CODE. Decision: PRC-1. Result: human override.\n');
    const updated = runComment(args, f);
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    assert.equal(JSON.parse(updated.stdout).status, 'applied');
    comments = JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')) as Array<{ body: string }>;
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Original failure: FAILURE_CODE\. Decision: PRC-1\. Result: human override\./);

    const replayed = runComment(args, f);
    assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
    assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
    assert.equal(JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')).length, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-comment backfill syncs only completion artifacts and resolves only matching excluded pr-review warnings', () => {
  const f = fixture();
  try {
    const taskMd = path.join(f.root, '.agents', 'workspace', 'active', f.taskId, 'task.md');
    fs.writeFileSync(taskMd, [
      '---', `id: ${f.taskId}`, 'type: feature', 'status: active', 'issue_number: 7', '---', '',
      '# Task', '', '## Workflow Warnings', '',
      '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
      '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
      "| WW-1 | 2026-08-07 09:00:00+08:00 | complete-task | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | COMMENT_PAYLOAD_INVALID: unsupported artifact 'pr-review.md' | retry |  |  |",
      "| WW-2 | 2026-08-07 09:01:00+08:00 | issue-sync | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | unsupported artifact 'pr-review.md' | retry |  |  |",
      '', '## Activity Log', ''
    ].join('\n'));
    const taskDir = path.dirname(taskMd);
    for (const name of ['analysis.md', 'plan.md', 'code.md', 'pr-review.md']) {
      fs.writeFileSync(path.join(taskDir, name), `# ${name}\n`);
    }

    const result = runComment(['backfill', f.taskId, '--agent', 'codex'], f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.artifacts.map((item: { artifact: string }) => item.artifact), ['analysis.md', 'plan.md', 'code.md']);
    const comments = JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')) as Array<{ body: string }>;
    assert.equal(comments.length, 3);
    const updated = fs.readFileSync(taskMd, 'utf8');
    assert.match(updated, /\| WW-1 \|[^\n]+\| resolved \|/);
    assert.match(updated, /\| WW-2 \|[^\n]+\| open \|/);

    const replay = runComment(['backfill', f.taskId, '--agent', 'codex'], f);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')).length, 3);

    const direct = runComment(['sync', f.taskId, '--kind', 'artifact', '--artifact', 'pr-review.md', '--agent', 'codex'], f);
    assert.equal(direct.status, 0, direct.stderr || direct.stdout);
    assert.equal(JSON.parse(fs.readFileSync(f.commentsPath, 'utf8')).length, 4);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-comment backfill leaves warnings open when an artifact comment fails', () => {
  const f = fixture();
  try {
    const taskMd = path.join(f.root, '.agents', 'workspace', 'active', f.taskId, 'task.md');
    fs.writeFileSync(taskMd, [
      '---', `id: ${f.taskId}`, 'type: feature', 'status: active', 'issue_number: 7', '---', '',
      '# Task', '', '## Workflow Warnings', '',
      '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
      '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
      "| WW-1 | 2026-08-07 09:00:00+08:00 | complete-task | ACTION_REQUIRED | COMMENT_SYNC_FAILED | open | artifact | unsupported artifact 'pr-review.md' | retry |  |  |",
      '', '## Activity Log', ''
    ].join('\n'));
    const taskDir = path.dirname(taskMd);
    fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# analysis\n');
    fs.writeFileSync(path.join(taskDir, 'pr-review.md'), '# review\n');
    const counter = path.join(f.root, 'failure-count.txt');
    fs.writeFileSync(counter, '3');
    const env = {
      ...f.env,
      GH_FAKE_TRANSIENT_FAIL_MATCHER: '/issues/7/comments',
      GH_FAKE_TRANSIENT_FAIL_COUNTER_FILE: counter,
      AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: '0'
    };
    const failed = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'platform-comment', 'backfill', f.taskId, '--agent', 'codex'], {
      cwd: f.root, env, encoding: 'utf8'
    });
    assert.equal(failed.status, 2, failed.stderr || failed.stdout);
    assert.match(fs.readFileSync(taskMd, 'utf8'), /\| WW-1 \|[^\n]+\| open \|/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
