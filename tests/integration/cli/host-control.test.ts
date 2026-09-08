import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHostControlRequest, hostControlRequestForTaskWorkflow, requestHostControl, HostControlClientError } from '../../../lib/host-control/client.ts';
import { hostControlAuditPath } from '../../../lib/host-control/audit.ts';
import { startHostControlServer } from '../../../lib/host-control/server.ts';

function hostControlTestRoot(prefix: string): string {
  const base = process.platform === 'darwin' ? fs.realpathSync.native(os.homedir()) : os.tmpdir();
  return fs.mkdtempSync(path.join(base, prefix));
}

test('host-control client and service exchange typed requests without peer credential fields', async () => {
  const root = hostControlTestRoot('host-control-service-');
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
  const root = hostControlTestRoot('host-control-missing-');
  await assert.rejects(
    requestHostControl({
      endpoint: path.join(root, 'missing.sock'),
      request: createHostControlRequest({ taskId: null, generation: null, operation: 'status', scope: 'host' })
    }),
    (error: unknown) => error instanceof HostControlClientError && error.retryable && error.code === 'HOST_CONTROL_ENDPOINT_MISSING'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('host-control service persists request audit when no sink is supplied', async () => {
  const root = hostControlTestRoot('host-control-default-audit-');
  const endpoint = path.join(root, 'run', 'host-control.sock');
  const server = await startHostControlServer({
    endpoint,
    dispatch: (request) => ({ operation: request.operation, taskId: request.taskId })
  });
  try {
    const result = await requestHostControl({
      endpoint,
      request: createHostControlRequest({ taskId: 'TASK-20260904-002407', generation: 'generation-1', operation: 'task-artifact', scope: 'host-command', payload: { args: ['TASK-20260904-002407', 'inspect', '--family', 'code'], workingDirectory: root } })
    });
    assert.equal(result.status, 'completed');
    const entries = fs.readFileSync(hostControlAuditPath(endpoint), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(entries.map((entry) => [entry.phase, entry.outcome]), [['accepted', 'in-progress'], ['completed', 'success']]);
    assert.equal(entries.every((entry) => !('token' in entry) && !('peerDigest' in entry)), true);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
