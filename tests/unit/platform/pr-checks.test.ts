import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRequiredChecks,
  parseRunJobIdentity,
  resolveRunCandidate,
  watchRequiredChecks
} from '../../../lib/platform/pr-checks.ts';

test('required checks classify terminal and non-terminal states', () => {
  assert.equal(classifyRequiredChecks([]).state, 'no-required');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'pass' }]).state, 'failed');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'fail' }]).state, 'failed');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'pending' }]).state, 'pending');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'cancel' }]).state, 'cancelled');
});

test('required checks watcher uses an injected monotonic deadline', async () => {
  let now = 0;
  const output = await watchRequiredChecks({
    inspect: async () => ({ state: 'pending', required: [{ name: 'build', bucket: 'pending' }] }),
    intervalMs: 10,
    deadlineMs: 20,
    now: () => now,
    sleep: async (delay) => { now += delay; }
  });
  assert.equal(output.state, 'timed-out');
  assert.equal(now, 20);
});

test('run identity prefers validated details URLs and exact unique fallback', () => {
  assert.deepEqual(parseRunJobIdentity('https://github.com/o/r/actions/runs/42/job/99'), { runId: 42, jobId: 99 });
  assert.deepEqual(resolveRunCandidate([
    { id: 4, name: 'build', headSha: 'abc' },
    { id: 5, name: 'test', headSha: 'abc' }
  ], 'abc', 'build'), { status: 'resolved', runId: 4, jobId: null });
  assert.equal(resolveRunCandidate([
    { id: 4, name: 'build', headSha: 'abc' },
    { id: 6, name: 'build', headSha: 'abc' }
  ], 'abc', 'build').status, 'ambiguous');
});
