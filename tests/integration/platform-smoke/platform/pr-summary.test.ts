import { taskWorkspaceProject, taskWorkspaceRoot } from '../../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildPullRequestSummary,
  reportWrite,
  summaryContext,
  syncPullRequestSummary as syncTypedPullRequestSummary,
  warningResultForPrimary,
  prepareAndRenderPrSummaryContent
} from '../../../../lib/platform/pr-summary.ts';
import type { GitHubClient } from '../../../../lib/platform/github-client.ts';
import type { MechanicalChangeReport, PrecheckCandidate } from '../../../../lib/platform/pr-change-report.ts';
import { parsePrSummaryContent, renderPrSummaryContent } from '../../../../lib/platform/pr-summary-content.ts';

function summaryPayload(body: string): string {
  let manualState = 'not-required';
  if (/Manual Validation Pending|人工验证待收尾/u.test(body)) manualState = 'pending';
  if (/Manual Validation Passed|人工验证已通过/u.test(body)) manualState = 'passed';
  return JSON.stringify({
    overview: body.replace(/<!--\s*canonical-pr-change-report\s*-->/gu, '').replace(/###\s+(?:⏳\s+人工验证待收尾|✅\s+人工验证已通过).*$/su, '').trim() || 'Summary fixture.',
    tests: { state: 'not-started', detail: 'CI has not started in this fixture.' },
    review: { state: 'not-observed', detail: 'Remote reviews were not observed in this fixture.' },
    manualValidation: { state: manualState, detail: 'Manual validation fixture state.' },
    humanDecisions: { open: 0, resolved: 0, detail: 'No task decisions in this fixture.' },
    risks: 'No additional risks in this fixture.'
  });
}

async function syncPullRequestSummary(taskRef: string, options: Parameters<typeof syncTypedPullRequestSummary>[1]) {
  const body = options.body.startsWith('{') ? options.body : summaryPayload(options.body);
  return syncTypedPullRequestSummary(taskRef, { ...options, body });
}
import { buildBoundFact, encodePrDeliveryFact } from '../../../../lib/task/pr-delivery-fact.ts';
import { createManualValidationReceipt, manualValidationFinalSummaryDigest, writeManualValidationReceiptAtomic } from '../../../../lib/task/manual-validation-receipt.ts';
import { createManualValidationTransaction, summaryPreimageDigest, transitionManualValidationTransaction, writeManualValidationTransactionAtomic } from '../../../../lib/task/manual-validation-transaction.ts';
import {
  buildPrChangeReport,
  readPrChangeReport,
  replaceCanonicalReportPlaceholder,
  runMechanicalChangeReport,
  taskIntentDigest,
  writePrChangeReportAtomic
} from '../../../../lib/platform/pr-change-report.ts';
import { createTempDir, filePath } from '../../../helpers.ts';
import { recoverPlatformOperations } from '../../../../lib/task/platform-operation-recovery.ts';
import { readPlatformOperationJournal, recordPlatformOperation } from '../../../../lib/task/platform-operation-journal.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function candidate(taskIntentSha256: string, diff: MechanicalChangeReport): PrecheckCandidate {
  return {
    taskIntentSha256,
    checks: ['target-alignment', 'change-composition', 'compatibility-policy', 'legacy-path-cleanup', 'redundancy', 'scope-discipline'].map((id) => ({
      id: id as PrecheckCandidate['checks'][number]['id'],
      verdict: 'pass' as const,
      evidence: [{ path: 'README.md', startLine: 1, endLine: 1, detail: 'Matches the approved task scope.' }],
      rationale: 'The complete diff is within the approved scope.',
      ...(id === 'change-composition' ? { groups: [{
        id: 'canonical-summary', target: 'Preserve the full summary contract', behaviorChange: 'Render typed summary content with the canonical report.',
        necessity: 'Ensure refreshed summaries retain required sections.', files: diff.files.map((file) => file.oldPath ?? file.newPath!),
        tests: { coverage: 'PR summary unit and integration fixtures.', cost: 'One fixture reused across report generation.' }
      }] } : {})
    }))
  };
}

