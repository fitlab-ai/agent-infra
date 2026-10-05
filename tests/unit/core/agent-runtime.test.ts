import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  resolveAgentCapabilityStoreRoot,
  resolveAgentRuntimeRoot,
} from '../../../lib/runtime/agent-runtime.ts';

test('task-bound capability store resolves from the configured runtime directory', () => {
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

test('runtime directory validation fails closed', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ env: { AGENT_INFRA_RUNTIME_DIR: 'relative/runtime' } }),
    /AGENT_INFRA_RUNTIME_DIR_INVALID/
  );
});
