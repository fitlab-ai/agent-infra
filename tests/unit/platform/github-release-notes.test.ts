import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchGitHubReleaseNoteData,
  normalizeGitHubActor,
  publishGitHubReleaseNotes
} from '../../../lib/platform/github-release-notes.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('GitHub actors prefer platform users, then no-reply identities, without guessing ordinary email', () => {
  assert.deepEqual(
    normalizeGitHubActor({ name: 'Alice Example', email: 'alice@example.com', user: { login: 'Alice' } }),
    { name: 'Alice Example', login: 'alice', bot: false, resolution: 'platform-user' }
  );
  assert.equal(
    normalizeGitHubActor({ name: 'Robot', email: '123+Dependabot[bot]@users.noreply.github.com', user: null }).login,
    'dependabot[bot]'
  );
  assert.deepEqual(
    normalizeGitHubActor({ name: 'Unknown Person', email: 'unknown@example.com', user: null }),
    { name: 'Unknown Person', login: null, bot: false, resolution: 'unresolved' }
  );
});

test('collector keeps release bodies and preserves authors on each commit, pull request, and closing issue', () => {
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args) {
      if (args[0] === 'release' && args[1] === 'list') {
        return { ok: true, value: [{ tagName: 'v1.2.0', isDraft: false, isPrerelease: false }] } as never;
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return { ok: true, value: { body: '## 安装\nInstall', url: 'https://example/releases/v1.2.0' } } as never;
      }
      if (args[0] === 'pr') {
        return { ok: true, value: [{
          number: 17, title: 'fix: preserve facts', body: 'body', url: 'https://example/pull/17',
          mergedAt: '2026-09-01T12:00:00Z', labels: [{ name: 'bug' }], author: { login: 'PullAuthor' }
        }] } as never;
      }
      const query = args.find((arg) => arg.startsWith('query=')) || '';
      if (query.includes('authors(first:100)')) {
        return {
          ok: true,
          value: { data: { repository: { object: {
            authors: {
              nodes: [{ name: 'Commit One', email: 'one@example.com', user: { login: 'CommitAuthor' } }],
              pageInfo: { hasNextPage: false }
            },
            associatedPullRequests: {
              nodes: [{ number: 17 }],
              pageInfo: { hasNextPage: false }
            }
          } } } }
        } as never;
      }
      return {
        ok: true,
        value: { data: { repository: { pullRequest: { closingIssuesReferences: {
          nodes: [{ number: 8, title: 'Issue title', url: 'https://example/issues/8', author: { login: 'IssueAuthor' } }],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } } }
      } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const result = fetchGitHubReleaseNoteData({
    repository: 'example/project', commitOids: ['sha-one'], branch: 'main', historyLimit: 3,
    fromTime: '2026-09-01T00:00:00Z', toTime: '2026-09-02T00:00:00Z'
  }, { client });
  assert.equal(result.status, 'no-op', JSON.stringify(result));
  if (result.status !== 'no-op') return;
  assert.deepEqual(result.history, [{ tag: 'v1.2.0', body: '## 安装\nInstall', url: 'https://example/releases/v1.2.0' }]);
  assert.equal(result.commits[0]?.authors[0]?.login, 'commitauthor');
  assert.equal(result.pullRequests[0]?.author?.login, 'pullauthor');
  assert.equal(result.pullRequests[0]?.closingIssues[0]?.author?.login, 'issueauthor');
  assert.deepEqual(result.commits, [{
    sha: 'sha-one', url: 'https://github.com/example/project/commit/sha-one',
    pullRequestNumbers: [17], authors: [{ name: 'Commit One', login: 'commitauthor', bot: false, resolution: 'platform-user' }]
  }]);
});

test('collector uses the merged commit association when a PR commit SHA was rewritten', () => {
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args) {
      if (args[0] === 'release' && args[1] === 'list') return { ok: true, value: [] } as never;
      if (args[0] === 'pr') return { ok: true, value: [{
        number: 17, title: 'fix: preserve association', body: '', url: 'https://example/pull/17',
        mergedAt: '2026-09-01T12:00:00Z', labels: [], author: { login: 'author' }
      }] } as never;
      const query = args.find((arg) => arg.startsWith('query=')) || '';
      if (query.includes('authors(first:100)')) {
        return {
          ok: true,
          value: {
            data: {
              repository: {
                object: {
                  authors: { nodes: [], pageInfo: { hasNextPage: false } },
                  associatedPullRequests: {
                    nodes: [{ number: 17 }],
                    pageInfo: { hasNextPage: false }
                  }
                }
              }
            }
          }
        } as never;
      }
      return {
        ok: true,
        value: { data: { repository: { pullRequest: { closingIssuesReferences: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
        } } } } }
      } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const result = fetchGitHubReleaseNoteData({
    repository: 'example/project', commitOids: ['squash-merge-sha'], branch: 'main', historyLimit: 3,
    fromTime: '2026-09-01T00:00:00Z', toTime: '2026-09-02T00:00:00Z'
  }, { client });
  assert.equal(result.status, 'no-op', JSON.stringify(result));
  if (result.status !== 'no-op') return;
  assert.deepEqual(result.commits[0]?.pullRequestNumbers, [17]);
});

test('publishing edits an existing published release and creates a missing release', () => {
  const calls: string[][] = [];
  const existing: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
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
    version: () => ({ ok: true, value: '2.72.0' }),
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
