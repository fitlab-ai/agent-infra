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
    providerType: 'github', contractVersion: 1, repositoryRoot: '/repo', config: {}
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
    contractVersion: 1,
    repositoryRoot: '/repo',
    config: {}
  }, client);

  const result = await provider.issues!.create({
    context: { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: '/repo' },
    desired: { title: 'refactor: task', body: 'body', labels: [], assignees: [], milestone: '0.9.x', fields: {} },
    mutation: { idempotencyKey: 'issue:create:test' }
  });

  assert.equal(result.ok, true);
  const issueCall = calls.find((call) => call.args.some((arg) => arg.endsWith('/issues')))!;
  assert.deepEqual(JSON.parse(issueCall.input || '{}'), {
    title: 'refactor: task', body: 'body', labels: [], assignees: [], milestone: 42
  });
});
