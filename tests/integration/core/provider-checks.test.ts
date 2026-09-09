import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectRequiredChecks } from '../../../lib/platform/pr-checks.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';
import { filePath } from '../../helpers.ts';

test('external provider checks preserve status classification and snapshot fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-checks-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  const identity = {
    resource: { kind: 'number' as const, value: 5 }, repository: 'o/r', url: 'https://code.example/5',
    head: { repository: 'o/r', ref: 'feature', sha: 'a'.repeat(40) },
    base: { repository: 'o/r', ref: 'main', sha: 'b'.repeat(40) }
  };
  const cases = [
    ['pass', 'pass', 'passed'], ['SUCCESS', 'pass', 'passed'], ['neutral', 'pass', 'passed'],
    ['failure', 'fail', 'failed'], ['timed_out', 'fail', 'failed'],
    ['cancelled', 'cancel', 'cancelled'], ['skipped', 'cancel', 'cancelled'],
    ['pending', 'pending', 'pending'], ['unknown', 'pending', 'pending'],
    ['completed', 'pending', 'pending']
  ] as const;
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    const fact = encodePrDeliveryFact(buildBoundFact({
      identity, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
    }));
    fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\npr_delivery_fact: ${JSON.stringify(fact)}\n---\n`);
    for (const [status, bucket, state] of cases) {
      fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
        platform: { type: 'external-checks', providers: { 'external-checks': {
          source: filePath('tests/fixtures/platform-providers/remote-evidence-provider.mjs'),
          config: {
            pullRequests: { '5': {
              number: 5, nodeId: 'PR_5', url: identity.url, state: 'open', title: 'Change', body: '',
              head: identity.head, base: identity.base, draft: false,
              labels: [], assignees: [], milestone: null, mergedAt: null, mergeCommitSha: null
            } },
            checks: [{ name: 'build', status, conclusion: 'success', detailsUrl: 'https://code.example/check/1' }]
          }
        } } }
      }));
      const result = await inspectRequiredChecks(taskId, { cwd: root });
      assert.equal(result.checks.state, state, JSON.stringify(result.error));
      assert.deepEqual(result.checks.required, [{
        name: 'build', bucket, conclusion: 'success', detailsUrl: 'https://code.example/check/1',
        workflow: null, startedAt: null, completedAt: null
      }]);
      assert.equal(result.status, bucket === 'pass' ? 'no-op' : bucket === 'pending' ? 'blocked' : 'failed');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
