import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

import { gitSafeEnv, INTERNAL_CLI_PATH, onPlatforms, sandboxControlSafeEnv } from '../../helpers.ts';
import { writeSandboxControlIdentitySentinel } from '../../../lib/sandbox/control/identity-sentinel.ts';

const TASK_ID = 'TASK-20260919-010101';

test('sandbox workflow and orchestration commands execute locally without publishing a broker request', onPlatforms('linux', 'darwin'), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-local-execution-'));
  const statusDir = path.join(root, 'control', 'public');
  const channelDir = path.join(root, 'control', 'channel');
  const requestsDir = path.join(channelDir, 'requests');
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  const generation = 'local-execution-generation';
  const controlRootId = 'a'.repeat(96);
  try {
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(taskDir, { recursive: true });
    const gitEnv = gitSafeEnv();
    execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, env: gitEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, env: gitEnv });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\ncurrent_step: requirement-analysis\nupdated_at: old\nagent_infra_version: v0.11.3-alpha.0\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n`);
    execFileSync('git', ['add', '.'], { cwd: root, env: gitEnv });
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root, env: gitEnv });
    writeSandboxControlIdentitySentinel(statusDir, {
      version: 1, mode: 'task-bound', taskId: TASK_ID, generation, controlRootId
    });
    fs.writeFileSync(path.join(statusDir, 'status.json'), `${JSON.stringify({
      version: 3,
      generation,
      broker: { pid: process.pid, startTime: 0, brokerId: 'local-test-broker' },
      state: 'healthy',
      reasonCode: null,
      activeRequestId: null,
      updatedAt: Date.now(),
      taskView: { state: 'current', taskId: TASK_ID, observedSource: 'active', receipt: null, reasonCode: null }
    })}\n`);
    const env = {
      ...sandboxControlSafeEnv(gitEnv),
      AGENT_INFRA_TASK_ID: TASK_ID,
      AGENT_INFRA_CONTROL_TOKEN: 'local-token',
      AGENT_INFRA_CONTROL_GENERATION: generation,
      AGENT_INFRA_CONTROL_ROOT_ID: controlRootId,
      AGENT_INFRA_CONTROL_DIR: channelDir,
      AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
      AGENT_INFRA_RUNTIME_DIR: path.join(root, 'runtime'),
      AGENT_INFRA_EXECUTOR_MANIFEST: undefined,
      AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined
    };
    const begin = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-orchestration', TASK_ID,
      'begin-or-resume', '--client', 'claude-code',
      '--executor-model', 'executor-model', '--executor-reasoning-effort', 'high',
      '--reviewer-model', 'reviewer-model', '--reviewer-reasoning-effort', 'high'], {
      cwd: root,
      env,
      encoding: 'utf8'
    });
    assert.equal(begin.status, 0, begin.stderr || begin.stdout);
    assert.equal(JSON.parse(begin.stdout).status, 'running');

    const status = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-orchestration', TASK_ID, 'status'], {
      cwd: root,
      env,
      encoding: 'utf8'
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).taskId, TASK_ID);
    assert.deepEqual(fs.readdirSync(requestsDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
