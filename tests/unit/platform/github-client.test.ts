import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';

import { classifyGitHubFailure, createGitHubClient, MINIMUM_GITHUB_CLI_VERSION, parseIncludedResponse } from '../../../lib/platform/github-client.ts';

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

test('GitHub failure diagnostics redact token-shaped credentials before classification', () => {
  const failure = classifyGitHubFailure({
    status: 1,
    stdout: '',
    stderr: 'Bearer ghp_example_secret token short-secret https://example.test/?access_token=url-secret'
  });
  assert.doesNotMatch(failure.message, /ghp_example_secret|short-secret|url-secret/);
  assert.match(failure.message, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(failure.message, /token \[REDACTED_TOKEN\]/);
  assert.match(failure.message, /access_token=\[REDACTED\]/);
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

test('the declared gh floor covers every gh flag the platform layer uses', () => {
  // Registry of gh features the platform layer depends on, mapped to the gh release
  // that introduced them. Only register unconditional, must-pass dependencies here —
  // self-gated fallback paths (e.g. --allow-escape-sequences) must not be added, or
  // the floor will be tightened unnecessarily.
  const flagFloors: Record<string, string> = {
    '--slurp': '2.48.0',
    closingIssuesReferences: '2.72.0'
  };
  const dir = path.join(import.meta.dirname, '..', '..', '..', 'lib', 'platform');
  // github-client.ts declares the floor itself; scanning it would match its own annotation.
  const callers = fs.readdirSync(dir).filter((entry) => entry.endsWith('.ts') && entry !== 'github-client.ts');
  assert.ok(callers.length > 0);
  for (const name of callers) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const [flag, floor] of Object.entries(flagFloors)) {
      if (!source.includes(flag)) continue;
      assert.ok(
        semver.gte(MINIMUM_GITHUB_CLI_VERSION, floor),
        `lib/platform/${name} uses '${flag}' (gh >= ${floor}) but the declared floor is ${MINIMUM_GITHUB_CLI_VERSION}`
      );
    }
  }
});

test('metadata JSON boundary returns the final successful attempt and parses the final response block', () => {
  let attempts = 0;
  const client = createGitHubClient({
    runner(args) {
      attempts += 1;
      if (attempts === 1) return { status: 1, stdout: '', stderr: 'HTTP 503: unavailable' };
      return {
        status: 0,
        stdout: 'HTTP/2 302 Found\r\nDate: Thu, 20 Aug 2026 00:00:00 GMT\r\n\r\nHTTP/2 200 OK\r\nDate: Thu, 20 Aug 2026 00:00:01 GMT\r\nLink: <https://api.github.com/repos/o/r?page=2>; rel="next"\r\n\r\n[]',
        stderr: ''
      };
    },
    retryDelaysMs: [0],
    sleep() {}
  });
  const result = client.jsonWithMetadata?.(['api', 'repos/o/r']);
  assert.equal(result?.ok, true);
  if (result?.ok) {
    assert.equal(result.value.metadata.status, 200);
    assert.equal(result.value.metadata.date, 'Thu, 20 Aug 2026 00:00:01 GMT');
    assert.equal(result.value.metadata.links.length, 1);
  }
  assert.equal(attempts, 2);
  assert.deepEqual(parseIncludedResponse('HTTP/2 200 OK\r\n\r\n{}', ['api', 'repos/o/r'])?.value, {});
});
