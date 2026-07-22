import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, filePath } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-task-preflight-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const activeDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(activeDir, 'task.md'), [
    '---',
    `id: ${TASK_ID}`,
    'status: active',
    'current_step: code-review',
    'updated_at: 2026-01-01 00:00:00+00:00',
    'agent_infra_version: v0.0.0',
    'target_date:',
    '---',
    '',
    '# Task',
    '',
    '## Workflow Warnings',
    '',
    '| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |',
    '|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|',
    '',
    '## Activity Log',
    ''
  ].join('\n'));
  return { root, activeDir };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, ...args], { cwd: root, encoding: 'utf8', env });
}

test('platform-sync-preflight dispatches through the registered adapter with its own result type', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [
      filePath('.agents/scripts/validate-artifact.js'),
      'check', 'platform-sync-preflight', f.activeDir, '--skill', 'complete-task', '--format', 'json'
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      { status: JSON.parse(result.stdout).status, type: JSON.parse(result.stdout).type },
      { status: 'pass', type: 'platform-sync-preflight' }
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('preflight sync failure keeps the active task, short id, and structured warning', () => {
  const f = fixture();
  try {
    const warning = run(f.root, [
      'task-warning', TASK_ID, 'add', '--step', 'complete-task', '--severity', 'ACTION_REQUIRED',
      '--code', 'REQUIREMENTS_SYNC_FAILED', '--target', 'issue', '--message', 'fixture failure', '--action', 'retry complete-task'
    ]);
    assert.equal(warning.status, 0, warning.stderr);
    assert.equal(JSON.parse(warning.stdout).entityId, 'WW-1');
    assert.equal(fs.existsSync(f.activeDir), true);

    const resolved = run(f.root, ['task-context', 'resolve', '#01']);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).taskState, 'active');

    const listed = run(f.root, ['task-warning', TASK_ID, 'list', '--status', 'open']);
    assert.equal(JSON.parse(listed.stdout).warnings[0].code, 'REQUIREMENTS_SYNC_FAILED');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('successful preflight can archive once and release the short id', () => {
  const f = fixture();
  try {
    const scriptsDir = path.join(f.root, '.agents', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'validate-artifact.js'), [
      'const args = process.argv.slice(2);',
      "process.stdout.write(JSON.stringify({status:'pass',skill:args[args.indexOf('--skill') + 1],type:args[1],message:'fixture'}) + '\\n');"
    ].join('\n'));

    const preflight = run(f.root, ['task-verify', TASK_ID, 'complete-task.preflight', '--format', 'text']);
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 3);

    const completed = run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);

    const shortRef = run(f.root, ['task-context', 'resolve', '#01']);
    assert.equal(shortRef.status, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('completed finalization gate can fail and then pass without moving the task back to active', () => {
  const f = fixture();
  try {
    const completed = run(f.root, ['task-lifecycle', TASK_ID, 'complete', '--agent', 'codex']);
    assert.equal(completed.status, 0, completed.stderr);

    const scriptsDir = path.join(f.root, '.agents', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'validate-artifact.js'), [
      "const blocked = process.env.FINALIZATION_BLOCKED === '1';",
      "const gate = blocked ? 'blocked' : 'pass';",
      "process.stdout.write(JSON.stringify({gate,skill:'complete-task',checks:[{type:'platform-sync',status:gate,message:'fixture'}],summary:'fixture',action:'retry'}) + '\\n');",
      'process.exit(blocked ? 2 : 0);'
    ].join('\n'));

    const blocked = run(f.root, ['task-verify', TASK_ID, 'complete-task.completed', '--format', 'text'], { ...process.env, FINALIZATION_BLOCKED: '1' });
    assert.equal(blocked.status, 2);
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'active', TASK_ID)), false);

    const recovered = run(f.root, ['task-verify', TASK_ID, 'complete-task.completed', '--format', 'text']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Verification: pass \| Skill: complete-task/);
    assert.equal(fs.existsSync(path.join(f.root, '.agents', 'workspace', 'completed', TASK_ID, 'task.md')), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
