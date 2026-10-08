import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveAgentRuntimeRoot } from '../../../lib/runtime/agent-runtime.ts';

test('agent runtime resolves from the configured runtime directory', () => {
  const env = {
    AGENT_INFRA_RUNTIME_DIR: '/run/agent-infra/runtime',
    AGENT_INFRA_CONTROL_TOKEN: 'token'
  };
  const runtimeRoot = path.resolve('/run/agent-infra/runtime');
  assert.equal(resolveAgentRuntimeRoot({ env }), runtimeRoot);
});

test('bound control context cannot fall back to workspace runtime without an explicit runtime directory', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ repoRoot: '/repo', env: { AGENT_INFRA_CONTROL_GENERATION: 'generation' } }),
    /AGENT_INFRA_RUNTIME_DIR_REQUIRED/
  );
});

test('runtime directory validation fails closed', () => {
  assert.throws(
    () => resolveAgentRuntimeRoot({ env: { AGENT_INFRA_RUNTIME_DIR: 'relative/runtime' } }),
    /AGENT_INFRA_RUNTIME_DIR_INVALID/
  );
});
