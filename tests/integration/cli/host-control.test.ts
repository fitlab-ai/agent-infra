import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hostControlRequestForCommand, requestHostControl, HostControlClientError } from '../../../lib/host-control/client.ts';
import { dispatchHostControlCommand } from '../../../lib/host-control/command.ts';
import { hostControlAuditPath } from '../../../lib/host-control/audit.ts';
import { startHostControlServer } from '../../../lib/host-control/server.ts';
import { onPlatforms } from '../../helpers.ts';

test('host-control propagates real command results and audits domain failure', onPlatforms('linux', 'darwin'), async () => {
  const base = process.platform === 'darwin' ? fs.realpathSync.native(os.homedir()) : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'host-control-service-'));
  const endpoint = path.join(root, 'run', 'host-control.sock');
  const previous = process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
  process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = endpoint;
  const server = await startHostControlServer({ endpoint, dispatch: dispatchHostControlCommand });
  try {
    const help = await requestHostControl({
      endpoint, request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    });
    assert.equal(help.status, 'completed');
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Usage:/u);

    const invalid = await requestHostControl({
      endpoint, request: hostControlRequestForCommand('task-artifact', ['TASK-20260904-002407', 'inspect', '--family', 'invalid'], root)
    });
    assert.equal(invalid.status, 'completed');
    assert.notEqual(invalid.exitCode, 0);
    assert.equal(JSON.parse(invalid.stdout).status, 'failed');
    const entries = fs.readFileSync(hostControlAuditPath(endpoint), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.phase, entry.outcome]), [
      ['accepted', 'in-progress'], ['completed', 'success'],
      ['accepted', 'in-progress'], ['completed', 'failure']
    ]);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
    else process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('host-control client fails closed when the fixed endpoint is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-missing-'));
  try {
    await assert.rejects(requestHostControl({
      endpoint: path.join(root, 'missing.sock'),
      request: hostControlRequestForCommand('task-artifact', ['--help'], root)
    }), (error: unknown) => error instanceof HostControlClientError && error.retryable && error.code === 'HOST_CONTROL_ENDPOINT_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const fault of ['accepted-audit', 'dispatch', 'completed-audit'] as const) {
  test(`host-control distinguishes execution state after ${fault} failure`, onPlatforms('linux', 'darwin'), async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-failure-')));
    const endpoint = path.join(root, 'run', 'host-control.sock');
    const phases: string[] = [];
    let executed = false;
    const server = await startHostControlServer({
      endpoint,
      dispatch: async () => {
        executed = true;
        if (fault === 'dispatch') throw new Error('WORKER_TERMINATED');
        return { exitCode: 0, stdout: '{}\n', stderr: '' };
      },
      audit: (entry) => {
        phases.push(entry.phase);
        if (fault === 'accepted-audit' && entry.phase === 'accepted') throw new Error('AUDIT_UNAVAILABLE');
        if (fault === 'completed-audit' && entry.phase === 'completed') throw new Error('AUDIT_UNAVAILABLE');
      }
    });
    try {
      const response = await requestHostControl({ endpoint, request: hostControlRequestForCommand('task-artifact', ['--help'], root) });
      assert.equal(executed, fault !== 'accepted-audit');
      assert.equal(response.status, executed ? 'unknown' : 'rejected');
      assert.equal(JSON.parse(response.stdout).changed, executed ? null : false);
      assert.notEqual(response.exitCode, 0);
      assert.equal(phases.includes('rejected'), !executed);
    } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
