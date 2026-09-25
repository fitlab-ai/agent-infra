import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubProvider } from '../../../lib/platform/github-provider.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('GitHub checks normalize raw fields directly to the provider snapshot contract', async () => {
  const client = {
    json() {
      return { ok: true, value: [
        { name: 'build', bucket: 'fail', state: 'SUCCESS', link: 'https://github.com/o/r/check/1', workflow: 'CI' },
        { name: 'test', state: 'SUCCESS' },
        { context: 'queued', state: 'QUEUED' }
      ] };
    }
  } as unknown as GitHubClient;
  const provider = createGitHubProvider({
    providerType: 'github', contractVersion: 2, repositoryRoot: '/repo', config: {}
  }, client);
  assert.deepEqual(await provider.checks!.inspectRequired({
    context: { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'o/r' },
    changeRequest: { kind: 'number', value: 5 }, headSha: 'a'.repeat(40)
  }), { ok: true, value: [
    { name: 'build', status: 'fail', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/check/1' },
    { name: 'test', status: 'pass', conclusion: 'SUCCESS', detailsUrl: null },
    { name: 'queued', status: 'pending', conclusion: 'QUEUED', detailsUrl: null }
  ] });
});

test('GitHub Issue creation converts milestone titles to numeric REST IDs', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args, options = {}) {
      calls.push({ args, input: options.input });
      if (args.some((arg) => arg.includes('/milestones?'))) {
        return { ok: true, value: [[{ title: '0.9.x', number: 42 }]] } as never;
      }
      return { ok: true, value: { number: 7 } } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const provider = createGitHubProvider({
    providerType: 'github',
    contractVersion: 2,
    repositoryRoot: '/repo',
    config: {}
  }, client);

  const result = await provider.issues!.create({
    context: { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: '/repo' },
    desired: { title: 'refactor: task', body: 'body', labels: [], assignees: [], milestone: '0.9.x', fields: {} },
    mutation: { idempotencyKey: 'issue:create:test' }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const issueCall = calls.find((call) => call.args.some((arg) => arg.endsWith('/issues')))!;
  assert.deepEqual(JSON.parse(issueCall.input || '{}'), {
    title: 'refactor: task', body: 'body', labels: [], assignees: [], milestone: 42
  });
});

test('release-note provider emits typed history and keeps commit and closing-issue facts linked', async () => {
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args) {
      if (args[0] === 'release' && args[1] === 'list') {
        return { ok: true, value: [{ tagName: 'v2.0.0', isDraft: false, isPrerelease: false }] } as never;
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return { ok: true, value: { body: 'Release format', url: 'https://github.com/o/r/releases/v2.0.0' } } as never;
      }
      if (args[0] === 'pr') {
        return { ok: true, value: [{
          number: 7, title: 'fix: linked facts', body: '', url: 'https://github.com/o/r/pull/7',
          mergedAt: '2026-09-01T12:00:00Z', labels: [], author: { login: 'pr-author' }
        }] } as never;
      }
      const query = args.find((arg) => arg.startsWith('query=')) || '';
      if (query.includes('authors(first:100)')) {
        const oid = args.find((arg) => arg.startsWith('oid='))?.slice(4);
        const login = oid === 'sha-one' ? 'alice' : 'bob';
        return {
          ok: true,
          value: { data: { repository: { object: {
            authors: {
              nodes: [{ name: login, email: `${login}@example.com`, user: { login } }], pageInfo: { hasNextPage: false }
            },
            associatedPullRequests: {
              nodes: oid === 'sha-one' ? [{ number: 7 }] : [], pageInfo: { hasNextPage: false }
            }
          } } } }
        } as never;
      }
      if (query.includes('commits(first:100,after:$cursor)')) {
        return {
          ok: true,
          value: { data: { repository: { pullRequest: { commits: {
            nodes: [{ commit: { oid: 'sha-one' } }], pageInfo: { hasNextPage: false, endCursor: null }
          } } } } }
        } as never;
      }
      return {
        ok: true,
        value: { data: { repository: { pullRequest: { closingIssuesReferences: {
          nodes: [{ number: 7, title: 'Issue 7', url: 'https://github.com/o/r/issues/7', author: { login: 'reporter' } }],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } } }
      } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const provider = createGitHubProvider({
    providerType: 'github', contractVersion: 2, repositoryRoot: '/repo', config: {}
  }, client);
  const result = await provider.releases!.collectNotes({
    context: { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'o/r' },
    fromTime: '2026-09-01T00:00:00Z', toTime: '2026-09-02T00:00:00Z',
    commitOids: ['sha-one', 'sha-two'], branch: 'main', historyLimit: 3
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value.history, [{ tag: 'v2.0.0', body: 'Release format', url: 'https://github.com/o/r/releases/v2.0.0' }]);
  assert.deepEqual(result.value.commits.map(({ sha, pullRequestNumbers, authors }) => ({ sha, pullRequestNumbers, authors: authors.map((author) => author.login) })), [
    { sha: 'sha-one', pullRequestNumbers: [7], authors: ['alice'] },
    { sha: 'sha-two', pullRequestNumbers: [], authors: ['bob'] }
  ]);
  assert.equal(result.value.mergedPullRequests[0]?.author?.login, 'pr-author');
  assert.equal(result.value.mergedPullRequests[0]?.closingIssues[0]?.author?.login, 'reporter');
});
