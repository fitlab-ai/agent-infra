import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  listPrReviews,
  publishPrReview,
  reviewMarker,
  reviewedCommitMarker
} from '../../../lib/platform/pr-review.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

type MockReview = { id: number; commit_id: string; body: string; html_url: string };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-adapter-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  return root;
}

function mockClient(options: {
  initial?: MockReview[];
  failPostTimes?: number;
} = {}) {
  const reviews: MockReview[] = [...(options.initial || [])];
  const postedBodies: string[] = [];
  let nextId = 100;
  let transientFailures = options.failPostTimes ?? 0;

  const json = (args: string[], request: { method?: string; input?: string } = {}) => {
    const joined = args.join(' ');
    if (joined.includes('api --paginate --slurp repos/acme/widgets/pulls/') && joined.includes('/reviews')) {
      return { ok: true as const, value: [reviews] };
    }
    if (args.includes('-X') && args.includes('POST') && joined.includes('/pulls/42/reviews')) {
      const input = JSON.parse(request.input || '{}') as { commit_id?: string; body?: string; event?: string };
      postedBodies.push(input.body || '');
      if (transientFailures > 0) {
        transientFailures -= 1;
        reviews.push({ id: nextId, commit_id: input.commit_id || '', body: input.body || '', html_url: 'https://github.com/acme/widgets/pull/42#r1' });
        nextId += 1;
        return { ok: false as const, error: { code: 'NETWORK_TRANSIENT', message: 'timeout', retryable: true } };
      }
      const created: MockReview = { id: nextId, commit_id: input.commit_id || '', body: input.body || '', html_url: 'https://github.com/acme/widgets/pull/42#r1' };
      nextId += 1;
      reviews.push(created);
      return { ok: true as const, value: created };
    }
    if (args[1] === 'graphql') {
      return { ok: true as const, value: { data: { viewer: { login: 'codex' } } } };
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] || '')) {
      return { ok: true as const, value: { full_name: 'acme/widgets', fork: false, permissions: { triage: true, push: true, admin: false } } };
    }
    return { ok: false as const, error: { code: 'PLATFORM_REQUEST_FAILED', message: `unexpected call: ${joined}`, retryable: false } };
  };

  const client = {
    version() { return { ok: true as const, value: '2.72.0' }; },
    json,
    text() { return { ok: true as const, value: '' }; }
  };
  return { client: client as unknown as GitHubClient, reviews, postedBodies };
}

const IDENTITY = { scope: 'TASK-20260101-000001', round: 1, commitSha: 'a'.repeat(40) };

test('reviewMarker and reviewedCommitMarker define the marker contract', () => {
  assert.equal(reviewMarker({ scope: 'TASK-20260101-000001', round: 1, commitSha: 'a' }), '<!-- review-pr:TASK-20260101-000001:r1 -->');
  assert.equal(reviewMarker({ scope: 'pr42', round: 2, commitSha: 'b' }), '<!-- review-pr:pr42:r2 -->');
  assert.equal(reviewedCommitMarker('a'.repeat(40)), `<!-- reviewed-commit: ${'a'.repeat(40)} -->`);
});

