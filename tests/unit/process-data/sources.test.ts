import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redactExcerpt } from '../../../lib/process-data/privacy.ts';
import { collectGitHubBoundary, collectLocalObjects, fetchRestCollection, projectGitHubItem, projectGitHubTimelineItem } from '../../../lib/process-data/sources.ts';
import { enumerateAllTaskDirs } from '../../../lib/task/resolve-ref.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

function clientFor(pages: unknown[]): GitHubClient {
  return {
    version: () => ({ ok: true, value: '2.80.0' }),
    text: () => ({ ok: true, value: '' }),
    json: <T>(args: string[]) => {
      const url = new URL(args[1]!, 'https://api.github.test');
      const page = Number(url.searchParams.get('page'));
      return { ok: true, value: pages[page - 1] as T };
    }
  };
}

test('explicit REST pagination records canonical evidence including an empty terminal page', () => {
  const first = Array.from({ length: 100 }, (_, id) => ({ id: id + 1 }));
  const result = fetchRestCollection({
    client: clientFor([first, []]),
    endpoint: 'repos/acme/demo/issues?state=all',
    identify: (item) => String((item as { id: number }).id)
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    { requests: result.value.evidence.requestCount, pages: result.value.evidence.dataPageCount, items: result.value.evidence.itemCount },
    { requests: 2, pages: 1, items: 100 }
  );
  assert.equal(result.value.evidence.pages.length, 2);
  assert.match(result.value.evidence.pages[0]!.canonicalSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.value.evidence.termination, 'short-page');
});

test('explicit REST pagination fails closed on duplicate identities', () => {
  const result = fetchRestCollection({
    client: clientFor([[{ id: 1 }, { id: 1 }]]),
    endpoint: 'repos/acme/demo/issues',
    identify: (item) => String((item as { id: number }).id)
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'PAGINATION_UNSTABLE');
});

test('GitHub commit projection retains the approved nested commit metadata', () => {
  const projected = projectGitHubItem({
    sha: 'commit-sha',
    parents: [{ sha: 'parent-sha', url: 'ignored' }],
    author: { id: 1, login: 'octocat', avatar_url: 'ignored' },
    commit: {
      message: 'feat: preserve evidence',
      tree: { sha: 'tree-sha', url: 'ignored' },
      author: { name: 'Alice', email: 'alice@example.test', date: '2026-01-01T00:00:00Z' },
      committer: { name: 'Bob', email: 'bob@example.test', date: '2026-01-01T00:00:01Z' },
      verification: { signature: 'ignored' }
    }
  }) as Record<string, unknown>;
  assert.deepEqual(projected.parents, [{ sha: 'parent-sha' }]);
  assert.deepEqual(projected.author, { id: 1, login: 'octocat' });
  assert.deepEqual(projected.commit, {
    message: 'feat: preserve evidence',
    tree: { sha: 'tree-sha' },
    author: { name: 'Alice', email: 'alice@example.test', date: '2026-01-01T00:00:00Z' },
    committer: { name: 'Bob', email: 'bob@example.test', date: '2026-01-01T00:00:01Z' }
  });
});

test('GitHub timeline projection preserves event semantics and stable actor identity', () => {
  assert.deepEqual(projectGitHubTimelineItem({
    id: 7,
    event: 'renamed',
    actor: { id: 4, login: 'octocat', avatar_url: 'ignored' },
    rename: { from: 'old', to: 'new', issue: 'ignored' },
    created_at: '2026-08-20T00:00:00Z',
    body: 'public context'
  }), {
    id: 7,
    event: 'renamed',
    actor: { id: 4, login: 'octocat' },
    rename: { from: 'old', to: 'new' },
    created_at: '2026-08-20T00:00:00Z',
    body: 'public context'
  });
});

test('excerpt privacy rejects common cloud and messaging credentials', () => {
  assert.equal(redactExcerpt('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'), null);
  const slackWebhook = `https://hooks.slack.com/services/${'T00000000'}/${'B00000000'}/${'X'.repeat(24)}`;
  assert.equal(redactExcerpt(slackWebhook), null);
  assert.equal(redactExcerpt('token=short-lived-value'), 'token=[REDACTED]');
});

test('all-state enumeration includes the dated archive while local capture excludes sensitive bodies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-sources-'));
  const ids = ['TASK-20260101-000001', 'TASK-20260101-000002', 'TASK-20260101-000003', 'TASK-20260101-000004'];
  const dirs = [
    path.join(root, '.agents', 'workspace', 'active', ids[0]!),
    path.join(root, '.agents', 'workspace', 'blocked', ids[1]!),
    path.join(root, '.agents', 'workspace', 'completed', ids[2]!),
    path.join(root, '.agents', 'workspace', 'archive', '2026', '01', '01', ids[3]!)
  ];
  for (const [index, directory] of dirs.entries()) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'task.md'), index === 0
      ? `---\nid: ${ids[index]}\n---\npassword=super-secret-value\n`
      : `---\nid: ${ids[index]}\n---\n# Task\n`);
  }
  const sessionDir = path.join(root, '.agents', 'workspace', 'logs', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.md'), 'user-visible transcript');
  assert.deepEqual(enumerateAllTaskDirs(root).map((task) => task.taskId), ids);
  const captured = collectLocalObjects(root);
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  const sensitive = captured.value.find((object) => object.sourceIdentity.endsWith(`${ids[0]}/task.md`));
  assert.equal(sensitive?.disposition?.state, 'excluded-sensitive');
  assert.equal(sensitive?.content, undefined);
  const session = captured.value.find((object) => object.sourceIdentity.endsWith('logs/sessions/session.md'));
  assert.equal(session?.disposition?.state, 'unavailable');
  assert.equal(session?.content, undefined);
  const optedIn = collectLocalObjects(root, { includeExcerpts: true });
  assert.equal(optedIn.ok, true);
  if (!optedIn.ok) return;
  const excerpt = optedIn.value.find((object) => object.sourceIdentity.endsWith('logs/sessions/session.md#excerpt'));
  assert.equal(excerpt?.content, 'user-visible transcript');
});

