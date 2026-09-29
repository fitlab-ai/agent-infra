import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  listPrReviews,
  publishPrReview,
  reviewMarker,
  reviewedCommitMarker
} from '../../../../lib/platform/pr-review.ts';
import type { GitHubClient } from '../../../../lib/platform/github-client.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../../../../lib/task/platform-operation-journal.ts';
import { recoverPlatformOperations } from '../../../../lib/task/platform-operation-recovery.ts';

type MockReview = { id: number; commit_id: string; body: string; html_url: string };

function fixture(repository = 'acme/widgets') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-adapter-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${repository}.git`], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  return root;
}

function mockClient(options: {
  initial?: MockReview[];
  failPostTimes?: number;
  repository?: string;
} = {}) {
  const repository = options.repository ?? 'acme/widgets';
  const reviews: MockReview[] = [...(options.initial || [])];
  const postedBodies: string[] = [];
  const requests: string[] = [];
  let nextId = 100;
  let transientFailures = options.failPostTimes ?? 0;

  const json = (args: string[], request: { method?: string; input?: string } = {}) => {
    const joined = args.join(' ');
    requests.push(`${request.method ?? 'GET'} ${joined}`);
    if (joined.includes(`api --paginate --slurp repos/${repository}/pulls/`) && joined.includes('/reviews')) {
      return { ok: true as const, value: [reviews] };
    }
    if (args.includes('-X') && args.includes('POST') && joined.includes(`repos/${repository}/pulls/42/reviews`)) {
      const input = JSON.parse(request.input || '{}') as { commit_id?: string; body?: string; event?: string };
      postedBodies.push(input.body || '');
      if (transientFailures > 0) {
        transientFailures -= 1;
        reviews.push({ id: nextId, commit_id: input.commit_id || '', body: input.body || '', html_url: `https://github.com/${repository}/pull/42#r1` });
        nextId += 1;
        return { ok: false as const, error: { code: 'NETWORK_TRANSIENT', message: 'timeout', retryable: true } };
      }
      const created: MockReview = { id: nextId, commit_id: input.commit_id || '', body: input.body || '', html_url: `https://github.com/${repository}/pull/42#r1` };
      nextId += 1;
      reviews.push(created);
      return { ok: true as const, value: created };
    }
    if (args[1] === 'graphql') {
      return { ok: true as const, value: { data: { viewer: { login: 'codex' } } } };
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+$/.test(args[1] || '')) {
      return { ok: true as const, value: { full_name: repository, fork: false, permissions: { triage: true, push: true, admin: false } } };
    }
    return { ok: false as const, error: { code: 'PLATFORM_REQUEST_FAILED', message: `unexpected call: ${joined}`, retryable: false } };
  };

  const client = {
    version() { return { ok: true as const, value: '2.72.0' }; },
    json,
    text() { return { ok: true as const, value: '' }; }
  };
  return { client: client as unknown as GitHubClient, reviews, postedBodies, requests };
}

function writeReviewArtifact(root: string, body: string, artifact = 'pr-review.md'): string {
  const taskDir = path.join(root, '.agents', 'workspace', 'active', IDENTITY.scope);
  const file = path.join(taskDir, artifact);
  const bodyFile = artifact.replace(/^pr-review/u, 'pr-review-body');
  fs.writeFileSync(file, `# PR review\n\n**Body file**: \`${bodyFile}\`\n`);
  fs.writeFileSync(path.join(taskDir, bodyFile), `${body}\n`);
  return artifact;
}

const IDENTITY = { scope: 'TASK-20260101-000001', round: 1, commitSha: 'a'.repeat(40) };

test('reviewMarker and reviewedCommitMarker define the marker contract', () => {
  assert.equal(reviewMarker({ scope: 'TASK-20260101-000001', round: 1, commitSha: 'a' }), '<!-- review-pr:TASK-20260101-000001:r1 -->');
  assert.equal(reviewMarker({ scope: 'pr42', round: 2, commitSha: 'b' }), '<!-- review-pr:pr42:r2 -->');
  assert.match(reviewMarker({ scope: 'TASK-20260101-000001', round: 3, commitSha: 'c', resource: { kind: 'id', value: 'type:42' } }), /^<!-- review-pr:pr:[A-Za-z0-9_-]+:r3 -->$/);
  assert.equal(reviewedCommitMarker('a'.repeat(40)), `<!-- reviewed-commit: ${'a'.repeat(40)} -->`);
});

