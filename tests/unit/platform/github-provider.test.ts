import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubProvider } from '../../../lib/platform/github-provider.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

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
