import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { inspectPlatformRelease, reconcileReleaseMilestones, upsertPlatformRelease } from '../../../lib/platform/releases.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

function fixture() {
  const root = fs.mkdtempSync(`${os.tmpdir()}/platform-release-`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: root });
  fs.mkdirSync(`${root}/.agents`, { recursive: true });
  fs.writeFileSync(`${root}/.agents/.airc.json`, '{"platform":{"type":"github"}}');
  return root;
}

function client(release: Record<string, unknown> | null, options: { blocked?: boolean; calls?: string[][] } = {}): GitHubClient {
  return {
    version: () => ({ ok: true, value: '2.16.0' }),
    json(args) {
      options.calls?.push(args);
      if (args.some((arg) => arg === 'repos/acme/widgets')) {
        return { ok: true, value: { full_name: 'acme/widgets', permissions: { admin: true } } } as never;
      }
      if (args.includes('view')) {
        if (options.blocked) return { ok: false, error: { code: 'NETWORK_ERROR', message: 'offline', retryable: true } } as never;
        if (!release) return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'missing', retryable: false } } as never;
        return { ok: true, value: release } as never;
      }
      return { ok: true, value: [{ name: 'release', headBranch: 'v0.8.6', status: 'completed', conclusion: 'success' }] } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
}

test('release inspection distinguishes missing, published, and blocked facts', () => {
  const root = fixture();
  try {
    assert.equal(inspectPlatformRelease('v0.8.6', { cwd: root, client: client(null) }).release, null);
    const published = inspectPlatformRelease('v0.8.6', { cwd: root, client: client({ tagName: 'v0.8.6', isDraft: false, url: 'https://example/release' }) });
    assert.equal(published.release?.published, true);
    assert.equal(published.workflows.length, 1);
    assert.equal(inspectPlatformRelease('v0.8.6', { cwd: root, client: client(null, { blocked: true }) }).status, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release inspection requests workflow identity and ordering fields', () => {
  const root = fixture();
  const calls: string[][] = [];
  try {
    inspectPlatformRelease(
      'v0.8.6',
      { cwd: root, client: client({ tagName: 'v0.8.6', isDraft: false, url: 'https://example/release' }, { calls }) }
    );
    const runList = calls.find((args) => args[0] === 'run' && args[1] === 'list');
    assert.ok(runList);
    const fields = runList[runList.indexOf('--json') + 1]!.split(',');
    assert.deepEqual(fields, [
      'name', 'workflowName', 'displayTitle', 'event', 'headBranch', 'headSha',
      'status', 'conclusion', 'createdAt', 'databaseId', 'attempt', 'url'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release upsert is idempotent once the release is published', () => {
  const root = fixture();
  try {
    const result = upsertPlatformRelease({ tag: 'v0.8.6' }, { cwd: root, client: client({ tagName: 'v0.8.6', isDraft: false, url: 'https://example/release' }) });
    assert.equal(result.status, 'no-op');
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-free release operations are no-op without probing GitHub', () => {
  const root = fixture();
  fs.writeFileSync(`${root}/.agents/.airc.json`, '{"platform":{"type":"none"}}');
  const unavailable: GitHubClient = {
    version() {
      throw new Error('GitHub client must not be probed');
    },
    json() {
      throw new Error('GitHub client must not be probed');
    },
    text() {
      throw new Error('GitHub client must not be probed');
    }
  };
  try {
    assert.equal(inspectPlatformRelease('v0.8.6', { cwd: root, client: unavailable }).status, 'no-op');
    assert.equal(upsertPlatformRelease({ tag: 'v0.8.6' }, { cwd: root, client: unavailable }).status, 'no-op');
    assert.equal(reconcileReleaseMilestones('0.8.6', { cwd: root, client: unavailable }).status, 'no-op');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release milestone reconciliation closes current and ensures planning milestones idempotently', () => {
  const root = fixture();
  const milestones = [{ title: '0.8.6', number: 1, state: 'open' }];
  const mutable: GitHubClient = {
    version: () => ({ ok: true, value: '2.16.0' }),
    json(args) {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
      if (endpoint === 'repos/acme/widgets') return { ok: true, value: { full_name: 'acme/widgets', permissions: { admin: true } } } as never;
      if (args.at(-1) === 'user') return { ok: true, value: { login: 'codex' } } as never;
      if (endpoint.includes('/milestones?')) return { ok: true, value: milestones } as never;
      if (args.includes('PATCH')) { milestones[0]!.state = 'closed'; return { ok: true, value: {} } as never; }
      if (args.includes('POST')) {
        const title = args.find((arg) => arg.startsWith('title='))!.slice(6);
        milestones.push({ title, number: milestones.length + 1, state: 'open' });
        return { ok: true, value: {} } as never;
      }
      return { ok: true, value: {} } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  try {
    assert.equal(reconcileReleaseMilestones('0.8.6', { cwd: root, client: mutable }).status, 'applied');
    assert.equal(reconcileReleaseMilestones('0.8.6', { cwd: root, client: mutable }).status, 'no-op');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
