import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000021';
const FAILURE_ID = 'lifecycle.apply:SHORT_ID_CAPACITY_EXCEEDED';

function fixture(state: 'active' | 'blocked'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-override-cli-'));
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const taskDir = path.join(root, '.agents', 'workspace', state, TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  const ids = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [String(index + 1).padStart(2, '0'), `TASK-20260102-${String(index + 1).padStart(6, '0')}`]));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids })}\n`);
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: ${state}\n---\n\n# Task\n\n## Activity Log\n\n`);
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-override', ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

test('task-override CLI issues and consumes a task.md-only override under the task lock', () => {
  const root = fixture('blocked');
  try {
    const issued = run(
      root,
      TASK_ID,
      'issue',
      '--failure-id', FAILURE_ID,
      '--target', 'safe-close',
      '--intent', 'activate',
      '--operator', 'external-contributor',
      '--reason', 'confirmed task identity and safe close facts',
      '--scope', 'task-lifecycle',
      '--expires-at', '2099-01-01 00:00:00+00:00'
    );
    assert.equal(issued.status, 0, issued.stderr || issued.stdout);
    const issue = JSON.parse(issued.stdout) as { status: string; ticketId: string; identity: { source: string; verified: boolean } };
    assert.equal(issue.status, 'applied');
    assert.equal(issue.identity.source, 'local-declared');
    assert.equal(issue.identity.verified, false);

    const consumed = run(
      root,
      TASK_ID,
      'consume',
      '--ticket', issue.ticketId,
      '--failure-id', FAILURE_ID,
      '--target', 'safe-close',
      '--intent', 'activate',
      '--scope', 'task-lifecycle'
    );
    assert.equal(consumed.status, 0, consumed.stderr || consumed.stdout);
    const consumption = JSON.parse(consumed.stdout) as { status: string; outcome: { result: string; effect: string } };
    assert.equal(consumption.status, 'applied');
    assert.equal(consumption.outcome.result, 'safe-closed');
    assert.equal(consumption.outcome.effect, 'apply-target');

    const taskDir = path.join(root, '.agents', 'workspace', 'completed', TASK_ID);
    assert.deepEqual(fs.readdirSync(taskDir).sort(), ['task.md']);
    assert.match(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'), /local-declared/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-override CLI rejects caller-selected platform identity', () => {
  const root = fixture('active');
  try {
    const result = run(root, TASK_ID, 'issue', '--failure-id', FAILURE_ID, '--identity-source', 'platform-verified');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'OVERRIDE_PAYLOAD_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
