import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  classifyPullRequestReadiness,
  classifyRequiredChecks,
  fetchCheckLogText,
  parseRunJobIdentity,
  resolveRunCandidate,
  watchPullRequestReadiness
} from '../../../lib/platform/pr-checks.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

test('required checks classify terminal and non-terminal states', () => {
  assert.equal(classifyRequiredChecks([]).state, 'no-required');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'pass' }]).state, 'passed');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'fail' }]).state, 'failed');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'pending' }]).state, 'pending');
  assert.equal(classifyRequiredChecks([{ name: 'build', bucket: 'cancel' }]).state, 'cancelled');
});

test('PR readiness watcher reaches injected deadline and preserves the observed head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-readiness-watch-'));
  const taskId = 'TASK-20260101-000001';
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: root });
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
    fs.writeFileSync(path.join(taskDir, 'task.md'), ['---', `id: ${taskId}`, 'status: active', `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
      identity: { resource: { kind: 'number', value: 5 }, repository: 'o/r', url: 'https://github.com/o/r/pull/5', head: { repository: 'o/r', ref: 'feature', sha: 'a'.repeat(40) }, base: { repository: 'o/r', ref: 'main', sha: 'b'.repeat(40) } }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
    })))}`, '---', ''].join('\n'));
    const client = {
      version() { return { ok: true as const, value: '2.72.0' }; },
      json(args: string[]) {
        const joined = args.join(' ');
        if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
          return { ok: true as const, value: { data: { viewer: { login: 'codex' } } } };
        }
        if (args[0] === 'api' && args[1] === 'repos/o/r') return { ok: true as const, value: { full_name: 'o/r', fork: false, permissions: { push: true } } };
        if (args[0] === 'api' && args[1] === 'repos/o/r/pulls/5') return { ok: true as const, value: {
          number: 5, node_id: 'PR_5', html_url: 'https://github.com/o/r/pull/5', state: 'open',
          head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } },
          base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'o/r' } },
          mergeable: null
        } };
        if (args[0] === 'pr' && args[1] === 'checks') return { ok: true as const, value: [{ name: 'build', bucket: 'pass' }] };
        return { ok: false as const, error: { code: 'PLATFORM_REQUEST_FAILED', message: joined, retryable: false } };
      },
      text() { return { ok: true as const, value: '' }; }
    } as unknown as GitHubClient;
    let now = 0;
    const output = await watchPullRequestReadiness(taskId, {
      cwd: root, client, intervalSeconds: 0.01, deadlineSeconds: 0.02,
      now: () => now,
      sleep: async (delay) => { now += delay; }
    });
    assert.equal(output.status, 'blocked');
    assert.deepEqual(output.readiness, { state: 'timed-out', headSha: 'a'.repeat(40) });
    assert.equal(output.error?.code, 'PR_READINESS_TIMEOUT');
    assert.equal(now, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR readiness watcher returns a cancelled terminal state for an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  const output = await watchPullRequestReadiness('TASK-20260101-000001', {
    intervalSeconds: 1, deadlineSeconds: 1, signal: controller.signal
  });
  assert.equal(output.status, 'blocked');
  assert.deepEqual(output.readiness, { state: 'cancelled', headSha: '' });
  assert.equal(output.error?.code, 'PR_READINESS_CANCELLED');
});

test('PR readiness requires both terminal checks and explicit mergeability for one head', () => {
  const checks = { state: 'passed' as const, required: [{ name: 'build', bucket: 'pass' as const }] };
  assert.deepEqual(classifyPullRequestReadiness({ headSha: 'a'.repeat(40), mergeability: 'conflicting', checks }), {
    state: 'conflicting', headSha: 'a'.repeat(40)
  });
  assert.deepEqual(classifyPullRequestReadiness({ headSha: 'b'.repeat(40), mergeability: 'unknown', checks }), {
    state: 'pending', headSha: 'b'.repeat(40)
  });
  assert.deepEqual(classifyPullRequestReadiness({ headSha: 'c'.repeat(40), mergeability: 'mergeable', checks }), {
    state: 'ready', headSha: 'c'.repeat(40)
  });
  assert.equal(classifyPullRequestReadiness({
    headSha: 'd'.repeat(40), mergeability: 'mergeable',
    checks: { state: 'failed', required: [{ name: 'build', bucket: 'fail' }] }
  }).state, 'checks-failed');
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
