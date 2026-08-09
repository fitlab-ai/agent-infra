import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redactExcerpt } from '../../../lib/process-data/privacy.ts';
import { collectLocalObjects, fetchRestCollection, projectGitHubItem } from '../../../lib/process-data/sources.ts';
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
