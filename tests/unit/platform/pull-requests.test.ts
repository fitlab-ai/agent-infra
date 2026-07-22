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
  base: { ref: base, repo: { full_name: 'o/r' } },
  labels: [{ name: 'type: feature' }],
  assignees: [{ login: 'codex' }],
  milestone: { title: '1.0.0' }
});

test('PR identity normalization retains canonical remote facts', () => {
  assert.deepEqual(normalizePullRequest(remote(7), 'o/r'), {
    repository: 'o/r', number: 7, nodeId: 'PR_7', url: 'https://github.com/o/r/pull/7',
    state: 'open', title: 'Title', body: 'Body', draft: false,
    head: { repository: 'o/r', ref: 'feature', sha: 'sha-7' },
    base: { repository: 'o/r', ref: 'main' },
    labels: ['type: feature'], assignees: ['codex'], milestone: '1.0.0'
  });
});

test('PR selection fails closed for zero or multiple exact head/base matches', () => {
  assert.deepEqual(selectPullRequest([remote(1), remote(2, 'other')], 'o/r', 'feature', 'main'), {
    status: 'resolved', pullRequest: normalizePullRequest(remote(1), 'o/r')
  });
  assert.equal(selectPullRequest([], 'o/r', 'feature', 'main').status, 'missing');
  assert.equal(selectPullRequest([remote(1), remote(2)], 'o/r', 'feature', 'main').status, 'ambiguous');
});