test('GitHub boundary rereads W minus one second and accepts the inclusive W item', () => {
  const calls: string[] = [];
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.80.0' }),
    text: () => ({ ok: true, value: '' }),
    json: <T>(args: string[]) => ({ ok: true, value: (args[0] === 'repo' ? { nameWithOwner: 'acme/demo' } : {}) as T }),
    jsonWithMetadata: <T>(args: string[]) => {
      const url = args.find((value) => value.startsWith('repos/'))!;
      calls.push(url);
      const page = new URL(url, 'https://api.github.test');
      const value = url === 'repos/acme/demo'
        ? { id: 1 }
        : url.includes('/issues?')
          ? [{ id: 1, number: 1, updated_at: '2026-08-19T00:00:00.000Z' }]
          : [];
      return {
        ok: true,
        value: {
          value: value as T,
          metadata: {
            status: 200,
            requestUrl: `https://api.github.com/${url}`,
            date: page.pathname === '/repos/acme/demo' ? 'Thu, 20 Aug 2026 00:00:00 GMT' : 'Thu, 20 Aug 2026 00:00:01 GMT',
            links: []
          }
        }
      };
    }
  };
  const result = collectGitHubBoundary('/tmp', { client, fromInclusive: '2026-08-19T00:00:00.000Z' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const issueEndpoint = result.value.endpoints.find((endpoint) => endpoint.endpoint.includes('/issues?'))!;
  assert.equal(issueEndpoint.queryMode, 'strict-since');
  assert.equal(issueEndpoint.requestedSince, '2026-08-18T23:59:59.000Z');
  assert.equal(issueEndpoint.pages[0]!.acceptedItemCount, 1);
  assert.ok(calls.some((url) => url.includes('since=2026-08-18T23%3A59%3A59.000Z')));
  assert.equal(result.value.objects.some((object) => object.role === 'resource' && object.resourceIdentity === 'issue:1'), true);
});

test('GitHub boundary uses issue and pull numbers for all child routes', () => {
  const calls: string[] = [];
  const metadata = (value: unknown, url: string) => ({
    ok: true as const,
    value: {
      value,
      metadata: {
        status: 200,
        requestUrl: `https://api.github.com/${url}`,
        date: 'Thu, 20 Aug 2026 00:00:01 GMT',
        links: []
      }
    }
  });
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.80.0' }),
    text: () => ({ ok: true, value: '' }),
    json: <T>(args: string[]) => ({ ok: true, value: (args[0] === 'repo' ? { nameWithOwner: 'acme/demo' } : {}) as T }),
    jsonWithMetadata: <T>(args: string[]) => {
      const url = args.find((value) => value.startsWith('repos/'))!;
      calls.push(url);
      if (url === 'repos/acme/demo') return metadata({ id: 1 }, url) as never;
      if (url.includes('/issues?')) return metadata([{ id: 101, number: 1, updated_at: '2026-08-19T00:00:00Z' }], url) as never;
      if (url.includes('/pulls?')) return metadata([{ id: 202, number: 2, head: { sha: 'head-2' }, updated_at: '2026-08-19T00:00:00Z' }], url) as never;
      if (url === 'repos/acme/demo/pulls/2') return metadata({ id: 202, number: 2, head: { sha: 'head-2' }, updated_at: '2026-08-20T00:00:01Z' }, url) as never;
      return metadata([], url) as never;
    }
  };
  const result = collectGitHubBoundary('/tmp', { client, fromInclusive: '2026-08-19T00:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(calls.some((url) => url.includes('/issues/1/comments')), true);
  assert.equal(calls.some((url) => url.includes('/issues/1/timeline')), true);
  assert.equal(calls.some((url) => url.includes('/issues/2/comments')), true);
  assert.equal(calls.some((url) => url.includes('/pulls/2/comments')), true);
  assert.equal(calls.some((url) => url.includes('/issues/101/')), false);
  assert.equal(calls.some((url) => url.includes('/pulls/202/')), false);
});

test('GitHub boundary keeps an issue-view PR as page evidence and uses the pull view as canonical', () => {
  const metadata = (value: unknown, url: string) => ({
    ok: true as const,
    value: { value, metadata: { status: 200, requestUrl: `https://api.github.com/${url}`, date: 'Thu, 20 Aug 2026 00:00:01 GMT', links: [] } }
  });
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.80.0' }),
    text: () => ({ ok: true, value: '' }),
    json: <T>(args: string[]) => ({ ok: true, value: (args[0] === 'repo' ? { nameWithOwner: 'acme/demo' } : {}) as T }),
    jsonWithMetadata: <T>(args: string[]) => {
      const url = args.find((value) => value.startsWith('repos/'))!;
      if (url === 'repos/acme/demo') return metadata({ id: 1 }, url) as never;
      if (url.includes('/issues?')) return metadata([{
        id: 202, number: 2, pull_request: { url: 'https://api.github.com/repos/acme/demo/pulls/2' }, updated_at: '2026-08-19T00:00:00Z'
      }], url) as never;
      if (url.includes('/pulls?')) return metadata([{
        id: 202, number: 2, head: { sha: 'head-2' }, base: { sha: 'base-2' }, updated_at: '2026-08-19T00:00:00Z'
      }], url) as never;
      if (url === 'repos/acme/demo/pulls/2') return metadata({
        id: 202, number: 2, head: { sha: 'head-2' }, base: { sha: 'base-2' }, updated_at: '2026-08-19T00:00:01Z'
      }, url) as never;
      return metadata([], url) as never;
    }
  };
  const result = collectGitHubBoundary('/tmp', { client });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const resources = result.value.objects.filter((object) => object.role === 'resource');
  assert.equal(resources.filter((object) => object.resourceIdentity === 'pr:202').length, 1);
  assert.equal(resources.some((object) => object.resourceIdentity === 'issue:202'), false);
  assert.equal(result.value.objects.some((object) => object.role === 'page-evidence' && object.endpoint?.includes('/issues?')), true);
});

test('GitHub timeline fallback identities include their parent issue number', () => {
  const metadata = (value: unknown, url: string) => ({
    ok: true as const,
    value: { value, metadata: { status: 200, requestUrl: `https://api.github.com/${url}`, date: 'Thu, 20 Aug 2026 00:00:01 GMT', links: [] } }
  });
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.80.0' }),
    text: () => ({ ok: true, value: '' }),
    json: <T>(args: string[]) => ({ ok: true, value: (args[0] === 'repo' ? { nameWithOwner: 'acme/demo' } : {}) as T }),
    jsonWithMetadata: <T>(args: string[]) => {
      const url = args.find((value) => value.startsWith('repos/'))!;
      if (url === 'repos/acme/demo') return metadata({ id: 1 }, url) as never;
      if (url.includes('/issues?')) return metadata([
        { id: 1, number: 1, updated_at: '2026-08-19T00:00:00Z' },
        { id: 2, number: 2, updated_at: '2026-08-19T00:00:00Z' }
      ], url) as never;
      if (url.includes('/timeline')) return metadata([{ event: 'closed', created_at: '2026-08-19T01:00:00Z', actor: { id: 9 }, issue: { id: 77 } }], url) as never;
      return metadata([], url) as never;
    }
  };
  const result = collectGitHubBoundary('/tmp', { client });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const timelines = result.value.objects.filter((object) => object.role === 'resource' && object.resourceIdentity?.startsWith('timeline:'));
  assert.equal(timelines.length, 2);
  assert.deepEqual(new Set(timelines.map((object) => object.parentIdentity)), new Set(['issue:1', 'issue:2']));
});

