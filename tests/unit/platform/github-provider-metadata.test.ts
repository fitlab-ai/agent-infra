import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubProvider } from '../../../lib/platform/github-provider.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('GitHub provider owns security alert transport and preserves read-before-dismiss', async () => {
  const calls: Array<{ args: string[]; method?: string; input?: string }> = [];
  const client = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args: string[], options: { method?: string; input?: string } = {}) {
      calls.push({ args, ...options });
      if (args.some((value) => value.includes('/alerts/7')) && options.method === 'PATCH') return { ok: true, value: { id: 7 } };
      if (args.some((value) => value.includes('/alerts/7'))) return { ok: true, value: { number: 7, state: 'open', summary: 'dependency' } };
      return { ok: true, value: null };
    },
    text(args: string[], options: { method?: string } = {}) {
      calls.push({ args, ...options });
      return { ok: true, value: '' };
    }
  } as GitHubClient;
  const provider = createGitHubProvider({
    providerType: 'github', contractVersion: 1, repositoryRoot: '/repo', config: {}
  }, client);
  const context = { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'acme/project' };

  const read = await provider.securityAlerts!.inspect({ context, kind: 'dependabot', number: 7 });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal((read.value.data as { summary: string }).summary, 'dependency');
  const dismissed = await provider.securityAlerts!.dismiss({
    context, kind: 'dependabot', number: 7, reason: 'not_used', comment: 'handled', mutation: { idempotencyKey: 'alert-7' }
  });
  assert.equal(dismissed.ok, true);
  assert.equal(calls[0]?.args.at(-1), 'repos/acme/project/dependabot/alerts/7');
  assert.equal(calls[1]?.method, 'PATCH');
  assert.match(calls[1]?.input || '', /"dismissed_reason":"not_used"/);
});

test('GitHub provider reconciles labels safely and creates missing milestones by title', async () => {
  const calls: Array<{ args: string[]; method?: string; input?: string }> = [];
  const client = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args: string[], options: { method?: string; input?: string } = {}) {
      calls.push({ args, ...options });
      if (args.some((value) => value.includes('/labels?'))) return { ok: true, value: [[{ name: 'in: stale', color: 'fff', description: '' }]] };
      if (args.some((value) => value.includes('/milestones?'))) return { ok: true, value: [[{ title: 'General Backlog', state: 'open' }]] };
      return { ok: true, value: { id: 1 } };
    },
    text(args: string[], options: { method?: string } = {}) {
      calls.push({ args, ...options });
      return { ok: true, value: '' };
    }
  } as GitHubClient;
  const provider = createGitHubProvider({
    providerType: 'github', contractVersion: 1, repositoryRoot: '/repo', config: {}
  }, client);
  const context = { repositoryRoot: '/repo', workingDirectory: '/repo', scopeId: 'acme/project' };

  const labels = await provider.repositoryMetadata!.reconcileLabels({
    context,
    desired: [{ name: 'in: core', color: 'BFD4F2', description: 'Module label for core' }],
    cleanupStaleIn: true,
    mutation: { idempotencyKey: 'labels' }
  });
  assert.equal(labels.ok, true);
  if (labels.ok) assert.deepEqual(labels.value.removed, ['in: stale']);
  const milestones = await provider.repositoryMetadata!.reconcileMilestones({
    context,
    desired: [{ title: '1.0.0', description: 'release', state: 'closed' }],
    mutation: { idempotencyKey: 'milestones' }
  });
  assert.equal(milestones.ok, true);
  if (milestones.ok) assert.deepEqual(milestones.value.created, ['1.0.0']);
  assert.ok(calls.some((call) => call.method === 'DELETE'));
  assert.ok(calls.some((call) => call.method === 'POST' && call.input?.includes('"state":"closed"')));
});
