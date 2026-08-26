import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  inspectPlatformPullRequestByNumber,
  inspectGitHubIssueClosingChangeRequests,
  normalizePullRequest,
  resolveGitHubChangeRequestGitEvidence,
  selectExternalPullRequest,
  selectPullRequest,
  warningResultForPrimary
} from '../../../lib/platform/pull-requests.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

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
    labels: ['type: feature'], assignees: ['codex'], milestone: '1.0.0',
    mergeability: { state: 'unknown', detail: null }
  });
});

test('PR warning result preserves the primary lifecycle outcome', () => {
  assert.equal(warningResultForPrimary('pr_created'), 'pr_created_with_warnings');
  assert.equal(warningResultForPrimary('pr_reused'), 'pr_reused_with_warnings');
  assert.equal(warningResultForPrimary('no_op'), 'no_op_with_warnings');
});

test('PR identity normalization retains authoritative merge facts', () => {
  const merged = { ...remote(8), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-8' };
  const normalized = normalizePullRequest(merged, 'o/r');
  assert.equal(normalized?.state, 'closed');
  assert.equal(normalized?.base.sha, 'base-8');
  assert.equal(normalized?.mergedAt, '2026-07-25T00:00:00Z');
  assert.equal(normalized?.mergeCommitSha, 'merge-8');
});

test('PR mergeability normalization fails closed on missing and contradictory facts', () => {
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: false, mergeable_state: ' DIRTY ' }, 'o/r')?.mergeability, {
    state: 'conflicting', detail: 'dirty'
  });
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: true, mergeable_state: 'dirty' }, 'o/r')?.mergeability, {
    state: 'unknown', detail: 'dirty'
  });
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: true, mergeable_state: 'BLOCKED' }, 'o/r')?.mergeability, {
    state: 'mergeable', detail: 'blocked'
  });
  assert.deepEqual(normalizePullRequest({ ...remote(9), mergeable: null }, 'o/r')?.mergeability, {
    state: 'unknown', detail: null
  });
  assert.deepEqual(normalizePullRequest(remote(9), 'o/r')?.mergeability, {
    state: 'unknown', detail: null
  });
});

function prByNumberFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-by-number-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  return root;
}

function mockPrByNumberClient(pullRequest: unknown): GitHubClient {
  return {
    version() { return { ok: true, value: '2.72.0' }; },
    json(args: string[]) {
      const joined = args.join(' ');
      if (/api repos\/o\/r\/pulls\/42/.test(joined)) return { ok: true, value: pullRequest };
      if (args[1] === 'graphql' && args.some((arg) => arg.includes('viewer { login }'))) {
        return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] || '')) {
        return { ok: true, value: { full_name: 'o/r', fork: false, permissions: { triage: true, push: true, admin: false } } };
      }
      return { ok: false, error: { code: 'PLATFORM_REQUEST_FAILED', message: joined, retryable: false } };
    },
    text() { return { ok: true, value: '' }; }
  } as unknown as GitHubClient;
}

