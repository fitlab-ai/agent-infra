import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSandboxControlStatus } from '../../../lib/sandbox/control/state.ts';

function validStatus() {
  return {
    version: 3,
    generation: 'generation-1',
    broker: { pid: 123, startTime: 456, brokerId: 'broker-1' },
    state: 'healthy',
    reasonCode: null,
    activeRequestId: null,
    updatedAt: 789,
    taskView: {
      state: 'not-applicable', taskId: null, observedSource: null, receipt: null, reasonCode: null
    }
  };
}

test('sandbox control status parser preserves the validated object', () => {
  const status = validStatus();
  assert.equal(parseSandboxControlStatus(status), status);
});

test('sandbox control status parser rejects an invalid broker identity', () => {
  const status = validStatus();
  status.broker.brokerId = '';
  assert.throws(() => parseSandboxControlStatus(status), { message: 'SANDBOX_CONTROL_STATUS_INVALID' });
});