function summaryFixture(): { root: string; taskId: string; reportPath: string; baseSha: string; headSha: string } {
  const root = createTempDir('pr-summary-');
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
  fs.mkdirSync(path.join(taskWorkspaceRoot(root),  'active', taskId), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), platform: { type: 'github' } }) + '\n');
  fs.writeFileSync(path.join(taskWorkspaceRoot(root),  'active', taskId, 'task.md'), [
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
  const taskPath = path.join(taskWorkspaceRoot(root),  'active', taskId, 'task.md');
  const taskContent = fs.readFileSync(taskPath, 'utf8');
  const digest = taskIntentDigest(taskContent);
  if (!digest.ok) throw new Error(digest.error.message);
  assert.equal(digest.ok, true);
  const mechanical = runMechanicalChangeReport(root, baseSha, headSha);
  const candidateValue = candidate(digest.value.sha256, mechanical);
  const report = buildPrChangeReport({
    repository: 'acme/widgets', resource: { kind: 'number', value: 42 },
    base: { repository: 'acme/widgets', ref: 'main', sha: baseSha },
    head: { repository: 'acme/widgets', ref: 'feature', sha: headSha }
  }, digest.value.sha256, mechanical, candidateValue);
  if (!report.ok) throw new Error(report.error.message);
  assert.equal(report.ok, true);
  const reportPath = path.join(taskWorkspaceRoot(root),  'active', taskId, 'pr-change-report.json');
  writePrChangeReportAtomic(reportPath, report.value);
  return { root, taskId, reportPath, baseSha, headSha };
}

function configureOpaquePullRequest(fixture: ReturnType<typeof summaryFixture>, number?: number, extraConfig: Record<string, unknown> = {}): string {
  const taskDir = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId);
  const taskPath = path.join(taskDir, 'task.md');
  const taskContent = fs.readFileSync(taskPath, 'utf8');
  const fact = encodePrDeliveryFact(buildBoundFact({
    identity: {
      resource: { kind: 'id', value: 'pr-42' }, repository: 'opaque/project', url: 'https://opaque.example/changes/pr-42',
      head: { repository: 'opaque/project', ref: 'feature', sha: fixture.headSha },
      base: { repository: 'opaque/project', ref: 'main', sha: fixture.baseSha }
    }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
  }));
  fs.writeFileSync(taskPath, taskContent.replace(/^pr_delivery_fact: .*$/m, `pr_delivery_fact: ${JSON.stringify(fact)}`));
  const providerSource = path.resolve('tests/fixtures/platform-providers/opaque-identity-provider.mjs');
  fs.writeFileSync(path.join(fixture.root, '.agents', '.airc.json'), JSON.stringify({
    project: taskWorkspaceProject(fixture.root),
    platform: { type: 'trae', providers: { trae: { source: providerSource, config: {
      repository: 'opaque/project', headSha: fixture.headSha, baseSha: fixture.baseSha,
      ...(number === undefined ? {} : { number }),
      ...extraConfig
    } } } }
  }));
  const updatedTask = fs.readFileSync(taskPath, 'utf8');
  const digest = taskIntentDigest(updatedTask);
  if (!digest.ok) throw new Error(digest.error.message);
  const mechanical = runMechanicalChangeReport(fixture.root, fixture.baseSha, fixture.headSha);
  const report = buildPrChangeReport({
    repository: 'opaque/project', resource: { kind: 'id', value: 'pr-42' },
    base: { repository: 'opaque/project', ref: 'main', sha: fixture.baseSha },
    head: { repository: 'opaque/project', ref: 'feature', sha: fixture.headSha }
  }, digest.value.sha256, mechanical, candidate(digest.value.sha256, mechanical));
  if (!report.ok) throw new Error(report.error.message);
  writePrChangeReportAtomic(fixture.reportPath, report.value);
  return taskDir;
}

function queueOpaqueSummary(
  fixture: ReturnType<typeof summaryFixture>,
  body: string,
  manualValidation?: { phase: 'pending' | 'final'; transactionId: string }
) {
  const report = readPrChangeReport(fixture.reportPath);
  if (!report.ok) throw new Error(report.error.message);
  const rendered = replaceCanonicalReportPlaceholder(renderPrSummaryContent(parsePrSummaryContent(JSON.parse(summaryPayload(body)))), report.value);
  if (!rendered.ok) throw new Error(rendered.error.message);
  const desired = buildPullRequestSummary(fixture.taskId, rendered.value, fixture.headSha);
  const persistedBody = summaryPayload(body);
  return recordPlatformOperation({
    taskRef: fixture.taskId, cwd: fixture.root, kind: 'pull-request-summary',
    target: JSON.stringify({ kind: 'id', value: 'pr-42' }),
    expectedDigest: createHash('sha256').update(desired).digest('hex'), dependency: 'deferred', state: 'queued',
    pullRequestSummary: {
      body: persistedBody, changeReportFile: fixture.reportPath,
      ...(manualValidation ? { manualValidation } : {})
    },
    managedSummary: { requestDigest: createHash('sha256').update(JSON.stringify({ body: persistedBody, changeReportFile: fixture.reportPath, manualValidation: manualValidation ?? null })).digest('hex') }
  });
}

