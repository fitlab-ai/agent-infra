import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveAgentRuntimeRoot,
  resolveAgentRuntimeStoreRoot
} from '../../../lib/runtime/agent-runtime.ts';

test('task-bound runtime resolves client namespaces from the generic runtime directory', () => {
  const env = {
    AGENT_INFRA_RUNTIME_DIR: '/run/agent-infra/runtime',
    AGENT_INFRA_CONTROL_TOKEN: 'token'
  };
  assert.equal(resolveAgentRuntimeRoot({ env }), '/run/agent-infra/runtime');
  assert.equal(resolveAgentRuntimeStoreRoot({ env, client: 'codex', store: 'capabilities' }), '/run/agent-infra/runtime/clients/codex/capabilities');
  assert.equal(resolveAgentRuntimeStoreRoot({ env, client: 'claude', store: 'lifecycle' }), '/run/agent-infra/runtime/clients/claude/lifecycle');
});

test('bound control context cannot fall back to workspace runtime without an explicit runtime directory', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ repoRoot: '/repo', env: { AGENT_INFRA_CONTROL_GENERATION: 'generation' } }),
    /AGENT_INFRA_RUNTIME_DIR_REQUIRED/
  );
});

test('direct-host Codex keeps the legacy store layout', () => {
  const env = {};
  assert.equal(resolveAgentRuntimeStoreRoot({ repoRoot: '/repo', env, client: 'codex', store: 'capabilities' }), '/repo/.agents/workspace/.runtime/codex-capabilities');
  assert.equal(resolveAgentRuntimeStoreRoot({ repoRoot: '/repo', env, client: 'codex', store: 'lifecycle' }), '/repo/.agents/workspace/.runtime/codex-lifecycle');
});

test('runtime directory and client namespace validation fail closed', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ env: { AGENT_INFRA_RUNTIME_DIR: 'relative/runtime' } }),
    /AGENT_INFRA_RUNTIME_DIR_INVALID/
  );
  assert.throws(
    () => resolveAgentRuntimeStoreRoot({ env: { AGENT_INFRA_RUNTIME_DIR: '/run/runtime' }, client: '../other', store: 'lifecycle' }),
    /AGENT_INFRA_RUNTIME_CLIENT_INVALID/
  );
});
