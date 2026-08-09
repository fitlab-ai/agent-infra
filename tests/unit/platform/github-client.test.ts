import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyGitHubFailure, createGitHubClient } from '../../../lib/platform/github-client.ts';

test('GitHub client reads the CLI version without shell parsing', () => {
  const calls: string[][] = [];
  const client = createGitHubClient({
    runner(args) {
      calls.push(args);
      return { status: 0, stdout: 'gh version 2.16.0 (2022-09-21)\n', stderr: '' };
    }
  });
  assert.deepEqual(client.version(), { ok: true, value: '2.16.0' });
  assert.deepEqual(calls, [['--version']]);
});

test('GitHub client preserves argv and stdin without a shell', () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const client = createGitHubClient({
    runner(args, options) {
      calls.push({ args, input: options.input });
      return { status: 0, stdout: '{"ok":true}', stderr: '' };
    },
    retryDelaysMs: []
  });

  const body = 'space | `tick` $(never)\n下一行';
  const result = client.json(['api', 'repos/o/r/issues/1/comments', '--input', '-'], { input: body });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    args: ['api', 'repos/o/r/issues/1/comments', '--input', '-'],
    input: body
  }]);
});

test('GitHub failure classification distinguishes auth, permission and retryable failures', () => {
  assert.equal(classifyGitHubFailure({ status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }).code, 'AUTH_REQUIRED');
  assert.equal(classifyGitHubFailure({ status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }).code, 'PERMISSION_DENIED');
  const transient = classifyGitHubFailure({ status: 1, stdout: '', stderr: 'HTTP 429: rate limit' });
  assert.equal(transient.code, 'NETWORK_TRANSIENT');
  assert.equal(transient.retryable, true);
  assert.equal(classifyGitHubFailure({ status: 1, stdout: '', stderr: 'dial tcp: i/o timeout' }).retryable, true);
  assert.equal(classifyGitHubFailure({ status: 1, stdout: '', stderr: 'HTTP 422: validation failed' }).retryable, false);
});

test('GitHub failure classification rejects output overflow without replaying or echoing response bodies', () => {
  const error = Object.assign(new Error('spawnSync gh ENOBUFS'), { code: 'ENOBUFS' });
  const failure = classifyGitHubFailure({ status: null, stdout: 'private-response-body'.repeat(100_000), stderr: '', error });
  assert.equal(failure.code, 'PLATFORM_OUTPUT_TOO_LARGE');
  assert.equal(failure.retryable, false);
  assert.equal(failure.message, 'GitHub CLI output exceeded the configured limit');
});

test('GitHub client retries reads but does not blindly replay posts', () => {
  let attempts = 0;
  const client = createGitHubClient({
    runner() {
      attempts += 1;
      return attempts < 3
        ? { status: 1, stdout: '', stderr: 'HTTP 503: unavailable' }
        : { status: 0, stdout: '[]', stderr: '' };
    },
    retryDelaysMs: [0, 0],
    sleep() {}
  });
  assert.equal(client.json(['api', 'repos/o/r']).ok, true);
  assert.equal(attempts, 3);

  attempts = 0;
  const exhausted = createGitHubClient({
    runner() {
      attempts += 1;
      return { status: 1, stdout: '', stderr: 'HTTP 503: unavailable' };
    },
    retryDelaysMs: [0],
    sleep() {}
  }).json(['api', 'repos/o/r']);
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) assert.equal(exhausted.error.code, 'NETWORK_RETRY_EXHAUSTED');
  assert.equal(attempts, 2);

  attempts = 0;
  const post = client.json(['api', 'repos/o/r/issues/1/comments', '-X', 'POST'], { method: 'POST' });
  assert.equal(post.ok, false);
  assert.equal(attempts, 1);
});