function freezeFinalSummaryRecovery(
  fixture: ReturnType<typeof summaryFixture>,
  phase: 'receipt-committed' | 'final-promotion-in-progress' = 'final-promotion-in-progress'
) {
  const transactionId = 'mv-frozen-final-noop';
  const evidenceDigest = 'c'.repeat(64);
  const typed = JSON.parse(summaryPayload('### ✅ Manual Validation Passed\n\nFinal validation summary.'));
  typed.manualValidation = { state: 'passed', detail: 'Final validation summary.' };
  const report = readPrChangeReport(fixture.reportPath);
  if (!report.ok) throw new Error(report.error.message);
  const rendered = replaceCanonicalReportPlaceholder(renderPrSummaryContent(parsePrSummaryContent(typed)), report.value);
  if (!rendered.ok) throw new Error(rendered.error.message);
  let body = buildPullRequestSummary(fixture.taskId, rendered.value, fixture.headSha);
  const transaction = createManualValidationTransaction({
    transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest,
    summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') }, pendingSummaryDigest: 'b'.repeat(64),
    finalSummaryDigest: manualValidationFinalSummaryDigest(body), artifact: 'manual-validation.md', attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  });
  const receipt = createManualValidationReceipt({
    transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest,
    artifact: 'manual-validation.md', artifactSha256: 'd'.repeat(64), pendingSummaryDigest: transaction.pendingSummaryDigest,
    finalSummaryDigest: transaction.finalSummaryDigest, committedAt: '2026-01-01T00:00:00.000Z'
  });
  const staged = transitionManualValidationTransaction(transaction, 'summary-staged');
  if (!staged.ok) throw new Error(staged.error.message);
  const committed = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
  if (!committed.ok) throw new Error(committed.error.message);
  const selected = phase === 'receipt-committed'
    ? committed
    : transitionManualValidationTransaction(committed.value, 'final-promotion-in-progress', { eventAppended: true });
  if (!selected.ok) throw new Error(selected.error.message);
  const artifactDir = path.join(taskWorkspaceRoot(fixture.root), 'active', fixture.taskId);
  writeManualValidationReceiptAtomic(artifactDir, receipt);
  writeManualValidationTransactionAtomic(artifactDir, selected.value);
  body = body.replace('[[manual-validation-receipt]]', `<!-- manual-validation-receipt: transaction=${transactionId}; receipt=${receipt.receiptDigest}; evidence=${evidenceDigest}; head=${fixture.headSha} -->`);

  const marker = `<!-- sync-pr:${fixture.taskId}:summary -->`;
  const execution = {
    parentKind: 'pull-request' as const, parent: { kind: 'number' as const, value: 42 }, marker,
    body, bodyDigest: createHash('sha256').update(body).digest('hex'), action: 'update' as const, phase: 'written' as const,
    preimage: { kind: 'comment' as const, id: '9', body, bodyDigest: createHash('sha256').update(body).digest('hex') },
    fence: { headSha: fixture.headSha, manualValidation: { phase: 'final' as const, transactionId, receiptDigest: receipt.receiptDigest, prHeadSha: fixture.headSha, authority: 'coordinator' as const } },
    position: 'none' as const, idempotencyKey: 'frozen-final-noop:update', remoteId: '9'
  };
  const requestBody = JSON.stringify(typed);
  const operation = recordPlatformOperation({
    taskRef: fixture.taskId, cwd: fixture.root, kind: 'pull-request-summary',
    target: JSON.stringify({ kind: 'number', value: 42 }), expectedDigest: createHash('sha256').update(requestBody).digest('hex'),
    dependency: 'deferred', state: 'unknown', pullRequestSummary: {
      body: requestBody, changeReportFile: fixture.reportPath,
      manualValidation: { phase: 'final', transactionId, receiptDigest: receipt.receiptDigest, prHeadSha: fixture.headSha, authority: 'coordinator' }
    }, managedSummary: { requestDigest: createHash('sha256').update(requestBody).digest('hex'), execution }
  });
  return { body, operation };
}

