import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostControlRequest, hostControlRequestForTaskWorkflow, requestHostControl, HostControlClientError } from '../../../lib/host-control/client.ts';
import { startHostControlServer } from '../../../lib/host-control/server.ts';

test('host-control client and service exchange typed requests without peer credential fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-service-'));
  const endpoint = path.join(root, 'run', 'host-control.sock');
  const audit: Array<Record<string, unknown>> = [];
  const server = await startHostControlServer({
    endpoint,
    dispatch: (request) => ({ operation: request.operation, taskId: request.taskId }),
    audit: (entry) => audit.push(entry)
  });
  try {
    const result = await requestHostControl({
      endpoint,
      request: hostControlRequestForTaskWorkflow({
        version: 1,
        id: 'a1234567890123456',
        taskId: 'TASK-20260904-002407',
        generation: 'generation-1',
        operation: 'artifact-inspect',
        fields: { taskRef: 'TASK-20260904-002407', family: 'code' }
      })
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { operation: 'artifact-inspect', taskId: 'TASK-20260904-002407' });
    assert.equal('peerDigest' in audit[0]!, false);
    assert.equal(audit.at(-1)?.authorityKind, 'host-broker');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-control client fails closed when the fixed endpoint is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-missing-'));
  await assert.rejects(
    requestHostControl({
      endpoint: path.join(root, 'missing.sock'),
      request: createHostControlRequest({ taskId: null, generation: null, operation: 'status', scope: 'host' })
    }),
    (error: unknown) => error instanceof HostControlClientError && error.retryable && error.code === 'HOST_CONTROL_ENDPOINT_MISSING'
  );
  fs.rmSync(root, { recursive: true, force: true });
});
