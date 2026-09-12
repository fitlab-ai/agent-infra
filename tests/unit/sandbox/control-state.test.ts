import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSandboxControlTerminalResult
} from '../../../lib/sandbox/control/state.ts';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';

test('sandbox terminal evidence preserves recover-started target state for response loss', () => {
  const manifest = { generation: 'generation-1', taskId: 'TASK-20260904-002407' } as SandboxControlManifest;
  const result = createSandboxControlTerminalResult(
    manifest,
    { id: 'a'.repeat(32), family: 'task-lifecycle', operation: 'recover-started' },
    `${JSON.stringify({ status: 'applied', changed: true, targetState: 'active' })}\n`
  );

  assert.equal(result.status, 'applied');
  assert.equal(result.changed, true);
  assert.equal(result.targetState, 'active');
});
