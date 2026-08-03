import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRequiredChecks,
  fetchCheckLogText,
  parseRunJobIdentity,
  resolveRunCandidate,
  watchRequiredChecks
} from '../../../lib/platform/pr-checks.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('required checks classify terminal and non-terminal states', () => {
  assert.equal(classifyRequiredChecks([]).state, 'no-required');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'pass' }]).state, 'passed');
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

test('check logs retry API responses that require explicit escape-sequence output', () => {
  const calls: string[][] = [];
  const client = {
    text(args: string[]) {
      calls.push(args);
      return args.includes('--allow-escape-sequences')
        ? { ok: true as const, value: '\u001b[31mfailed\u001b[0m' }
        : { ok: false as const, error: {
          code: 'PLATFORM_REQUEST_FAILED',
          message: 'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway',
          retryable: false
        } };
    }
  } as GitHubClient;

  const result = fetchCheckLogText(client, ['api', 'repos/o/r/actions/jobs/99/logs'], '/repo');
  assert.deepEqual(result, { ok: true, value: '\u001b[31mfailed\u001b[0m' });
  assert.deepEqual(calls, [
    ['api', 'repos/o/r/actions/jobs/99/logs'],
    ['api', 'repos/o/r/actions/jobs/99/logs', '--allow-escape-sequences']
  ]);
});