test('inspectPlatformPullRequestByNumber reads a bare PR number without a task binding', () => {
  const root = prByNumberFixture();
  try {
    const result = inspectPlatformPullRequestByNumber(42, { cwd: root, client: mockPrByNumberClient(remote(42)) });
    assert.equal(result.status, 'no-op');
    assert.equal(result.pullRequest?.number, 42);
    assert.equal(result.pullRequest?.head.sha, 'sha-42');
    assert.equal(result.pullRequest?.base.sha, 'base-42');
    assert.equal(result.task.id, null, 'bare-PR inspection must not require a task binding');
    assert.equal(result.task.prNumber, 42);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR selection fails closed for zero or multiple exact head/base matches', () => {
  assert.deepEqual(selectPullRequest([remote(1), remote(2, 'other')], 'o/r', 'feature', 'main'), {
    status: 'resolved', pullRequest: normalizePullRequest(remote(1), 'o/r')
  });
  assert.equal(selectPullRequest([], 'o/r', 'feature', 'main').status, 'missing');
  assert.equal(selectPullRequest([remote(1), remote(2)], 'o/r', 'feature', 'main').status, 'ambiguous');
});

test('external PR selection filters before uniqueness and accepts a merged fork PR', () => {
  const merged = normalizePullRequest({
    ...remote(7), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-7',
    head: { ...remote(7).head, repo: { full_name: 'contributor/r' } }
  }, 'o/r')!;
  const unmerged = normalizePullRequest(remote(8), 'o/r')!;
  const otherRepository = { ...merged, number: 9, nodeId: 'PR_9', base: { ...merged.base, repository: 'other/r' } };
  const result = selectExternalPullRequest([unmerged, otherRepository, merged], 'O/R', null, null);
  assert.equal(result.status, 'selected');
  if (result.status !== 'selected') throw new Error('expected selected result');
  assert.equal(result.source, 'unique');
  assert.equal(result.selected?.number, 7);
  assert.deepEqual(result.eligible.map((item) => item.number), [7]);
});

test('external PR selection fails closed for ambiguity, explicit mismatch, binding conflict, and identity conflict', () => {
  const first = normalizePullRequest({
    ...remote(7), state: 'closed', merged_at: '2026-07-25T00:00:00Z', merge_commit_sha: 'merge-7'
  }, 'o/r')!;
  const second = { ...first, number: 8, nodeId: 'PR_8', url: 'https://github.com/o/r/pull/8' };
  const codes = [
    selectExternalPullRequest([first, second], 'o/r', null, null),
    selectExternalPullRequest([first], 'o/r', null, 8),
    selectExternalPullRequest([first], 'o/r', 8, 7),
    selectExternalPullRequest([first, { ...first, head: { ...first.head, sha: 'different' } }], 'o/r', null, null)
  ].map((result) => result.status === 'failed' ? result.code : null);
  assert.deepEqual(codes, ['PR_IDENTITY_AMBIGUOUS', 'PR_NOT_FOUND', 'PR_BIND_CONFLICT', 'PR_IDENTITY_INVALID']);
});

test('GitHub closing PR inspection exhausts cursor pagination and fails closed on incomplete identities', () => {
  const nodes = [7, 8].map((number) => ({
    number, id: `PR_${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'MERGED',
    title: 'Merged', body: '', isDraft: false,
    headRefName: `feature-${number}`, headRefOid: `head-${number}`, headRepository: { nameWithOwner: 'fork/r' },
    baseRefName: 'main', baseRefOid: `base-${number}`, baseRepository: { nameWithOwner: 'o/r' },
    mergedAt: '2026-07-25T00:00:00Z', mergeCommit: { oid: `merge-${number}` },
    labels: { nodes: [] }, assignees: { nodes: [] }, milestone: null
  }));
  let calls = 0;
  const client = {
    json(args: string[]) {
      calls += 1;
      const second = args.includes('cursor=next');
      return { ok: true, value: { data: { repository: { issue: { closedByPullRequestsReferences: {
        nodes: [second ? nodes[1] : nodes[0]],
        pageInfo: second ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'next' }
      } } } } } };
    }
  } as unknown as GitHubClient;
  const inspected = inspectGitHubIssueClosingChangeRequests(client, 'o/r', 7, process.cwd());
  assert.equal(inspected.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(inspected.ok ? inspected.value.map((item) => item.number) : [], [7, 8]);

  const invalidClient = {
    json() {
      return { ok: true, value: { data: { repository: { issue: { closedByPullRequestsReferences: {
        nodes: [{ ...nodes[0], headRefOid: undefined }], pageInfo: { hasNextPage: false, endCursor: null }
      } } } } } };
    }
  } as unknown as GitHubClient;
  const invalid = inspectGitHubIssueClosingChangeRequests(invalidClient, 'o/r', 7, process.cwd());
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw new Error('expected invalid identity');
  assert.equal(invalid.error.code, 'PR_IDENTITY_INVALID');
});

test('GitHub evidence prefers an exact upstream remote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-evidence-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fork/r.git'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/o/r.git'], { cwd: root }).status, 0);
    const pullRequest = normalizePullRequest(remote(7), 'o/r')!;
    assert.deepEqual(resolveGitHubChangeRequestGitEvidence({
      cwd: root, repository: 'o/r', pullRequest
    }), {
      ok: true,
      value: {
        remoteUrl: 'https://github.com/o/r.git',
        reviewedHeadRef: 'refs/pull/7/head',
        targetHeadRef: 'refs/heads/main'
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub evidence preserves origin transport when rewriting a fork remote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'github-evidence-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fork/r.git'], { cwd: root }).status, 0);
    const pullRequest = normalizePullRequest(remote(7), 'o/r')!;
    assert.equal(resolveGitHubChangeRequestGitEvidence({
      cwd: root, repository: 'o/r', pullRequest
    }).value?.remoteUrl, 'git@github.com:o/r.git');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
