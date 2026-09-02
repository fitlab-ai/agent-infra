import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildPullRequestSummary,
  reconcileSummaryComment,
  syncPullRequestSummary,
  warningResultForPrimary
} from '../../../lib/platform/pr-summary.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function summaryFixture(): { root: string; taskId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-summary-'));
  const taskId = 'TASK-20260101-000042';
  git(root, ['init', '-q', '-b', 'feature']);
  git(root, ['config', 'user.name', 'Codex']);
  git(root, ['config', 'user.email', 'codex@example.com']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active', taskId), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}\n');
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', taskId, 'task.md'), [
    '---',
    `id: ${taskId}`,
    'status: active',
    `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
      identity: {
        repository: 'acme/widgets', number: 42, nodeId: 'PR_42', url: 'https://github.com/acme/widgets/pull/42',
        head: { repository: 'acme/widgets', ref: 'feature', sha: 'a'.repeat(40) },
        base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) }
      }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
    })))}`,
    'branch: feature',
    '---',
    ''
  ].join('\n'));
  return { root, taskId };
}

function resolvedContextClient(root: string, failure: 'head' | 'comments' | 'duplicate'): GitHubClient {
  let repositoryCalls = 0;
  return {
    version: () => ({ ok: true, value: '2.72.0' }),
    json: (args: string[]) => {
      if (args[1] === 'graphql') return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      if (args[0] === 'api' && args[1] === 'repos/acme/widgets') {
        repositoryCalls += 1;
        if (failure === 'head' && repositoryCalls === 2) fs.rmSync(path.join(root, '.git', 'HEAD'));
        return { ok: true, value: { full_name: 'acme/widgets', fork: false, permissions: { triage: true, push: true, admin: true } } };
      }
      if (args.some((value: string) => value.includes('/issues/42/comments'))) {
        if (failure === 'duplicate') {
          const marker = '<!-- sync-pr:TASK-20260101-000042:summary -->';
          return { ok: true, value: [[{ id: 1, body: `${marker}\nfirst` }, { id: 2, body: `${marker}\nsecond` }]] };
        }
        return failure === 'comments'
          ? { ok: false, error: { code: 'COMMENT_LIST_FAILED', message: 'comment API failed', retryable: true } }
          : { ok: true, value: [[]] };
      }
      throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
    },
    text: () => ({ ok: true, value: '' })
  } as unknown as GitHubClient;
}

test('PR summary envelope owns marker and current HEAD', () => {
  assert.equal(buildPullRequestSummary('TASK-1', 'Summary\n', 'abc123'), [
    '<!-- sync-pr:TASK-1:summary -->',
    '<!-- last-commit: abc123 -->',
    '',
    'Summary',
    ''
  ].join('\n'));
});

test('PR summary warning result preserves the primary lifecycle outcome', () => {
  assert.equal(warningResultForPrimary('pr_created'), 'pr_created_with_warnings');
  assert.equal(warningResultForPrimary('pr_reused'), 'pr_reused_with_warnings');
  assert.equal(warningResultForPrimary('no_op'), 'no_op_with_warnings');
});

test('PR summary reconciliation creates, updates, converges and rejects duplicate markers', () => {
  const desired = buildPullRequestSummary('TASK-1', 'Summary', 'abc');
  assert.deepEqual(reconcileSummaryComment([], 'TASK-1', desired), { action: 'create', commentId: null });
  assert.deepEqual(reconcileSummaryComment([{ id: 2, body: desired }], 'TASK-1', desired), { action: 'no-op', commentId: 2 });
  assert.deepEqual(reconcileSummaryComment([{ id: 2, body: 'old\n<!-- sync-pr:TASK-1:summary -->' }], 'TASK-1', desired), { action: 'update', commentId: 2 });
  assert.equal(reconcileSummaryComment([{ id: 2, body: desired }, { id: 3, body: desired }], 'TASK-1', desired).action, 'conflict');
});

for (const scenario of [
  {
    name: 'context authentication failure',
    code: 'AUTH_REQUIRED',
    messagePattern: /authentication required/,
    client: (): GitHubClient => ({
      version: () => ({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'authentication required', retryable: false } }),
      json: () => { throw new Error('GitHub API must not be called after authentication failure'); },
      text: () => { throw new Error('GitHub API must not be called after authentication failure'); }
    } as unknown as GitHubClient)
  },
  {
    name: 'HEAD resolution failure',
    code: 'GIT_HEAD_UNRESOLVED',
    messagePattern: /not a git repository/,
    client: (root: string): GitHubClient => resolvedContextClient(root, 'head')
  },
  {
    name: 'comment API failure',
    code: 'COMMENT_LIST_FAILED',
    messagePattern: /comment API failed/,
    client: (root: string): GitHubClient => resolvedContextClient(root, 'comments')
  },
  {
    name: 'duplicate summary marker',
    code: 'PR_SUMMARY_MARKER_AMBIGUOUS',
    messagePattern: /Multiple PR comments contain the summary marker/,
    client: (root: string): GitHubClient => resolvedContextClient(root, 'duplicate')
  }
] as const) {
  test(`PR summary ${scenario.name} preserves a known primary PR result as a warning`, () => {
    const fixture = summaryFixture();
    try {
      const result = syncPullRequestSummary(fixture.taskId, {
        cwd: fixture.root,
        agent: 'codex',
        body: 'Summary',
        primaryResult: 'pr_created',
        client: scenario.client(fixture.root)
      });

      assert.equal(result.status, 'applied');
      assert.equal(result.result, 'pr_created_with_warnings');
      assert.equal(result.error, null);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0]?.code, scenario.code);
      assert.match(result.warnings[0]?.message || '', scenario.messagePattern);
      assert.equal(result.warnings[0]?.retryable, scenario.code === 'COMMENT_LIST_FAILED');
      assert.equal(result.warnings[0]?.step, 'pr-summary');
      assert.equal(result.warnings[0]?.target, 'pull-request:42');
      assert.equal(result.warnings[0]?.severity, 'ACTION_REQUIRED');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