test('publishPrReview generates the marker on first publish and the body starts with it', async () => {
  const root = fixture();
  try {
    const mock = mockClient();
    const result = await publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'COMMENT', body: '## Findings\n- something', skipQueue: true });
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

test('task-scoped PR review publication is recorded by the shared platform queue', async () => {
  const root = fixture();
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const body = '## Findings\n- task-scoped review';
  const artifact = writeReviewArtifact(root, body);
  try {
    const mock = mockClient();
    const result = await publishPrReview({
      cwd: root,
      client: mock.client,
      agent: 'codex',
      prNumber: 42,
      identity: IDENTITY,
      event: 'COMMENT',
      body,
      recoveryArtifact: artifact
    });
    const operations = readPlatformOperationJournal(taskId, root).operations;

    assert.equal(result.status, 'applied');
    assert.equal(mock.postedBodies.length, 1);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.kind, 'pull-request-review');
    assert.equal(operations[0]?.state, 'succeeded');
    assert.deepEqual(operations[0]?.pullRequestReview, {
      prNumber: '42', resource: { kind: 'number', value: 42 }, providerScopeId: 'acme/widgets',
      scope: taskId, round: 1, commitSha: IDENTITY.commitSha, event: 'COMMENT',
      artifactFile: artifact,
      bodyDigest: createHash('sha256').update(body).digest('hex')
    });
    const journal = fs.readFileSync(path.join(taskDir, '.platform-operations.json'), 'utf8');
    assert.equal(journal.includes(body), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-scoped PR review publication rejects a missing report before queueing or publishing', async () => {
  const root = fixture();
  const taskId = IDENTITY.scope;
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const body = '## Findings\n- body without report';
  fs.writeFileSync(path.join(taskDir, 'pr-review-body.md'), `${body}\n`);
  try {
    const mock = mockClient();
    const result = await publishPrReview({
      cwd: root,
      client: mock.client,
      agent: 'codex',
      prNumber: 42,
      identity: IDENTITY,
      event: 'COMMENT',
      body,
      recoveryArtifact: 'pr-review.md'
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PR_REVIEW_ARTIFACT_MISMATCH');
    assert.equal(readPlatformOperationJournal(taskId, root).operations.length, 0);
    assert.deepEqual(mock.postedBodies, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-scoped PR review publication rejects a report that references another body file', async () => {
  const root = fixture();
  const taskId = IDENTITY.scope;
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const body = '## Findings\n- wrong report reference';
  const artifact = writeReviewArtifact(root, body);
  fs.writeFileSync(path.join(taskDir, artifact), '# PR review\n\n**Body file**: `pr-review-body-r2.md`\n');
  try {
    const mock = mockClient();
    const result = await publishPrReview({
      cwd: root,
      client: mock.client,
      agent: 'codex',
      prNumber: 42,
      identity: IDENTITY,
      event: 'COMMENT',
      body,
      recoveryArtifact: artifact
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PR_REVIEW_ARTIFACT_MISMATCH');
    assert.equal(readPlatformOperationJournal(taskId, root).operations.length, 0);
    assert.deepEqual(mock.postedBodies, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR review recovery recognizes an accepted review before retrying its queued write', async () => {
  const root = fixture();
  const taskId = IDENTITY.scope;
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const resource = { kind: 'number' as const, value: 42 };
  const reviewIntent = {
    prNumber: '42', resource, providerScopeId: 'acme/widgets', scope: taskId, round: IDENTITY.round,
    commitSha: IDENTITY.commitSha, event: 'COMMENT' as const,
    artifactFile: writeReviewArtifact(root, '## Findings\n- recovered'),
    bodyDigest: createHash('sha256').update('## Findings\n- recovered').digest('hex')
  };
  const marker = reviewMarker({ ...IDENTITY, resource });
  const mock = mockClient({ initial: [{
    id: 101, commit_id: IDENTITY.commitSha,
    body: `${marker}\n<!-- reviewed-commit: ${IDENTITY.commitSha} -->\n\n## Findings\n- recovered`,
    html_url: 'https://github.com/acme/widgets/pull/42#r1'
  }] });
  try {
    const operation = recordPlatformOperation({
      taskRef: taskId, cwd: root, kind: 'pull-request-review', target: JSON.stringify(resource),
      expectedDigest: createHash('sha256').update(JSON.stringify(reviewIntent)).digest('hex'),
      dependency: 'deferred', state: 'unknown', pullRequestReview: reviewIntent
    });
    const recovered = await recoverPlatformOperations(taskId, 'all', { agent: 'codex', cwd: root, client: mock.client });
    const persisted = readPlatformOperationJournal(taskId, root).operations.find((item) => item.id === operation.id);

    assert.equal(recovered.status, 'applied');
    assert.deepEqual(mock.postedBodies, []);
    assert.equal(persisted?.state, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR review recovery fails closed when its canonical body changes after queuing', async () => {
  const root = fixture();
  const taskId = IDENTITY.scope;
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const resource = { kind: 'number' as const, value: 42 };
  const body = '## Findings\n- canonical source';
  const artifact = writeReviewArtifact(root, body);
  const intent = {
    prNumber: '42', resource, providerScopeId: 'acme/widgets', scope: taskId, round: IDENTITY.round,
    commitSha: IDENTITY.commitSha, event: 'COMMENT' as const, artifactFile: artifact,
    bodyDigest: createHash('sha256').update(body).digest('hex')
  };
  const mock = mockClient();
  try {
    const operation = recordPlatformOperation({
      taskRef: taskId, cwd: root, kind: 'pull-request-review', target: JSON.stringify(resource),
      expectedDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
      dependency: 'deferred', state: 'unknown', pullRequestReview: intent
    });

    writeReviewArtifact(root, '## Findings\n- changed after queue');
    const recovered = await recoverPlatformOperations(taskId, 'all', { agent: 'codex', cwd: root, client: mock.client });
    const persisted = readPlatformOperationJournal(taskId, root).operations.find((item) => item.id === operation.id);

    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error?.code, 'PLATFORM_OPERATION_PAYLOAD_INVALID');
    assert.deepEqual(mock.requests.filter((request) => request.includes('/pulls/42/reviews')), []);
    assert.deepEqual(mock.postedBodies, []);
    assert.equal(persisted?.state, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR review recovery stops when the journal target differs from its persisted resource identity', async () => {
  const root = fixture();
  const taskId = IDENTITY.scope;
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const intentResource = { kind: 'number' as const, value: 42 };
  const reviewIntent = {
    prNumber: '42', resource: intentResource, providerScopeId: 'acme/widgets', scope: taskId, round: IDENTITY.round,
    commitSha: IDENTITY.commitSha, event: 'COMMENT' as const,
    artifactFile: writeReviewArtifact(root, '## Findings\n- identity-bound'),
    bodyDigest: createHash('sha256').update('## Findings\n- identity-bound').digest('hex')
  };
  const mock = mockClient();
  try {
    const operation = recordPlatformOperation({
      taskRef: taskId, cwd: root, kind: 'pull-request-review',
      target: JSON.stringify({ kind: 'number', value: 43 }),
      expectedDigest: createHash('sha256').update(JSON.stringify(reviewIntent)).digest('hex'),
      dependency: 'deferred', state: 'unknown', pullRequestReview: reviewIntent
    });

    const recovered = await recoverPlatformOperations(taskId, 'all', { agent: 'codex', cwd: root, client: mock.client });
    const persisted = readPlatformOperationJournal(taskId, root).operations.find((item) => item.id === operation.id);

    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error?.code, 'PLATFORM_OPERATION_IDENTITY_MISMATCH');
    assert.deepEqual(mock.postedBodies, []);
    assert.equal(persisted?.state, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR review recovery rejects the same PR identity in a different provider scope before listing or writing', async () => {
  const root = fixture('other/widgets');
  const taskId = IDENTITY.scope;
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  const resource = { kind: 'number' as const, value: 42 };
  const reviewIntent = {
    prNumber: '42', resource, providerScopeId: 'acme/widgets', scope: taskId, round: IDENTITY.round,
    commitSha: IDENTITY.commitSha, event: 'COMMENT' as const,
    artifactFile: writeReviewArtifact(root, '## Findings\n- scope-bound'),
    bodyDigest: createHash('sha256').update('## Findings\n- scope-bound').digest('hex')
  };
  const mock = mockClient({ repository: 'other/widgets' });
  try {
    const operation = recordPlatformOperation({
      taskRef: taskId, cwd: root, kind: 'pull-request-review', target: JSON.stringify(resource),
      expectedDigest: createHash('sha256').update(JSON.stringify(reviewIntent)).digest('hex'),
      dependency: 'deferred', state: 'unknown', pullRequestReview: reviewIntent
    });

    const recovered = await recoverPlatformOperations(taskId, 'all', { agent: 'codex', cwd: root, client: mock.client });
    const persisted = readPlatformOperationJournal(taskId, root).operations.find((item) => item.id === operation.id);

    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error?.code, 'PLATFORM_OPERATION_IDENTITY_MISMATCH');
    assert.deepEqual(mock.requests.filter((request) => request.includes('/pulls/42/reviews')), []);
    assert.deepEqual(mock.postedBodies, []);
    assert.equal(persisted?.state, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR review publisher rejects a resource identity changed by the current provider', async () => {
  const root = fixture();
  try {
    const mock = mockClient();
    const result = await publishPrReview({
      cwd: root,
      client: mock.client,
      prNumber: 42,
      identity: IDENTITY,
      expectedResource: { kind: 'id', value: '42' },
      event: 'COMMENT',
      body: '## Findings\n- identity-bound',
      skipQueue: true
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PLATFORM_OPERATION_IDENTITY_MISMATCH');
    assert.deepEqual(mock.postedBodies, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview is idempotent: replay with the same marker and commit is a no-op', async () => {
  const root = fixture();
  try {
    const existingBody = `${reviewMarker(IDENTITY)}\n<!-- reviewed-commit: ${IDENTITY.commitSha} -->\n\n## Findings`;
    const mock = mockClient({ initial: [{ id: 1, commit_id: IDENTITY.commitSha, body: existingBody, html_url: 'https://x' }] });
    const result = await publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'APPROVE', body: 'new body', skipQueue: true });
    assert.equal(result.status, 'no-op');
    assert.equal(mock.postedBodies.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview fails with REVIEW_MARKER_CONFLICT when the marker targets a different commit', async () => {
  const root = fixture();
  try {
    const existingBody = `${reviewMarker(IDENTITY)}\n<!-- reviewed-commit: ${'b'.repeat(40)} -->\n\n## Findings`;
    const mock = mockClient({ initial: [{ id: 1, commit_id: 'b'.repeat(40), body: existingBody, html_url: 'https://x' }] });
    const result = await publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'APPROVE', body: 'new body', skipQueue: true });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'REVIEW_MARKER_CONFLICT');
    assert.equal(mock.postedBodies.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview rejects a scope that would break the marker contract', async () => {
  const root = fixture();
  try {
    const mock = mockClient();
    const badScopes = ['TASK-20260101-000001\r\ninject', 'pr42-->', 'TASK 20260101 000001', ''];
    for (const scope of badScopes) {
      const result = await publishPrReview({
        cwd: root, client: mock.client, prNumber: 42,
        identity: { scope, round: 1, commitSha: 'a'.repeat(40) },
        event: 'COMMENT', body: 'body', skipQueue: true
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'REVIEW_IDENTITY_INVALID');
      assert.equal(mock.postedBodies.length, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview reconciles a lost POST by re-listing and marking CREATE_RECONCILED', async () => {
  const root = fixture();
  try {
    const mock = mockClient({ failPostTimes: 1 });
    const result = await publishPrReview({ cwd: root, client: mock.client, prNumber: 42, identity: IDENTITY, event: 'COMMENT', body: 'body', skipQueue: true });
    assert.equal(result.status, 'applied');
    assert.equal(result.operations?.[0]?.reasonCode, 'CREATE_RECONCILED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishPrReview blocks when a retryable POST cannot be reconciled', async () => {
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
    const result = await publishPrReview({ cwd: root, client: client as unknown as GitHubClient, prNumber: 42, identity: IDENTITY, event: 'COMMENT', body: 'body', skipQueue: true });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'REVIEW_CREATE_OUTCOME_UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listPrReviews returns normalized review entries', async () => {
  const root = fixture();
  try {
    const mock = mockClient({ initial: [
      { id: 1, commit_id: 'a'.repeat(40), body: `${reviewMarker(IDENTITY)}\nbody`, html_url: 'https://x' },
      { id: 2, commit_id: 'b'.repeat(40), body: 'ordinary comment review', html_url: 'https://y' }
    ] });
    const result = await listPrReviews(42, { cwd: root, client: mock.client });
    assert.equal(result.status, 'no-op');
    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0]!.commitId, 'a'.repeat(40));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
