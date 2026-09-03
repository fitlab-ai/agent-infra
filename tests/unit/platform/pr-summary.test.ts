import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildPullRequestSummary,
  reportWrite,
  reconcileSummaryComment,
  syncPullRequestSummary,
  warningResultForPrimary
} from '../../../lib/platform/pr-summary.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';
import type { PrecheckCandidate } from '../../../lib/platform/pr-change-report.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';
import {
  buildPrChangeReport,
  readPrChangeReport,
  replaceCanonicalReportPlaceholder,
  runMechanicalChangeReport,
  taskIntentDigest,
  writePrChangeReportAtomic
} from '../../../lib/platform/pr-change-report.ts';
import { filePath } from '../../helpers.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function candidate(taskIntentSha256: string): PrecheckCandidate {
  return {
    taskIntentSha256,
    checks: ['target-alignment', 'change-composition', 'compatibility-policy', 'legacy-path-cleanup', 'redundancy', 'scope-discipline'].map((id) => ({
      id: id as PrecheckCandidate['checks'][number]['id'],
      verdict: 'pass' as const,
      evidence: [{ path: 'README.md', startLine: 1, endLine: 1, detail: 'Matches the approved task scope.' }],
      rationale: 'The complete diff is within the approved scope.'
    }))
  };
}

function summaryFixture(): { root: string; taskId: string; reportPath: string; baseSha: string; headSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-summary-'));
  const taskId = 'TASK-20260101-000042';
  git(root, ['init', '-q', '-b', 'feature']);
  git(root, ['config', 'user.name', 'Codex']);
  git(root, ['config', 'user.email', 'codex@example.com']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(root, 'README.md'), 'change\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'change']);
  const headSha = git(root, ['rev-parse', 'HEAD']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-pr', 'scripts'), { recursive: true });
  fs.copyFileSync(filePath('.agents/skills/create-pr/scripts/change-report.mjs'), path.join(root, '.agents', 'skills', 'create-pr', 'scripts', 'change-report.mjs'));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active', taskId), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}\n');
  fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', taskId, 'task.md'), [
    '---',
    `id: ${taskId}`,
    'status: active',
    `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({
      identity: {
        resource: { kind: 'number', value: 42 }, repository: 'acme/widgets', url: 'https://github.com/acme/widgets/pull/42',
        head: { repository: 'acme/widgets', ref: 'feature', sha: headSha },
        base: { repository: 'acme/widgets', ref: 'main', sha: baseSha }
      }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
    })))}`,
    'branch: feature',
    '---', '', '# Task: Canonical report', '', '## Description', '', 'Implement the canonical report.', '', '## Context', '', '- branch: feature'
  ].join('\n'));
  const taskPath = path.join(root, '.agents', 'workspace', 'active', taskId, 'task.md');
  const taskContent = fs.readFileSync(taskPath, 'utf8');
  const digest = taskIntentDigest(taskContent);
  if (!digest.ok) throw new Error(digest.error.message);
  assert.equal(digest.ok, true);
  const mechanical = runMechanicalChangeReport(root, baseSha, headSha);
  const candidateValue = candidate(digest.value.sha256);
  const report = buildPrChangeReport({
    repository: 'acme/widgets', number: 42,
    base: { repository: 'acme/widgets', ref: 'main', sha: baseSha },
    head: { repository: 'acme/widgets', ref: 'feature', sha: headSha }
  }, digest.value.sha256, mechanical, candidateValue);
  if (!report.ok) throw new Error(report.error.message);
  assert.equal(report.ok, true);
  const reportPath = path.join(root, '.agents', 'workspace', 'active', taskId, 'pr-change-report.json');
  writePrChangeReportAtomic(reportPath, report.value);
  return { root, taskId, reportPath, baseSha, headSha };
}

type ResolvedContextClientOptions = {
  onContextResolved?: () => void;
  headSequence?: string[];
  deleteCalls?: { value: number };
  commentWrites?: { value: number };
  comments?: Array<{ id: number; body: string }>;
  pullRequestFailureAt?: number;
};

