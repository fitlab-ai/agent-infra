import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, gitSafeEnv } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-task-preflight-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const activeDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
    skill: 'complete-task', checks: {
      'review-ledger': null, 'post-review-commit': null,
      'required-checks': null, 'platform-sync-preflight': null
    }
  }));
  fs.writeFileSync(path.join(activeDir, 'task.md'), [
    '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
    'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
    'target_date:', '---', '', '# Task', '', '## Workflow Warnings', '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '', '## Activity Log', ''
  ].join('\n'));
  return { root, activeDir };
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], { cwd: root, encoding: 'utf8' });
}

test('compiled preflight runs required checks from the resolved repository root', () => {
  const f = fixture();
  const binDir = path.join(f.root, 'bin');
  const ghScript = path.join(binDir, 'gh.mjs');
  const ghLog = path.join(f.root, 'gh-calls.jsonl');
  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(f.root, 'README.md'), 'fixture\n');
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: f.root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: f.root });
    spawnSync('git', ['add', 'README.md'], { cwd: f.root });
    const committed = spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: f.root });

    fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), JSON.stringify({
      platform: { type: 'github' },
      prFlow: 'required',
      task: { shortIdLength: 2 }
    }));
    fs.writeFileSync(path.join(f.root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
      skill: 'complete-task',
      checks: {
        'review-ledger': null,
        'post-review-commit': null,
        'required-checks': {},
        'platform-sync-preflight': null
      }
    }));
    fs.writeFileSync(path.join(f.activeDir, 'task.md'), [
      '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
      'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
      'pr_number: 42', 'pr_status: merged', `last_reviewed_commit: ${head}`,
      'target_date:', '---', '', '# Task', ''
    ].join('\n'));
    fs.writeFileSync(ghScript, [
      "import fs from 'node:fs';",
      "fs.appendFileSync(process.env.GH_CALL_LOG, `${JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })}\\n`);",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') console.log('gh version 2.80.0');",
      "else if (args[0] === 'api' && args[1] === 'repos/acme/demo') console.log(JSON.stringify({ full_name: 'acme/demo', fork: false, permissions: { admin: true } }));",
      "else if (args[0] === 'api' && args[1] === 'user') console.log(JSON.stringify({ login: 'tester' }));",
      `else if (args[0] === 'api' && args[1] === 'repos/acme/demo/pulls/42') console.log(JSON.stringify({ number: 42, node_id: 'PR_42', html_url: 'https://github.com/acme/demo/pull/42', state: 'closed', title: 'fixture', body: '', draft: false, head: { ref: 'feature', sha: '${head}', repo: { full_name: 'acme/demo' } }, base: { ref: 'main', sha: '${head}', repo: { full_name: 'acme/demo' } }, merged_at: null, merge_commit_sha: null, labels: [], assignees: [], milestone: null }));`,
      "else if (args[0] === 'pr' && args[1] === 'checks') console.log(JSON.stringify([{ name: 'test', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/acme/demo/actions/runs/1', workflow: 'CI', startedAt: null, completedAt: null }]));",
      "else { console.error(`unexpected gh args: ${args.join(' ')}`); process.exitCode = 1; }",
      ''
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      INTERNAL_CLI_PATH, 'task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json'
    ], {
      cwd: f.root,
      encoding: 'utf8',
      env: {
        ...gitSafeEnv(process.env),
        AGENT_INFRA_GH_BIN: process.execPath,
        AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([ghScript]),
        GH_CALL_LOG: ghLog
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.invocations[2].status, 'pass');
    assert.match(payload.invocations[2].payload.message, new RegExp(`Required checks are passed for PR head ${head}`));
    const calls = fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const required = calls.find((call) => call.args[0] === 'pr' && call.args[1] === 'checks');
    assert.equal(fs.realpathSync.native(required.cwd), fs.realpathSync.native(f.root));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('platform-sync-preflight is a distinct typed verification result', () => {
  const f = fixture();
  try {
    const result = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.invocations[3].payload.type, 'platform-sync-preflight');
    assert.equal(payload.invocations[3].status, 'pass');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('preflight success permits one archive and releases the short id', () => {
  const f = fixture();
  try {
    const preflight = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 4);
    const completed = run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
    assert.equal(run(f.root, ['task-context', 'resolve', '#01']).status, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('completed verification resolves the archived task without moving it back to active', () => {
  const f = fixture();
  try {
    assert.equal(run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']).status, 0);
    const verified = run(f.root, ['task-verify', TASK_ID, 'complete-task.completed', '--format', 'text']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Verification: pass \| Skill: complete-task/);
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'active', TASK_ID)), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
