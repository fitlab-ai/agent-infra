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
