import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { releaseNoteContext } from '../../../../lib/platform/release-notes.ts';
import type { GitHubClient } from '../../../../lib/platform/github-client.ts';

test('release-note context maps rewritten PR commits and keeps unrelated commits direct', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-context-'));
  const git = (args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync('git', ['-c', 'tag.gpgSign=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }
  }).trim();
  const commit = (message: string, date: string) => {
    fs.writeFileSync(path.join(root, 'change.txt'), message);
    git(['add', 'change.txt']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message], {
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date
    });
  };
  fs.mkdirSync(root, { recursive: true });
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  commit('base', '2026-08-31T00:00:00Z');
  git(['tag', 'v1.0.0']);
  commit('first change', '2026-09-01T00:00:00Z');
  const firstSha = git(['rev-parse', 'HEAD']);
  commit('direct change', '2026-09-02T00:00:00Z');
  const directSha = git(['rev-parse', 'HEAD']);
  git(['tag', 'v1.1.0']);
  const success = (value: unknown) => ({ ok: true, value }) as never;
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args) {
      if (args[0] === 'release' && args[1] === 'list') return success([{ tagName: 'v0.9.0', isDraft: false, isPrerelease: false }]);
      if (args[0] === 'release' && args[1] === 'view') return success({ body: 'History', url: 'https://example/releases/v0.9.0' });
      if (args[0] === 'pr') return success([{
        number: 7, title: 'fix: linked change', body: '', url: 'https://example/pull/7',
        mergedAt: '2026-09-01T12:00:00Z', labels: [], author: { login: 'pr-author' }
      }]);
      if (args[0] === 'api' && args[1] === 'graphql') {
        const query = args.find((arg) => arg.startsWith('query=')) || '';
        if (query.includes('viewer')) return success({ data: { viewer: { login: 'maintainer' } } });
        if (query.includes('authors(first:100)')) {
          const sha = args.find((arg) => arg.startsWith('oid='))?.slice(4);
          const login = sha === firstSha ? 'first-author' : 'direct-author';
          return success({ data: { repository: { object: {
            authors: {
              nodes: [{ name: login, email: `${login}@example.com`, user: { login } }], pageInfo: { hasNextPage: false }
            },
            associatedPullRequests: {
              nodes: sha === firstSha ? [{ number: 7 }] : [], pageInfo: { hasNextPage: false }
            }
          } } } });
        }
        if (query.includes('commits(first:100,after:$cursor)')) return success({ data: { repository: { pullRequest: { commits: {
          nodes: [{ commit: { oid: 'rewritten-original-sha' } }], pageInfo: { hasNextPage: false, endCursor: null }
        } } } } });
        return success({ data: { repository: { pullRequest: { closingIssuesReferences: {
          nodes: [{ number: 7, title: 'Issue', url: 'https://example/issues/7', author: { login: 'reporter' } }],
          pageInfo: { hasNextPage: false, endCursor: null }
        } } } } });
      }
      if (args[0] === 'api') return success({ full_name: 'example/project', permissions: { push: true } });
      throw new Error(`Unexpected platform request: ${args.join(' ')}`);
    },
    text: () => ({ ok: true, value: '' })
  };
  try {
    const context = await releaseNoteContext(
      { fromTag: 'v1.0.0', toTag: 'v1.1.0', branch: 'main' },
      { cwd: root, platformType: 'github', client }
    );
    assert.equal(context.status, 'no-op');
    assert.deepEqual(context.commits.map((item) => ({ oid: item.oid, author: item.authors[0]?.login, pullRequestNumbers: item.pullRequestNumbers })), [
      { oid: firstSha, author: 'first-author', pullRequestNumbers: [7] },
      { oid: directSha, author: 'direct-author', pullRequestNumbers: [] }
    ]);
    assert.equal(context.pullRequests[0]?.closingIssues[0]?.number, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
