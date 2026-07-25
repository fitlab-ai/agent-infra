import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePullRequest, selectPullRequest } from '../../../lib/platform/pull-requests.ts';

const remote = (number: number, head = 'feature', base = 'main') => ({
  number,
  node_id: `PR_${number}`,
  html_url: `https://github.com/o/r/pull/${number}`,
  state: 'open',
  title: 'Title',
  body: 'Body',
  draft: false,
  head: { ref: head, sha: `sha-${number}`, repo: { full_name: 'o/r' } },
  base: { ref: base, sha: `base-${number}`, repo: { full_name: 'o/r' } },
  labels: [{ name: 'type: feature' }],
  assignees: [{ login: 'codex' }],
  milestone: { title: '1.0.0' }
});

test('PR identity normalization retains canonical remote facts', () => {
  assert.deepEqual(normalizePullRequest(remote(7), 'o/r'), {
    repository: 'o/r', number: 7, nodeId: 'PR_7', url: 'https://github.com/o/r/pull/7',
    state: 'open', title: 'Title', body: 'Body', draft: false,
    head: { repository: 'o/r', ref: 'feature', sha: 'sha-7' },
    base: { repository: 'o/r', ref: 'main', sha: 'base-7' },
    mergedAt: null, mergeCommitSha: null,
    labels: ['type: feature'], assignees: ['codex'], milestone: '1.0.0'
  });
});

test('PR identity normalization retains authoritative merge facts', () => {
  const merged = { ...remote(8), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-8' };
  const normalized = normalizePullRequest(merged, 'o/r');
  assert.equal(normalized?.state, 'closed');
  assert.equal(normalized?.base.sha, 'base-8');
  assert.equal(normalized?.mergedAt, '2026-07-25T00:00:00Z');
  assert.equal(normalized?.mergeCommitSha, 'merge-8');
});

test('PR selection fails closed for zero or multiple exact head/base matches', () => {
  assert.deepEqual(selectPullRequest([remote(1), remote(2, 'other')], 'o/r', 'feature', 'main'), {
    status: 'resolved', pullRequest: normalizePullRequest(remote(1), 'o/r')
  });
  assert.equal(selectPullRequest([], 'o/r', 'feature', 'main').status, 'missing');
  assert.equal(selectPullRequest([remote(1), remote(2)], 'o/r', 'feature', 'main').status, 'ambiguous');
});
