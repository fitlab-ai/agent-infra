import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubProvider } from '../../../lib/platform/github-provider.ts';
import { invokeProviderOperation } from '../../../lib/platform/provider-validation.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('GitHub provider errors match the public contract and normalize through provider validation', async () => {
  const client = {
    version: () => ({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required', retryable: false } })
  } as unknown as GitHubClient;
  const provider = createGitHubProvider({
    providerType: 'github', contractVersion: 2, repositoryRoot: '/repo', config: {}
  }, client);

  const raw = await provider.context.resolve({ repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'o/r', gitRemote: null });
  assert.deepEqual(raw, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
  const normalized = await invokeProviderOperation('github', 'context.resolve', async () => raw, (value) => value);
  assert.deepEqual(normalized, {
    ok: false,
    error: { code: 'AUTH_REQUIRED', message: 'Platform authentication is required', retryable: false, providerType: 'github', phase: 'context.resolve' }
  });
});

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

test('GitHub Issue update preserves GraphQL field writes and REST patch payloads', async () => {
  const calls: Array<{ args: string[]; method?: string; input?: string }> = [];
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args, options = {}) {
      calls.push({ args, ...options });
      if (args.some((arg) => arg.includes('/milestones?'))) return { ok: true, value: [[{ title: '0.9.x', number: 42 }]] } as never;
      if (args.some((arg) => arg.startsWith('number='))) {
        return { ok: true, value: { data: { repository: { issue: { id: 'ISSUE_NODE', issueType: { id: 'TYPE_OLD' } } } } } } as never;
      }
      const query = args.find((arg) => arg.startsWith('query=')) || '';
      if (query.includes('issueTypes')) {
        return { ok: true, value: { data: { organization: { issueTypes: { nodes: [{
          id: 'TYPE_BUG', name: 'Bug', pinnedFields: [{ __typename: 'IssueFieldNumber', id: 'FIELD_ESTIMATE', name: 'Estimate' }]
        }] } } } } } as never;
      }
      if (options.input?.includes('updateIssueIssueType')) return { ok: true, value: { data: { updateIssueIssueType: { issue: { id: 'ISSUE_NODE' } } } } } as never;
      if (options.input?.includes('setIssueFieldValue')) return { ok: true, value: { data: { setIssueFieldValue: { issue: { id: 'ISSUE_NODE' } } } } } as never;
      return { ok: true, value: { id: 'ISSUE_NODE' } } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const provider = createGitHubProvider({ providerType: 'github', contractVersion: 2, repositoryRoot: '/repo', config: {} }, client);
  const context = { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'acme/project' };

  const result = await provider.issues!.update({
    context,
    target: { kind: 'number', value: 23 },
    patch: { title: 'Updated issue', milestone: '0.9.x', issueType: 'Bug', fields: { Estimate: 3 } },
    mutation: { idempotencyKey: 'issue:update:23' }
  });

  assert.deepEqual(result, { ok: true, value: { changed: true, remoteId: '23' } });
  const typeMutation = calls.find((call) => call.input?.includes('updateIssueIssueType'));
  const fieldMutation = calls.find((call) => call.input?.includes('setIssueFieldValue'));
  const restPatch = calls.find((call) => call.method === 'PATCH' && call.args.some((arg) => arg.endsWith('/issues/23')));
  assert.deepEqual(JSON.parse(typeMutation?.input || '{}').variables, { issueId: 'ISSUE_NODE', issueTypeId: 'TYPE_BUG' });
  assert.deepEqual(JSON.parse(fieldMutation?.input || '{}').variables, {
    issueId: 'ISSUE_NODE', issueFields: [{ fieldId: 'FIELD_ESTIMATE', numberValue: 3 }]
  });
  assert.deepEqual(JSON.parse(restPatch?.input || '{}'), { title: 'Updated issue', milestone: 42 });
  assert.ok(calls.indexOf(typeMutation!) < calls.indexOf(fieldMutation!));
  assert.ok(calls.indexOf(fieldMutation!) < calls.indexOf(restPatch!));
});

test('GitHub Pull Request update preserves endpoint order and explicit milestone clearing', async () => {
  const calls: Array<{ args: string[]; method?: string; input?: string }> = [];
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args, options = {}) {
      calls.push({ args, ...options });
      return { ok: true, value: {} } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const provider = createGitHubProvider({ providerType: 'github', contractVersion: 2, repositoryRoot: '/repo', config: {} }, client);
  const context = { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'acme/project' };

  const result = await provider.changeRequests!.update({
    context,
    target: { kind: 'number', value: 31 },
    currentLabels: [],
    patch: { title: 'Updated pull request', assignees: ['alice'], milestone: null },
    mutation: { idempotencyKey: 'pull-request:update:31' }
  });

  assert.deepEqual(result, { ok: true, value: { changed: true, remoteId: '31' } });
  assert.deepEqual(calls.map((call) => call.args.find((arg) => arg.endsWith('/pulls/31') || arg.endsWith('/issues/31'))), [
    'repos/acme/project/pulls/31', 'repos/acme/project/issues/31'
  ]);
  assert.deepEqual(JSON.parse(calls[0]?.input || '{}'), { title: 'Updated pull request' });
  assert.deepEqual(JSON.parse(calls[1]?.input || '{}'), { assignees: ['alice'], milestone: null });
});

test('GitHub provider paginates and de-duplicates closing Issue identities', async () => {
  const calls: string[][] = [];
  let page = 0;
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args) {
      calls.push(args);
      page += 1;
      return { ok: true, value: { data: { repository: { pullRequest: { closingIssuesReferences: {
        nodes: page === 1 ? [{ number: 5 }, { number: 6 }] : [{ number: 6 }, { number: 7 }],
        pageInfo: page === 1 ? { hasNextPage: true, endCursor: 'cursor-1' } : { hasNextPage: false, endCursor: null }
      } } } } } } as never;
    },
    text: () => ({ ok: true, value: '' })
  };
  const provider = createGitHubProvider({ providerType: 'github', contractVersion: 2, repositoryRoot: '/repo', config: {} }, client);
  const result = await provider.changeRequests!.listClosingIssues!({
    context: { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'acme/project' },
    target: { kind: 'number', value: 31 }
  });

  assert.deepEqual(result, { ok: true, value: [
    { kind: 'number', value: 5 }, { kind: 'number', value: 6 }, { kind: 'number', value: 7 }
  ] });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.includes('cursor=cursor-1'));
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
