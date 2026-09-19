import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { filePath, onPlatforms } from '../../helpers.ts';
import { createInactiveControllerAuthorityState, writeControllerAuthorityState } from '../../../lib/sandbox/control/controller-authority-state.ts';
import { writeSandboxControlIdentitySentinel } from '../../../lib/sandbox/control/identity-sentinel.ts';

const TASK_ID = 'TASK-20260919-010101';

test('sandbox workflow commands execute locally without publishing a broker request', onPlatforms('linux', 'darwin'), () => {
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
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\nupdated_at: old\nagent_infra_version: v0.11.3-alpha.0\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n`);
    writeSandboxControlIdentitySentinel(statusDir, {
      version: 1, mode: 'task-bound', taskId: TASK_ID, generation, controlRootId
    });
    writeControllerAuthorityState(statusDir, createInactiveControllerAuthorityState({
      taskId: TASK_ID, generation, controlRootId
    }), { expected: null });

    const registryUrl = pathToFileURL(filePath('lib/internal/task-operation-registry.ts')).href;
    const contextUrl = pathToFileURL(filePath('lib/agent-clients/adapters/codex-lifecycle/controller-context.ts')).href;
    const warningUrl = pathToFileURL(filePath('lib/internal/task-warning.ts')).href;
    const script = `
      import { resolveSandboxControlTransport } from ${JSON.stringify(registryUrl)};
      import { verifySandboxLocalControllerAuthority } from ${JSON.stringify(contextUrl)};
      import { taskWarning } from ${JSON.stringify(warningUrl)};
      const decision = resolveSandboxControlTransport(process.env, {
        statusMountPath: process.env.AGENT_INFRA_CONTROL_STATUS_DIR,
        localWorkflow: true
      });
      if (decision.kind !== 'sandbox-local') throw new Error(JSON.stringify(decision));
      verifySandboxLocalControllerAuthority({ repoRoot: process.cwd() });
      await taskWarning([process.env.AGENT_INFRA_TASK_ID, 'list']);
    `;
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script
    ], {
      cwd: root,
      env: {
        ...process.env,
        AGENT_INFRA_TASK_ID: TASK_ID,
        AGENT_INFRA_CONTROL_TOKEN: 'local-token',
        AGENT_INFRA_CONTROL_GENERATION: generation,
        AGENT_INFRA_CONTROL_ROOT_ID: controlRootId,
        AGENT_INFRA_CONTROL_DIR: channelDir,
        AGENT_INFRA_CONTROL_STATUS_DIR: statusDir,
        AGENT_INFRA_RUNTIME_DIR: path.join(root, 'runtime'),
        AGENT_INFRA_EXECUTOR_MANIFEST: undefined,
        AGENT_INFRA_CONTROL_CONTROLLER_BINDING: undefined
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'no-op');
    assert.deepEqual(fs.readdirSync(requestsDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
