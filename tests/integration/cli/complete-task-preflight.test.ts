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
      'review-ledger': null, 'manual-validation': {}, 'post-review-commit': null,
      'platform-sync-preflight': null
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

test('compiled preflight does not require a checks snapshot for a bound historical PR', () => {
  const f = fixture();
  try {
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
        'manual-validation': {},
        'post-review-commit': null,
        'platform-sync-preflight': null
      }
    }));
    fs.writeFileSync(path.join(f.activeDir, 'task.md'), [
      '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
      'updated_at: 2026-01-01 00:00:00+00:00', 'agent_infra_version: v0.0.0',
      'pr_number: 42', 'pr_status: merged', `last_reviewed_commit: ${head}`,
      'target_date:', '---', '', '# Task', ''
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      INTERNAL_CLI_PATH, 'task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json'
    ], {
      cwd: f.root,
      encoding: 'utf8',
      env: gitSafeEnv(process.env)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      payload.invocations.map((invocation: { payload: { type: string } }) => invocation.payload.type),
      ['review-ledger', 'manual-validation', 'post-review-commit', 'platform-sync-preflight']
    );
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

function reviewCodeContent(manualValidation: number) {
  return [
    '# Code Review', '',
    '## 审查摘要', '',
    '- **总体结论**：通过',
    `- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：${manualValidation}`,
    ''
  ].join('\n');
}

test('preflight blocks a pending manual validation item and passes after completion (scenario A)', () => {
  const f = fixture();
  try {
    // Review Code (Round 1) completion entry first, then a review-code with 1
    // pending manual-validation item and NO completion evidence.
    fs.appendFileSync(
      path.join(f.activeDir, 'task.md'),
      '\n- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md\n'
    );
    fs.writeFileSync(path.join(f.activeDir, 'review-code.md'), reviewCodeContent(1));

    const blocked = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json']);
    assert.equal(blocked.status, 1, blocked.stderr);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.invocations[1].payload.type, 'manual-validation');
    assert.equal(blockedPayload.invocations[1].status, 'fail');
    assert.match(blockedPayload.invocations[1].payload.message, /manual validation item\(s\) pending/);

    // Complete the manual validation AFTER the Review Code (Round 1) entry.
    fs.writeFileSync(path.join(f.activeDir, 'manual-validation.md'), '# Manual Validation\n');
    fs.appendFileSync(
      path.join(f.activeDir, 'task.md'),
      '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; verified on staging\n'
    );

    const passed = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /Manual validation completed → manual-validation\.md/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('preflight intercepts out-of-order manual validation that predates a newer review round (scenario B)', () => {
  const f = fixture();
  try {
    // ① review-code round 1 with 1 pending item + its completion entry.
    fs.writeFileSync(path.join(f.activeDir, 'review-code.md'), reviewCodeContent(1));
    fs.appendFileSync(
      path.join(f.activeDir, 'task.md'),
      '\n- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md\n'
    );
    // ② manual-validation completes for round 1, after the round 1 entry.
    fs.writeFileSync(path.join(f.activeDir, 'manual-validation.md'), '# Manual Validation\n');
    fs.appendFileSync(
      path.join(f.activeDir, 'task.md'),
      '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation.md; verified on staging\n'
    );
    // ③ a newer review-code round adds a new pending item, after the completion entry.
    fs.writeFileSync(path.join(f.activeDir, 'review-code-r2.md'), reviewCodeContent(1));
    fs.appendFileSync(
      path.join(f.activeDir, 'task.md'),
      '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 2)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code-r2.md\n'
    );

    const intercepted = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'json']);
    assert.equal(intercepted.status, 1, intercepted.stderr);
    const interceptedPayload = JSON.parse(intercepted.stdout);
    assert.equal(interceptedPayload.invocations[1].payload.type, 'manual-validation');
    assert.equal(interceptedPayload.invocations[1].status, 'fail');
    assert.match(interceptedPayload.invocations[1].payload.message, /Latest review-code \(round 2\) came after/);

    // ④ complete a new manual-validation for round 2, after the round 2 entry.
    fs.writeFileSync(path.join(f.activeDir, 'manual-validation-r2.md'), '# Manual Validation Round 2\n');
    fs.appendFileSync(
      path.join(f.activeDir, 'task.md'),
      '- 2026-01-01 00:00:00+00:00 — **Complete Manual Validation** by claude — Manual validation passed → manual-validation-r2.md; verified on staging\n'
    );

    const passed = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /Manual validation completed → manual-validation-r2\.md/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