type ResolvedContextClientOptions = {
  onContextResolved?: () => void;
  headSequence?: string[];
  deleteCalls?: { value: number };
  commentWrites?: { value: number };
  onCommentWrite?: () => void;
  comments?: Array<{ id: number; body: string }>;
  writtenBodies?: string[];
  pullRequestFailureAt?: number;
  deleteFailure?: boolean;
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
  const remoteComments = [...(options.comments || [])];
  return {
    version: () => ({ ok: true, value: '2.72.0' }),
    json: (args: string[], request?: { input?: string }) => {
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
          options.onCommentWrite?.();
          const body = request?.input ? JSON.parse(request.input).body as string : '';
          if (options.writtenBodies && request?.input) options.writtenBodies.push(body);
          const current = remoteComments.find((comment) => comment.body.includes(`<!-- sync-pr:TASK-20260101-000042:summary -->`));
          if (current) current.body = body;
          else remoteComments.push({ id: 9, body });
          return { ok: true, value: { id: 9 } };
        }
        if (failure === 'duplicate') {
          const marker = '<!-- sync-pr:TASK-20260101-000042:summary -->';
          return { ok: true, value: [[{ id: 1, body: `${marker}\nfirst` }, { id: 2, body: `${marker}\nsecond` }]] };
        }
        return failure === 'comments'
          ? { ok: false, error: { code: 'COMMENT_LIST_FAILED', message: 'comment API failed', retryable: true } }
          : { ok: true, value: [remoteComments] };
      }
      throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
    },
    text: (args: string[]) => {
      if (args.includes('-X') && args.includes('DELETE')) {
        if (options.deleteCalls) options.deleteCalls.value += 1;
        if (options.deleteFailure) return { ok: false, error: { code: 'COMMENT_DELETE_FAILED', message: 'comment delete failed' } };
        const commentId = /\/comments\/(\d+)$/u.exec(args[1] ?? '')?.[1];
        const index = remoteComments.findIndex((comment) => String(comment.id) === commentId);
        if (index >= 0) remoteComments.splice(index, 1);
      }
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

test('queued PR summary recovery replays the desired summary through the configured client', async () => {
  const fixture = summaryFixture();
  const commentWrites = { value: 0 };
  let operationId: string | null = null;
  try {
    const body = summaryPayload('## Summary');
    const report = readPrChangeReport(fixture.reportPath);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const rendered = replaceCanonicalReportPlaceholder(renderPrSummaryContent(parsePrSummaryContent(JSON.parse(body))), report.value);
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    const desired = buildPullRequestSummary(fixture.taskId, rendered.value, fixture.headSha);
    const operation = recordPlatformOperation({
      taskRef: fixture.taskId,
      cwd: fixture.root,
      kind: 'pull-request-summary',
      target: JSON.stringify({ kind: 'number', value: 42 }),
      expectedDigest: createHash('sha256').update(desired).digest('hex'),
      dependency: 'deferred',
      state: 'queued',
      pullRequestSummary: { body, changeReportFile: fixture.reportPath },
      managedSummary: { requestDigest: createHash('sha256').update(JSON.stringify({ body, changeReportFile: fixture.reportPath, manualValidation: null })).digest('hex') }
    });
    operationId = operation.id;
    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, { commentWrites, onCommentWrite: () => {
        const current = readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operationId);
        assert.equal(current?.state, 'pending');
        assert.ok(current?.managedSummary?.execution);
      } })
    });
    const persisted = readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id);

    assert.equal(recovered.status, 'applied');
    assert.equal(commentWrites.value, 1);
    assert.equal(persisted?.state, 'succeeded');
    assert.equal(persisted?.id, operation.id);
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR summary persists corrected typed content for unknown-operation recovery', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    const taskPath = path.join(taskWorkspaceRoot(fixture.root), 'active', fixture.taskId, 'task.md');
    fs.appendFileSync(taskPath, [
      '', '## Review Disagreement Ledger', '',
      '| id | stage | round | severity | status | evidence |',
      '|----|-------|-------|----------|--------|----------|', ''
    ].join('\n'));
    configureOpaquePullRequest(fixture, 42, { callsPath });
    const { humanDecisions: _omitted, ...incomplete } = JSON.parse(summaryPayload('Summary with omitted ledger counts.')) as Record<string, unknown>;
    const first = await syncTypedPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body: JSON.stringify(incomplete),
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true
    });
    assert.equal(first.status, 'applied', JSON.stringify(first));

    const journalPath = path.join(taskWorkspaceRoot(fixture.root), 'active', fixture.taskId, '.platform-operations.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { operations: Array<Record<string, unknown> & { pullRequestSummary: { body: string }; managedSummary: { execution: { body: string; bodyDigest: string } } }> };
    const operation = journal.operations.at(-1)!;
    const frozen = operation.managedSummary.execution;
    assert.match(frozen.body, /Task decision ledger: 0 open, 0 resolved\./u);
    assert.equal(frozen.bodyDigest, createHash('sha256').update(frozen.body).digest('hex'));
    const taskContentBefore = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(taskPath, `${taskContentBefore}\n| HD-1 | code | 1 | decision | needs-human-decision | code-r1.md#HD-1 |\n`);
    operation.pullRequestSummary.body = JSON.stringify({ changed: 'source after freeze' });
    operation.state = 'unknown';
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root
    });
    const after = readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id);
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(after?.state, 'succeeded');
    assert.equal(after?.id, operation.id);
    assert.equal(after?.managedSummary?.execution?.body, frozen.body);
    assert.equal(after?.managedSummary?.execution?.bodyDigest, frozen.bodyDigest);
    assert.equal(fs.readFileSync(callsPath, 'utf8').split('\n').filter((call) => call === 'write').length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('terminal managed summary failure is not replayed ahead of a queued operation', async () => {
  const fixture = summaryFixture();
  const firstClient = resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha);
  try {
    const first = await syncTypedPullRequestSummary(fixture.taskId, {
      agent: 'codex', cwd: fixture.root, body: summaryPayload('terminal original'),
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true, client: firstClient
    });
    assert.equal(first.status, 'applied', JSON.stringify(first));
    const journalPath = path.join(taskWorkspaceRoot(fixture.root), 'active', fixture.taskId, '.platform-operations.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { operations: Array<Record<string, unknown> & { id: string; state: string; lastCode: string | null }> };
    const terminal = journal.operations[0]!;
    terminal.state = 'failed';
    terminal.lastCode = 'POSTWRITE_CHECK_FAILED';
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const queued = recordPlatformOperation({
      taskRef: fixture.taskId, cwd: fixture.root, kind: 'artifact-comment', target: 'later.md',
      expectedDigest: 'b'.repeat(64), state: 'queued', dependency: 'deferred'
    });
    const writes = { value: 0 };
    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root, limit: 1,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, { commentWrites: writes })
    });
    const records = readPlatformOperationJournal(fixture.taskId, fixture.root).operations;
    assert.equal(recovered.status, 'blocked');
    assert.equal(writes.value, 0);
    assert.equal(records.find((item) => item.id === terminal.id)?.state, 'failed');
    assert.notEqual(records.find((item) => item.id === queued.id)?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('queued ordinary manual-validation pending summary replays without a coordinator transaction', async () => {
  const fixture = summaryFixture();
  const commentWrites = { value: 0 };
  try {
    const content = JSON.parse(summaryPayload('Summary'));
    content.manualValidation = { state: 'pending', detail: 'Manual validation has not run yet.' };
    const body = JSON.stringify(content);
    const report = readPrChangeReport(fixture.reportPath);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const rendered = replaceCanonicalReportPlaceholder(renderPrSummaryContent(parsePrSummaryContent(JSON.parse(body))), report.value);
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    const desired = buildPullRequestSummary(fixture.taskId, rendered.value, fixture.headSha);
    const operation = recordPlatformOperation({
      taskRef: fixture.taskId, cwd: fixture.root, kind: 'pull-request-summary',
      target: JSON.stringify({ kind: 'number', value: 42 }),
      expectedDigest: createHash('sha256').update(desired).digest('hex'), dependency: 'deferred', state: 'queued',
      pullRequestSummary: { body, changeReportFile: fixture.reportPath },
      managedSummary: { requestDigest: createHash('sha256').update(JSON.stringify({ body, changeReportFile: fixture.reportPath, manualValidation: null })).digest('hex') }
    });

    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, { commentWrites })
    });
    const persisted = readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id);
    assert.equal(recovered.status, 'applied');
    assert.equal(commentWrites.value, 1);
    assert.equal(persisted?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR summary warning result preserves the primary lifecycle outcome', () => {
  assert.equal(warningResultForPrimary('pr_created'), 'pr_created_with_warnings');
  assert.equal(warningResultForPrimary('pr_reused'), 'pr_reused_with_warnings');
  assert.equal(warningResultForPrimary('no_op'), 'no_op_with_warnings');
});