test('GitHub pull commit collection fails closed at the documented endpoint limit', () => {
  const metadata = (value: unknown, url: string) => ({
    ok: true as const,
    value: { value, metadata: { status: 200, requestUrl: `https://api.github.com/${url}`, date: 'Thu, 20 Aug 2026 00:00:01 GMT', links: [] } }
  });
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.80.0' }),
    text: () => ({ ok: true, value: '' }),
    json: <T>(args: string[]) => ({ ok: true, value: (args[0] === 'repo' ? { nameWithOwner: 'acme/demo' } : {}) as T }),
    jsonWithMetadata: <T>(args: string[]) => {
      const url = args.find((value) => value.startsWith('repos/'))!;
      if (url === 'repos/acme/demo') return metadata({ id: 1 }, url) as never;
      if (url.includes('/issues?')) return metadata([], url) as never;
      if (url.includes('/pulls?')) return metadata([{ id: 202, number: 2, head: { sha: 'head-2' }, updated_at: '2026-08-19T00:00:00Z' }], url) as never;
      if (url === 'repos/acme/demo/pulls/2') return metadata({ id: 202, number: 2, head: { sha: 'head-2' }, updated_at: '2026-08-20T00:00:01Z' }, url) as never;
      if (url.includes('/pulls/2/commits')) {
        const page = Number(new URL(url, 'https://api.github.test').searchParams.get('page'));
        const start = (page - 1) * 100;
        const count = page < 3 ? 100 : 50;
        return metadata(Array.from({ length: count }, (_, index) => ({ sha: `commit-${start + index}`, commit: { committer: { date: '2026-08-19T00:00:00Z' } } })), url) as never;
      }
      return metadata([], url) as never;
    }
  };
  const result = collectGitHubBoundary('/tmp', { client });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PLATFORM_LIMIT_REACHED');
});