function resolvedContextClient(
  root: string,
  failure: 'success' | 'head' | 'comments' | 'duplicate',
  baseSha: string,
  headSha: string,
  options: ResolvedContextClientOptions = {}
): GitHubClient {
  let repositoryCalls = 0;
  let pullRequestCalls = 0;
  return {
    version: () => ({ ok: true, value: '2.72.0' }),
    json: (args: string[]) => {
      if (args[1] === 'graphql') return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      if (args[0] === 'api' && args[1] === 'repos/acme/widgets') {
        repositoryCalls += 1;
        if (failure === 'head' && repositoryCalls === 2) fs.rmSync(path.join(root, '.git', 'HEAD'));
        if (repositoryCalls === 2) options.onContextResolved?.();
        return { ok: true, value: { full_name: 'acme/widgets', fork: false, permissions: { triage: true, push: true, admin: true } } };
      }
      if (args.some((value: string) => value.includes('/pulls/42'))) {
        const pullRequestCall = pullRequestCalls++;
        if (options.pullRequestFailureAt === pullRequestCall + 1) {
          return { ok: false, error: { code: 'PR_INSPECTION_FAILED', message: 'pull-request inspect failed', retryable: true } };
        }
        const currentHead = options.headSequence?.[Math.min(pullRequestCall, (options.headSequence?.length || 1) - 1)] || headSha;
        return { ok: true, value: {
          number: 42, node_id: 'PR_42', html_url: 'https://github.com/acme/widgets/pull/42',
          state: 'open', title: 'Canonical report', body: '', draft: false,
          head: { ref: 'feature', sha: currentHead, repo: { full_name: 'acme/widgets' } },
          base: { ref: 'main', sha: baseSha, repo: { full_name: 'acme/widgets' } },
          merged_at: null, merge_commit_sha: null
        } };
      }
      if (args.some((value: string) => value.includes('/issues/42/comments'))) {
        if (args.includes('POST') || args.includes('PATCH')) {
          if (options.commentWrites) options.commentWrites.value += 1;
          return { ok: true, value: { id: 9 } };
        }
        if (failure === 'duplicate') {
          const marker = '<!-- sync-pr:TASK-20260101-000042:summary -->';
          return { ok: true, value: [[{ id: 1, body: `${marker}\nfirst` }, { id: 2, body: `${marker}\nsecond` }]] };
        }
        return failure === 'comments'
          ? { ok: false, error: { code: 'COMMENT_LIST_FAILED', message: 'comment API failed', retryable: true } }
          : { ok: true, value: [options.comments || []] };
      }
      throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
    },
    text: (args: string[]) => {
      if (args.includes('-X') && args.includes('DELETE')) options.deleteCalls && (options.deleteCalls.value += 1);
      return { ok: true, value: '' };
    }
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

test('PR summary escapes control markers in the human override audit', () => {
  const summary = buildPullRequestSummary(
    'TASK-1',
    'Summary',
    'abc123',
    '## Human Override Audit\n\n- reason=<!-- sync-pr:TASK-1:summary -->'
  );
  assert.equal((summary.match(/<!--\s*sync-pr:/gi) || []).length, 1);
  assert.match(summary, /&lt;!-- sync-pr:TASK-1:summary --&gt;/);
});

test('PR summary warning result preserves the primary lifecycle outcome', () => {
  assert.equal(warningResultForPrimary('pr_created'), 'pr_created_with_warnings');
  assert.equal(warningResultForPrimary('pr_reused'), 'pr_reused_with_warnings');
  assert.equal(warningResultForPrimary('no_op'), 'no_op_with_warnings');
});

test('PR summary preserves the structured legacy cutoff error from a persisted fact', async () => {
  const fixture = summaryFixture();
  try {
    const legacy = JSON.stringify({ version: 1, state: 'unbound', reason: 'initial' });
    const taskPath = path.join(fixture.root, '.agents', 'workspace', 'active', fixture.taskId, 'task.md');
    fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace(/^pr_delivery_fact: .*$/m, `pr_delivery_fact: ${JSON.stringify(legacy)}`));
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: 'Summary',
      primaryResult: 'pr_created',
      runtimeVersion: 'v1.0.0'
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR summary reconciliation creates, updates, converges and rejects duplicate markers', () => {
  const desired = buildPullRequestSummary('TASK-1', 'Summary', 'abc');
  assert.deepEqual(reconcileSummaryComment([], 'TASK-1', desired), { action: 'create', commentId: null });
  assert.deepEqual(reconcileSummaryComment([{ id: 2, body: desired }], 'TASK-1', desired), { action: 'no-op', commentId: 2 });
  assert.deepEqual(reconcileSummaryComment([{ id: 2, body: 'old\n<!-- sync-pr:TASK-1:summary -->' }], 'TASK-1', desired), { action: 'update', commentId: 2 });
  assert.equal(reconcileSummaryComment([{ id: 2, body: desired }, { id: 3, body: desired }], 'TASK-1', desired).action, 'conflict');
});

test('change-report writes a task-bound sidecar and converges on replay', async () => {
  const fixture = summaryFixture();
  try {
    fs.rmSync(fixture.reportPath);
    const taskPath = path.join(fixture.root, '.agents', 'workspace', 'active', fixture.taskId, 'task.md');
    const taskContent = fs.readFileSync(taskPath, 'utf8');
    const digest = taskIntentDigest(taskContent);
    if (!digest.ok) throw new Error(digest.error.message);
    assert.equal(digest.ok, true);
    const mechanical = runMechanicalChangeReport(fixture.root, fixture.baseSha, fixture.headSha);
    const mechanicalFile = path.join(fixture.root, 'mechanical.json');
    const precheckFile = path.join(fixture.root, 'precheck.json');
    fs.writeFileSync(mechanicalFile, JSON.stringify(mechanical));
    fs.writeFileSync(precheckFile, JSON.stringify(candidate(digest.value.sha256)));

    const first = await reportWrite(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', mechanicalFile, precheckFile,
      client: resolvedContextClient(fixture.root, 'comments', fixture.baseSha, fixture.headSha)
    });
    assert.equal(first.status, 'applied');
    assert.equal(first.report?.status, 'written');
    const replay = await reportWrite(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', mechanicalFile, precheckFile,
      client: resolvedContextClient(fixture.root, 'comments', fixture.baseSha, fixture.headSha)
    });
    assert.equal(replay.status, 'no-op');
    assert.equal(replay.report?.status, 'no-op');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('change-report reads task semantics inside the execution lock', async () => {
  const fixture = summaryFixture();
  try {
    const taskPath = path.join(fixture.root, '.agents', 'workspace', 'active', fixture.taskId, 'task.md');
    const mechanicalFile = path.join(fixture.root, 'mechanical.json');
    const precheckFile = path.join(fixture.root, 'precheck.json');
    const mechanical = runMechanicalChangeReport(fixture.root, fixture.baseSha, fixture.headSha);
    fs.writeFileSync(mechanicalFile, JSON.stringify(mechanical));
    const updatedTask = fs.readFileSync(taskPath, 'utf8').replace('Implement the canonical report.', 'Implement the updated canonical report.');
    const updatedDigest = taskIntentDigest(updatedTask);
    if (!updatedDigest.ok) throw new Error(updatedDigest.error.message);
    fs.writeFileSync(precheckFile, JSON.stringify(candidate(updatedDigest.value.sha256)));
    const result = await reportWrite(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', mechanicalFile, precheckFile,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        onContextResolved: () => fs.writeFileSync(taskPath, updatedTask)
      })
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.error, null);
    const report = JSON.parse(fs.readFileSync(fixture.reportPath, 'utf8')) as { inputs: { taskIntentSha256: string } };
    assert.equal(report.inputs.taskIntentSha256, updatedDigest.value.sha256);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync renders the task-bound report and publishes one canonical comment', async () => {
  const fixture = summaryFixture();
  try {
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: `## Summary\n\n${'<!-- canonical-pr-change-report -->'}`,
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha)
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.error, null);
    assert.deepEqual(result.comment?.ids, [9]);
    assert.equal(result.precheckVerdict, 'clear');
    assert.equal(result.nextAction, 'watch-pr');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync compensates a published comment when the PR head races', async () => {
  const fixture = summaryFixture();
  const deleteCalls = { value: 0 };
  try {
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: `## Summary\n\n${'<!-- canonical-pr-change-report -->'}`,
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        headSequence: [fixture.headSha, fixture.headSha, 'd'.repeat(40)],
        deleteCalls
      })
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'PR_SUMMARY_HEAD_RACE');
    assert.equal(result.result, null);
    assert.equal(result.warnings.length, 0);
    assert.equal(deleteCalls.value, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync compensates a published comment when post-write inspection fails', async () => {
  const fixture = summaryFixture();
  const deleteCalls = { value: 0 };
  const commentWrites = { value: 0 };
  try {
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: `## Summary\n\n${'<!-- canonical-pr-change-report -->'}`,
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        pullRequestFailureAt: 3,
        deleteCalls,
        commentWrites
      })
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'PR_SUMMARY_POSTWRITE_VERIFY_FAILED');
    assert.equal(result.result, null);
    assert.equal(result.warnings.length, 0);
    assert.equal(commentWrites.value, 1);
    assert.equal(deleteCalls.value, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync rechecks the PR head before returning no-op', async () => {
  const fixture = summaryFixture();
  const commentWrites = { value: 0 };
  try {
    const report = readPrChangeReport(fixture.reportPath);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const replaced = replaceCanonicalReportPlaceholder('Summary\n<!-- canonical-pr-change-report -->', report.value);
    assert.equal(replaced.ok, true);
    if (!replaced.ok) return;
    const desired = buildPullRequestSummary(fixture.taskId, replaced.value, fixture.headSha);
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: 'Summary\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        headSequence: [fixture.headSha, 'd'.repeat(40)],
        comments: [{ id: 7, body: desired }],
        commentWrites
      })
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'PR_SUMMARY_HEAD_RACE');
    assert.equal(result.result, null);
    assert.equal(result.warnings.length, 0);
    assert.equal(commentWrites.value, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync re-reads task semantics inside the execution lock', async () => {
  const fixture = summaryFixture();
  try {
    const taskPath = path.join(fixture.root, '.agents', 'workspace', 'active', fixture.taskId, 'task.md');
    const updatedTask = fs.readFileSync(taskPath, 'utf8').replace('Implement the canonical report.', 'Implement the updated canonical report.');
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: `Summary\n${'<!-- canonical-pr-change-report -->'}`,
      changeReportFile: fixture.reportPath,
      primaryResult: 'pr_created',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        onContextResolved: () => fs.writeFileSync(taskPath, updatedTask)
      })
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.result, 'pr_created_with_warnings');
    assert.equal(result.error, null);
    assert.equal(result.warnings[0]?.code, 'PR_CHANGE_REPORT_STALE');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
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
    code: 'PR_CHANGE_REPORT_GIT_FAILED',
    messagePattern: /not a git repository/,
    client: (root: string, baseSha: string, headSha: string): GitHubClient => resolvedContextClient(root, 'head', baseSha, headSha)
  },
  {
    name: 'comment API failure',
    code: 'COMMENT_LIST_FAILED',
    messagePattern: /comment API failed/,
    client: (root: string, baseSha: string, headSha: string): GitHubClient => resolvedContextClient(root, 'comments', baseSha, headSha)
  },
  {
    name: 'duplicate summary marker',
    code: 'PR_SUMMARY_MARKER_AMBIGUOUS',
    messagePattern: /Multiple PR comments contain the summary marker/,
    client: (root: string, baseSha: string, headSha: string): GitHubClient => resolvedContextClient(root, 'duplicate', baseSha, headSha)
  }
] as const) {
  test(`PR summary ${scenario.name} preserves a known primary PR result as a warning`, async () => {
    const fixture = summaryFixture();
    try {
      const result = await syncPullRequestSummary(fixture.taskId, {
        cwd: fixture.root,
        agent: 'codex',
        body: `Summary\n${'<!-- canonical-pr-change-report -->'}`,
        changeReportFile: fixture.reportPath,
        primaryResult: 'pr_created',
      client: scenario.client(fixture.root, fixture.baseSha, fixture.headSha)
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