test('PR summary fills missing decision counts from the current task ledger', () => {
  const { humanDecisions: _omitted, ...withoutDecisions } = JSON.parse(summaryPayload('Summary.')) as Record<string, unknown>;
  const taskContent = [
    '## 审查分歧账本', '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|',
    '| HD-1 | code | - | decision | needs-human-decision | code-r2.md#HD-1 |',
    '| HD-2 | code | - | decision | human-decided | task.md#HD-2 |'
  ].join('\n');
  const prepared = prepareAndRenderPrSummaryContent(withoutDecisions, taskContent);
  assert.deepEqual(prepared.content.humanDecisions, { open: 1, resolved: 1, detail: 'Task decision ledger: 1 open, 1 resolved.' });
});

test('invalid typed summary preserves primary-result warning routing unless strict', async () => {
  const fixture = summaryFixture();
  try {
    const body = JSON.stringify({ overview: 'Missing required summary fields.' });
    const normal = await syncTypedPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body, primaryResult: 'pr_created',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha)
    });
    assert.equal(normal.status, 'applied', JSON.stringify(normal));
    assert.equal(normal.result, 'pr_created_with_warnings');
    assert.equal(normal.warnings[0]?.code, 'PR_SUMMARY_CONTENT_INVALID');
    assert.equal(normal.warnings[0]?.target, 'pull-request:42');

    const strict = await syncTypedPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body, primaryResult: 'pr_created', strict: true,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha)
    });
    assert.equal(strict.status, 'failed');
    assert.equal(strict.result, null);
    assert.equal(strict.warnings.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('PR summary preserves the structured v1 unsupported error from a persisted fact', async () => {
  const fixture = summaryFixture();
  try {
    const legacy = JSON.stringify({ version: 1, state: 'unbound', reason: 'initial' });
    const taskPath = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'task.md');
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

test('PR summary passes an opaque bound identity through context and summary validation', async () => {
  const fixture = summaryFixture();
  try {
    const taskPath = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'task.md');
    const opaqueFact = encodePrDeliveryFact(buildBoundFact({
      identity: {
        resource: { kind: 'id', value: 'pr-42' }, repository: 'opaque/project', url: 'https://opaque.example/changes/pr-42',
        head: { repository: 'opaque/project', ref: 'feature', sha: fixture.headSha },
        base: { repository: 'opaque/project', ref: 'main', sha: fixture.baseSha }
      }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
    }));
    fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace(/^pr_delivery_fact: .*$/m, `pr_delivery_fact: ${JSON.stringify(opaqueFact)}`));
    const providerSource = path.resolve('tests/fixtures/platform-providers/opaque-identity-provider.mjs');
    fs.writeFileSync(path.join(fixture.root, '.agents', '.airc.json'), JSON.stringify({
      project: taskWorkspaceProject(fixture.root),
      platform: { type: 'trae', providers: { trae: { source: providerSource, config: { number: 42 } } } }
    }));

    const context = await summaryContext(fixture.taskId, { cwd: fixture.root });
    assert.deepEqual(context.pullRequest?.identity, { kind: 'id', value: 'pr-42' });
    assert.equal(context.task.prNumber, 42);

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: `Summary\n<!-- canonical-pr-change-report -->`,
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      strict: true
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PR_CHANGE_REPORT_STALE');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary context does not adopt a display number from a mismatched provider identity', async () => {
  const fixture = summaryFixture();
  try {
    configureOpaquePullRequest(fixture, 99, { identityValue: 'pr-other' });

    const context = await summaryContext(fixture.taskId, { cwd: fixture.root });

    assert.equal(context.task.prNumber, null);
    assert.equal(context.pullRequest, null);
    assert.equal(context.changeReport.status, 'stale');
    assert.match(context.changeReport.reason ?? '', /No bound pull request snapshot/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary uses the opaque PR snapshot number and checks its transaction', async () => {
  const fixture = summaryFixture();
  try {
    const taskDir = configureOpaquePullRequest(fixture, 42);
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-number';
    const transaction = createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });
    writeManualValidationTransactionAtomic(taskDir, transaction);

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      strict: true,
      manualValidation: { phase: 'pending', transactionId }
    });

    assert.equal(result.status, 'applied');
    assert.equal(result.resource.number, 42);
    assert.equal(result.error, null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary fails closed when the provider omits PR identity', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    const taskDir = configureOpaquePullRequest(fixture, 42, { callsPath, omitIdentity: true });
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-missing-identity';
    writeManualValidationTransactionAtomic(taskDir, createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }));

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true,
      manualValidation: { phase: 'pending', transactionId }
    });

    assert.equal(result.status, 'failed');
    assert.equal(fs.existsSync(callsPath) && fs.readFileSync(callsPath, 'utf8').includes('write'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary fails closed when its transaction number differs from the PR snapshot', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    const taskDir = configureOpaquePullRequest(fixture, 42, { callsPath });
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-mismatch';
    const transaction = createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 43, prHeadSha: fixture.headSha, evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });
    writeManualValidationTransactionAtomic(taskDir, transaction);

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      strict: true,
      manualValidation: { phase: 'pending', transactionId }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH');
    assert.equal(fs.existsSync(callsPath) && fs.readFileSync(callsPath, 'utf8').includes('write'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary rejects a transaction bound to a different PR head', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    const taskDir = configureOpaquePullRequest(fixture, 42, { callsPath });
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-head-mismatch';
    writeManualValidationTransactionAtomic(taskDir, createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: 'f'.repeat(40), evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }));

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true,
      manualValidation: { phase: 'pending', transactionId }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH');
    assert.equal(fs.existsSync(callsPath) && fs.readFileSync(callsPath, 'utf8').includes('write'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary requires a positive number from an opaque PR snapshot', async () => {
  const fixture = summaryFixture();
  try {
    const taskDir = configureOpaquePullRequest(fixture);
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-missing-number';
    writeManualValidationTransactionAtomic(taskDir, createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }));

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      strict: true,
      manualValidation: { phase: 'pending', transactionId }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MANUAL_VALIDATION_PR_NUMBER_REQUIRED');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary rejects an invalid opaque PR snapshot number', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    const taskDir = configureOpaquePullRequest(fixture, 0, { callsPath });
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-invalid-number';
    writeManualValidationTransactionAtomic(taskDir, createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }));

    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true,
      manualValidation: { phase: 'pending', transactionId }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
    assert.equal(fs.existsSync(callsPath) && fs.readFileSync(callsPath, 'utf8').includes('write'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual-validation pending summary requires its transaction ID before any comment write', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    configureOpaquePullRequest(fixture, 42, { callsPath });
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body: '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true,
      manualValidation: { phase: 'pending' }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MANUAL_VALIDATION_TRANSACTION_REQUIRED');
    assert.equal(fs.existsSync(callsPath) && fs.readFileSync(callsPath, 'utf8').includes('write'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('queued manual-validation summary recovery rechecks the persisted transaction identity', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    const taskDir = configureOpaquePullRequest(fixture, 42, { callsPath });
    fs.writeFileSync(path.join(taskDir, 'manual-validation.md'), '# Manual Validation\n');
    const transactionId = 'mv-opaque-queued-mismatch';
    writeManualValidationTransactionAtomic(taskDir, createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 43, prHeadSha: fixture.headSha, evidenceDigest: 'a'.repeat(64),
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
      pendingSummaryDigest: 'b'.repeat(64), finalSummaryDigest: 'c'.repeat(64), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    }));
    const body = '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->';
    const report = readPrChangeReport(fixture.reportPath);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const rendered = replaceCanonicalReportPlaceholder(body, report.value);
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    const configPath = path.join(fixture.root, '.agents', '.airc.json');
    const platformConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { platform: { providers: { trae: { config: Record<string, unknown> } } } };
    platformConfig.platform.providers.trae.config.initialSummaryBody = buildPullRequestSummary(fixture.taskId, rendered.value, fixture.headSha);
    fs.writeFileSync(configPath, JSON.stringify(platformConfig));
    const operation = queueOpaqueSummary(fixture, body, { phase: 'pending', transactionId });
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id)?.state, 'queued');
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.filter((item) => ['queued', 'pending', 'unknown'].includes(item.state))[0]?.id, operation.id);

    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', { agent: 'codex', cwd: fixture.root });

    assert.equal(recovered.status, 'blocked', `${JSON.stringify(recovered)} calls=${fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : ''}`);
    assert.equal(recovered.error?.code, 'MANUAL_VALIDATION_TRANSACTION_IDENTITY_MISMATCH', `${JSON.stringify(recovered)} calls=${fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : ''}`);
    assert.equal(fs.existsSync(callsPath) && fs.readFileSync(callsPath, 'utf8').includes('write'), false);
    assert.notEqual(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id)?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('queued ordinary manual-validation pending summary without transaction context replays', async () => {
  const fixture = summaryFixture();
  const callsPath = path.join(fixture.root, 'provider-calls.log');
  try {
    configureOpaquePullRequest(fixture, 42, { callsPath });
    const body = '### ⏳ Manual Validation Pending\n\n<!-- canonical-pr-change-report -->';
    const operation = queueOpaqueSummary(fixture, body);

    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', { agent: 'codex', cwd: fixture.root });

    assert.equal(recovered.status, 'applied');
    assert.equal(fs.existsSync(callsPath), true);
    assert.equal(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id)?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('change-report writes a task-bound sidecar and converges on replay', async () => {
  const fixture = summaryFixture();
  try {
    fs.rmSync(fixture.reportPath);
    const taskPath = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'task.md');
    const taskContent = fs.readFileSync(taskPath, 'utf8');
    const digest = taskIntentDigest(taskContent);
    if (!digest.ok) throw new Error(digest.error.message);
    assert.equal(digest.ok, true);
    const mechanical = runMechanicalChangeReport(fixture.root, fixture.baseSha, fixture.headSha);
    const mechanicalFile = path.join(fixture.root, 'mechanical.json');
    const precheckFile = path.join(fixture.root, 'precheck.json');
    fs.writeFileSync(mechanicalFile, JSON.stringify(mechanical));
    fs.writeFileSync(precheckFile, JSON.stringify(candidate(digest.value.sha256, mechanical)));

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

test('change-report reads task semantics after provider context resolution', async () => {
  const fixture = summaryFixture();
  try {
    const taskPath = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'task.md');
    const mechanicalFile = path.join(fixture.root, 'mechanical.json');
    const precheckFile = path.join(fixture.root, 'precheck.json');
    const mechanical = runMechanicalChangeReport(fixture.root, fixture.baseSha, fixture.headSha);
    fs.writeFileSync(mechanicalFile, JSON.stringify(mechanical));
    const updatedTask = fs.readFileSync(taskPath, 'utf8').replace('Implement the canonical report.', 'Implement the updated canonical report.');
    const updatedDigest = taskIntentDigest(updatedTask);
    if (!updatedDigest.ok) throw new Error(updatedDigest.error.message);
    fs.writeFileSync(precheckFile, JSON.stringify(candidate(updatedDigest.value.sha256, mechanical)));
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

test('summary-sync rejects a direct final manual-validation writer without coordinator authority', async () => {
  const fixture = summaryFixture();
  try {
    const artifact = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'manual-validation.md');
    fs.writeFileSync(artifact, '# Manual Validation\n');
    const evidenceDigest = 'a'.repeat(64);
    const transactionId = 'mv-direct-final';
    const placeholderBody = `### ✅ Manual Validation Passed\n\n<!-- manual-validation-receipt: transaction=${transactionId}; receipt=<receipt>; evidence=${evidenceDigest}; head=${fixture.headSha} -->\n\nManual validation passed.\n`;
    const transaction = createManualValidationTransaction({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest,
      summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') }, pendingSummaryDigest: 'a'.repeat(64),
      finalSummaryDigest: manualValidationFinalSummaryDigest(placeholderBody), artifact: 'manual-validation.md', attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const staged = transitionManualValidationTransaction(transaction, 'summary-staged');
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    const receipt = createManualValidationReceipt({
      transactionId, taskId: fixture.taskId, prNumber: 42, prHeadSha: fixture.headSha, evidenceDigest,
      artifact: 'manual-validation.md', artifactSha256: 'b'.repeat(64), pendingSummaryDigest: transaction.pendingSummaryDigest,
      finalSummaryDigest: transaction.finalSummaryDigest, committedAt: '2026-01-01T00:00:00.000Z'
    });
    const receiptCommitted = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
    assert.equal(receiptCommitted.ok, true);
    if (!receiptCommitted.ok) return;
    const finalReady = transitionManualValidationTransaction(receiptCommitted.value, 'final-promotion-in-progress', { eventAppended: true });
    assert.equal(finalReady.ok, true);
    if (!finalReady.ok) return;
    writeManualValidationReceiptAtomic(path.dirname(artifact), receipt);
    writeManualValidationTransactionAtomic(path.dirname(artifact), finalReady.value);
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root, agent: 'codex', body: placeholderBody.replace('<receipt>', receipt.receiptDigest),
      changeReportFile: fixture.reportPath, primaryResult: 'no_op', strict: true,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha),
      manualValidation: { phase: 'final', transactionId, receiptDigest: receipt.receiptDigest, prHeadSha: fixture.headSha }
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'MANUAL_VALIDATION_TRANSACTION_REQUIRED');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('frozen final manual-validation no-op rechecks the receipt and current HEAD guard', async () => {
  const fixture = summaryFixture();
  const transactionId = 'mv-frozen-final-noop';
  const writes = { value: 0 };
  try {
    const typed = JSON.parse(summaryPayload('### ✅ Manual Validation Passed\n\nFinal validation summary.'));
    typed.manualValidation = { state: 'passed', detail: 'Final validation summary.' };
    const report = readPrChangeReport(fixture.reportPath);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const rendered = replaceCanonicalReportPlaceholder(renderPrSummaryContent(parsePrSummaryContent(typed)), report.value);
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    const body = buildPullRequestSummary(fixture.taskId, rendered.value, fixture.headSha);
    const marker = '<!-- sync-pr:TASK-20260101-000042:summary -->';
    const execution = {
      parentKind: 'pull-request' as const, parent: { kind: 'number' as const, value: 42 }, marker,
      body, bodyDigest: createHash('sha256').update(body).digest('hex'), action: 'update' as const, phase: 'written' as const,
      preimage: { kind: 'comment' as const, id: '9', body, bodyDigest: createHash('sha256').update(body).digest('hex') },
      fence: { headSha: fixture.headSha, manualValidation: { phase: 'final' as const, transactionId, receiptDigest: 'a'.repeat(64), prHeadSha: fixture.headSha, authority: 'coordinator' as const } },
      position: 'none' as const, idempotencyKey: 'frozen-final-noop:update', remoteId: '9'
    };
    const requestBody = JSON.stringify(typed);
    const operation = recordPlatformOperation({
      taskRef: fixture.taskId, cwd: fixture.root, kind: 'pull-request-summary',
      target: JSON.stringify({ kind: 'number', value: 42 }), expectedDigest: createHash('sha256').update(requestBody).digest('hex'),
      dependency: 'deferred', state: 'unknown', pullRequestSummary: {
        body: requestBody, changeReportFile: fixture.reportPath,
        manualValidation: { phase: 'final', transactionId, receiptDigest: 'a'.repeat(64), prHeadSha: fixture.headSha, authority: 'coordinator' }
      }, managedSummary: { requestDigest: createHash('sha256').update(requestBody).digest('hex'), execution }
    });
    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        comments: [{ id: 9, body }], commentWrites: writes
      })
    });
    assert.equal(recovered.status, 'blocked', JSON.stringify(recovered));
    assert.equal(recovered.error?.code, 'MANUAL_VALIDATION_RECEIPT_MISSING');
    assert.equal(writes.value, 0);
    assert.notEqual(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id)?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('frozen final recovery accepts a receipt-backed no-op only after promotion event projection', async () => {
  const fixture = summaryFixture();
  const writes = { value: 0 };
  try {
    const { body, operation } = freezeFinalSummaryRecovery(fixture);
    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        comments: [{ id: 9, body }], commentWrites: writes
      })
    });
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.equal(writes.value, 0);
    const saved = readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id);
    assert.equal(saved?.state, 'succeeded');
    assert.equal(saved?.managedSummary?.execution?.phase, 'written');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('frozen final recovery rejects a committed receipt before the promotion event', async () => {
  const fixture = summaryFixture();
  const writes = { value: 0 };
  try {
    const { body, operation } = freezeFinalSummaryRecovery(fixture, 'receipt-committed');
    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        comments: [{ id: 9, body }], commentWrites: writes
      })
    });
    assert.equal(recovered.status, 'blocked');
    assert.equal(recovered.error?.code, 'MANUAL_VALIDATION_SUMMARY_PROJECTION_INVALID');
    assert.equal(writes.value, 0);
    assert.notEqual(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id)?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('frozen final recovery rejects a receipt-backed no-op after the PR HEAD changes', async () => {
  const fixture = summaryFixture();
  const writes = { value: 0 };
  try {
    const { body, operation } = freezeFinalSummaryRecovery(fixture);
    const changedHead = 'd'.repeat(40);
    const recovered = await recoverPlatformOperations(fixture.taskId, 'all', {
      agent: 'codex', cwd: fixture.root,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        headSequence: [changedHead], comments: [{ id: 9, body }], commentWrites: writes
      })
    });
    assert.equal(recovered.status, 'blocked');
    assert.equal(recovered.error?.code, 'PR_SUMMARY_HEAD_RACE');
    assert.equal(writes.value, 0);
    assert.notEqual(readPlatformOperationJournal(fixture.taskId, fixture.root).operations.find((item) => item.id === operation.id)?.state, 'succeeded');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync sanitizes the template around the canonical placeholder and protects fenced markers', async () => {
  const fixture = summaryFixture();
  const writtenBodies: string[] = [];
  try {
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: [
        'Intro <ScRiPt>alert(1)</ScRiPt>',
        '',
        '```html',
        '<div>example</div>',
        '<!-- sync-pr:TASK-1:summary -->',
        '```',
        '',
        '<!-- canonical-pr-change-report -->'
      ].join('\n'),
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, { writtenBodies })
    });
    assert.equal(result.status, 'applied');
    assert.equal(writtenBodies.length, 1);
    assert.match(writtenBodies[0]!, /Intro &lt;ScRiPt&gt;alert\(1\)&lt;\/ScRiPt&gt;/);
    assert.match(writtenBodies[0]!, /&lt;!-- sync-pr:TASK-1:summary --&gt;/);
    assert.match(writtenBodies[0]!, /<code>README\.md<\/code>/);
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

test('summary-sync does not soften an unverifiable compensation into primary-result success', async () => {
  const fixture = summaryFixture();
  const deleteCalls = { value: 0 };
  try {
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: `## Summary\n\n${'<!-- canonical-pr-change-report -->'}`,
      changeReportFile: fixture.reportPath,
      primaryResult: 'pr_created',
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        pullRequestFailureAt: 3,
        deleteCalls,
        deleteFailure: true
      })
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'MANAGED_SUMMARY_COMPENSATION_FAILED');
    assert.equal(result.result, null);
    assert.equal(result.warnings.length, 0);
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

test('summary-sync re-reads task semantics after provider context resolution', async () => {
  const fixture = summaryFixture();
  try {
    const taskPath = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'task.md');
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

test('summary-sync strict mode preserves report failures for watch-pr callers', async () => {
  const fixture = summaryFixture();
  try {
    fs.writeFileSync(fixture.reportPath, '{}');
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: 'Summary\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      strict: true,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha)
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PR_CHANGE_REPORT_INVALID');
    assert.equal(result.result, null);
    assert.equal(result.warnings.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('summary-sync strict mode preserves a stale report failure for watch-pr callers', async () => {
  const fixture = summaryFixture();
  try {
    const taskPath = path.join(taskWorkspaceRoot(fixture.root),  'active', fixture.taskId, 'task.md');
    const updatedTask = fs.readFileSync(taskPath, 'utf8').replace('Implement the canonical report.', 'Implement the updated canonical report.');
    const result = await syncPullRequestSummary(fixture.taskId, {
      cwd: fixture.root,
      agent: 'codex',
      body: 'Summary\n<!-- canonical-pr-change-report -->',
      changeReportFile: fixture.reportPath,
      primaryResult: 'no_op',
      strict: true,
      client: resolvedContextClient(fixture.root, 'success', fixture.baseSha, fixture.headSha, {
        onContextResolved: () => fs.writeFileSync(taskPath, updatedTask)
      })
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PR_CHANGE_REPORT_STALE');
    assert.equal(result.result, null);
    assert.equal(result.warnings.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'comment API failure',
    code: 'COMMENT_LIST_FAILED',
    status: 'blocked' as const,
    client: (root: string, baseSha: string, headSha: string): GitHubClient => resolvedContextClient(root, 'comments', baseSha, headSha)
  },
  {
    name: 'HEAD resolution failure',
    code: 'PR_CHANGE_REPORT_GIT_FAILED',
    status: 'failed' as const,
    client: (root: string, baseSha: string, headSha: string): GitHubClient => resolvedContextClient(root, 'head', baseSha, headSha)
  },
  {
    name: 'duplicate summary marker',
    code: 'PR_SUMMARY_MARKER_AMBIGUOUS',
    status: 'failed' as const,
    client: (root: string, baseSha: string, headSha: string): GitHubClient => resolvedContextClient(root, 'duplicate', baseSha, headSha)
  }
] as const) {
  test(`summary-sync strict mode preserves ${scenario.name}`, async () => {
    const fixture = summaryFixture();
    try {
      const result = await syncPullRequestSummary(fixture.taskId, {
        cwd: fixture.root,
        agent: 'codex',
        body: 'Summary\n<!-- canonical-pr-change-report -->',
        changeReportFile: fixture.reportPath,
        primaryResult: 'no_op',
        strict: true,
        client: scenario.client(fixture.root, fixture.baseSha, fixture.headSha)
      });
      assert.equal(result.status, scenario.status);
      assert.equal(result.error?.code, scenario.code);
      assert.equal(result.result, null);
      assert.equal(result.warnings.length, 0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

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
