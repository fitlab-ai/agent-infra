import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveAgentCapabilityStoreRoot,
  resolveAgentRuntimeRoot,
} from '../../../lib/runtime/agent-runtime.ts';

test('non-task capability store resolves from the configured runtime directory', () => {
  const env = {
    AGENT_INFRA_RUNTIME_DIR: '/run/agent-infra/runtime',
    AGENT_INFRA_CONTROL_TOKEN: 'token'
  };
  const runtimeRoot = path.resolve('/run/agent-infra/runtime');
  assert.equal(resolveAgentRuntimeRoot({ env }), runtimeRoot);
  assert.equal(resolveAgentCapabilityStoreRoot({ env }), path.join(runtimeRoot, 'clients', 'codex', 'capabilities'));
});

test('bound control context cannot fall back to workspace runtime without an explicit runtime directory', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ repoRoot: '/repo', env: { AGENT_INFRA_CONTROL_GENERATION: 'generation' } }),
    /AGENT_INFRA_RUNTIME_DIR_REQUIRED/
  );
});

test('direct-host capability store resolves from the workspace runtime directory', () => {
  const env = {};
  const runtimeRoot = path.join(path.resolve('/repo'), '.agents', 'workspace', '.runtime');
  assert.equal(resolveAgentCapabilityStoreRoot({ repoRoot: '/repo', env }), path.join(runtimeRoot, 'codex-capabilities'));
});

test('task-bound capability store resolves beneath the unique task runtime root', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-task-'));
  const taskId = 'TASK-20261006-000007';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\n---\n`);
  try {
    const env = { AGENT_INFRA_TASK_ID: taskId };
    const runtimeRoot = path.join(taskDir, '.runtime');
    const controlRuntimeRoot = path.join(runtimeRoot, 'sandbox-control', 'private-capabilities');
    assert.equal(resolveAgentRuntimeRoot({ repoRoot, env }), runtimeRoot);
    assert.equal(
      resolveAgentCapabilityStoreRoot({ repoRoot, env }),
      path.join(controlRuntimeRoot, 'clients', 'codex', 'capabilities')
    );
    assert.equal(
      resolveAgentCapabilityStoreRoot({ repoRoot, taskId }),
      path.join(controlRuntimeRoot, 'clients', 'codex', 'capabilities')
    );
    assert.equal(
      resolveAgentCapabilityStoreRoot({
        repoRoot,
        env: {
          AGENT_INFRA_TASK_ID: taskId,
          AGENT_INFRA_RUNTIME_DIR: path.join(runtimeRoot, 'sandbox-control', 'runtime')
        }
      }),
      path.join(controlRuntimeRoot, 'clients', 'codex', 'capabilities')
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('runtime directory validation fails closed', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ env: { AGENT_INFRA_RUNTIME_DIR: 'relative/runtime' } }),
    /AGENT_INFRA_RUNTIME_DIR_INVALID/
  );
});