test('publishPrReview generates the marker on first publish and the body starts with it', () => {
  const root = fixture();
  try {
    const mock = mockClient();
    const result = publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'COMMENT', body: '## Findings\n- something' });
    assert.equal(result.status, 'applied');
    assert.equal(mock.postedBodies.length, 1);
    const posted = mock.postedBodies[0]!;
    assert.ok(posted.startsWith(reviewMarker(IDENTITY)), 'core should prepend the review marker');
    assert.ok(posted.includes(reviewedCommitMarker(IDENTITY.commitSha)), 'core should prepend the reviewed-commit marker');
    assert.ok(posted.includes('## Findings'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview is idempotent: replay with the same marker and commit is a no-op', () => {
  const root = fixture();
  try {
    const existingBody = `${reviewMarker(IDENTITY)}\n<!-- reviewed-commit: ${IDENTITY.commitSha} -->\n\n## Findings`;
    const mock = mockClient({ initial: [{ id: 1, commit_id: IDENTITY.commitSha, body: existingBody, html_url: 'https://x' }] });
    const result = publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'APPROVE', body: 'new body' });
    assert.equal(result.status, 'no-op');
    assert.equal(mock.postedBodies.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview fails with REVIEW_MARKER_CONFLICT when the marker targets a different commit', () => {
  const root = fixture();
  try {
    const existingBody = `${reviewMarker(IDENTITY)}\n<!-- reviewed-commit: ${'b'.repeat(40)} -->\n\n## Findings`;
    const mock = mockClient({ initial: [{ id: 1, commit_id: 'b'.repeat(40), body: existingBody, html_url: 'https://x' }] });
    const result = publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'APPROVE', body: 'new body' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'REVIEW_MARKER_CONFLICT');
    assert.equal(mock.postedBodies.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview rejects a scope that would break the marker contract', () => {
  const root = fixture();
  try {
    const mock = mockClient();
    const badScopes = ['TASK-20260101-000001\r\ninject', 'pr42-->', 'TASK 20260101 000001', ''];
    for (const scope of badScopes) {
      const result = publishPrReview({
        cwd: root, client: mock.client, prNumber: 42,
        identity: { scope, round: 1, commitSha: 'a'.repeat(40) },
        event: 'COMMENT', body: 'body'
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'REVIEW_IDENTITY_INVALID');
      assert.equal(mock.postedBodies.length, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview reconciles a lost POST by re-listing and marking CREATE_RECONCILED', () => {
  const root = fixture();
  try {
    const mock = mockClient({ failPostTimes: 1 });
    const result = publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'COMMENT', body: 'body' });
    assert.equal(result.status, 'applied');
    assert.equal(result.operations?.[0]?.reasonCode, 'CREATE_RECONCILED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview blocks when a retryable POST cannot be reconciled', () => {
  const root = fixture();
  try {
    const mock = mockClient(); // POST succeeds, so simulate unknown by never writing: use a failing version below
    // Force the POST to fail transiently without recording the review.
    const client = {
      version() { return { ok: true as const, value: '2.72.0' }; },
      json: (args: string[], request: { method?: string; input?: string } = {}) => {
        const joined = args.join(' ');
        if (joined.includes('api --paginate --slurp repos/acme/widgets/pulls/') && joined.includes('/reviews')) {
          return { ok: true as const, value: [[]] };
        }
        if (args.includes('-X') && args.includes('POST') && joined.includes('/pulls/42/reviews')) {
          return { ok: false as const, error: { code: 'NETWORK_TRANSIENT', message: 'timeout', retryable: true } };
        }
        if (args[1] === 'graphql') return { ok: true as const, value: { data: { viewer: { login: 'codex' } } } };
        if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] || '')) {
          return { ok: true as const, value: { full_name: 'acme/widgets', fork: false, permissions: { triage: true, push: true, admin: false } } };
        }
        return { ok: false as const, error: { code: 'PLATFORM_REQUEST_FAILED', message: joined, retryable: false } };
      },
      text() { return { ok: true as const, value: '' }; }
    };
    const result = publishPrReview({ cwd: root, client: client as unknown as GitHubClient, prNumber: 42, identity: IDENTITY, event: 'COMMENT', body: 'body' });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'REVIEW_CREATE_OUTCOME_UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listPrReviews returns normalized review entries', () => {
  const root = fixture();
  try {
    const mock = mockClient({ initial: [
      { id: 1, commit_id: 'a'.repeat(40), body: `${reviewMarker(IDENTITY)}\nbody`, html_url: 'https://x' },
      { id: 2, commit_id: 'b'.repeat(40), body: 'ordinary comment review', html_url: 'https://y' }
    ] });
    const result = listPrReviews(42, { cwd: root, client: mock.client });
    assert.equal(result.status, 'no-op');
    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]!.commitId, 'a'.repeat(40));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
