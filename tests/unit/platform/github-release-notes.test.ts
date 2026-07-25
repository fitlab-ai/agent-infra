import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeGitHubActor,
  publishGitHubReleaseNotes
} from '../../../lib/platform/github-release-notes.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('GitHub actors prefer platform users, then no-reply identities, without guessing ordinary email', () => {
  assert.deepEqual(
    normalizeGitHubActor({ name: 'Alice Example', email: 'alice@example.com', user: { login: 'Alice' } }),
    { name: 'Alice Example', email: 'alice@example.com', login: 'alice', bot: false, resolution: 'platform-user' }
  );
  assert.equal(
    normalizeGitHubActor({ name: 'Robot', email: '123+Dependabot[bot]@users.noreply.github.com', user: null }).login,
    'dependabot[bot]'
  );
  assert.deepEqual(
    normalizeGitHubActor({ name: 'Unknown Person', email: 'unknown@example.com', user: null }),
    { name: 'Unknown Person', email: 'unknown@example.com', login: null, bot: false, resolution: 'unresolved' }
  );
});

test('publishing edits an existing published release and creates a missing release', () => {
  const calls: string[][] = [];
  const existing: GitHubClient = {
    version: () => ({ ok: true, value: '2.16.0' }),
    json: () => ({ ok: true, value: { tagName: 'v1.0.0', url: 'https://example/release' } }) as never,
    text(args) {
      calls.push(args);
      return { ok: true, value: 'https://example/release' };
    }
  };
  const edited = publishGitHubReleaseNotes(
    { repository: 'acme/widgets', tag: 'v1.0.0', title: 'v1.0.0', notesFile: '/tmp/notes' },
    { client: existing }
  );
  assert.equal(edited.operation, 'release:update-notes');
  assert.deepEqual(calls[0], ['release', 'edit', 'v1.0.0', '--repo', 'acme/widgets', '--notes-file', '/tmp/notes']);

  const missing: GitHubClient = {
    ...existing,
    json: () => ({ ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'missing', retryable: false } }) as never
  };
  const created = publishGitHubReleaseNotes(
    { repository: 'acme/widgets', tag: 'v1.0.0', title: 'Release 1', notesFile: '/tmp/notes' },
    { client: missing }
  );
  assert.equal(created.operation, 'release:create');
});

test('dry-run plans publishing without invoking a write', () => {
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.16.0' }),
    json: () => ({ ok: true, value: { tagName: 'v1.0.0', url: 'https://example/release' } }) as never,
    text() {
      throw new Error('write must not be called');
    }
  };
  const result = publishGitHubReleaseNotes(
    { repository: 'acme/widgets', tag: 'v1.0.0', title: 'v1.0.0', notesFile: '/tmp/notes', dryRun: true },
    { client }
  );
  assert.equal(result.status, 'planned');
  assert.equal(result.operation, 'release:update-notes');
});
