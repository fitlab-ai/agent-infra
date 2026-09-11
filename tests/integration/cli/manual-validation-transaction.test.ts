import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { executeManualValidationTransaction } from '../../../lib/internal/manual-validation.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';
import { buildPrChangeReport, runMechanicalChangeReport, taskIntentDigest, writePrChangeReportAtomic } from '../../../lib/platform/pr-change-report.ts';
import type { PrecheckCandidate } from '../../../lib/platform/pr-change-report.ts';
import { applyTaskEvent } from '../../../lib/task/events.ts';
import { upsertArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import type { ArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import { createManualValidationEvidence } from '../../../lib/task/manual-validation-evidence.ts';
import { createManualValidationReceipt, writeManualValidationReceiptAtomic } from '../../../lib/task/manual-validation-receipt.ts';
import { archiveManualValidationGeneration, createManualValidationTransaction, manualValidationTransactionPath, summaryPreimageDigest, transitionManualValidationTransaction, writeManualValidationTransactionAtomic } from '../../../lib/task/manual-validation-transaction.ts';
import type { ManualValidationTransaction } from '../../../lib/task/manual-validation-transaction.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';
import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';

const TASK_ID = 'TASK-20260101-000042';

type Fixture = {
  root: string;
  taskId: string;
  taskDir: string;
  taskPath: string;
  evidencePath: string;
  summaryPath: string;
  reportPath: string;
  baseSha: string;
  headSha: string;
};

type FakeGitHubState = {
  comments: Array<{ id: number; body: string }>;
  writes: number;
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function approvedReviewArtifact(): string {
  let content = renderArtifactSkeleton({ taskId: TASK_ID, family: 'review-code', artifact: 'review-code.md' })
    .replaceAll('<!-- artifact-slot:empty -->', '内容');
  content = content.replace(
    '## 审查摘要\n<!-- artifact-section:review-code:summary -->\n内容',
    [
      '## 审查摘要',
      '<!-- artifact-section:review-code:summary -->',
      '- **总体结论**：通过',
      '- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：1',
      '- **审查输入**：`code.md`'
    ].join('\n')
  );
  return `${content}\n### 审查决定\n通过\n- **总体结论**：通过\n`;
}

function candidate(taskIntentSha256: string): PrecheckCandidate {
  return {
    taskIntentSha256,
    checks: ['target-alignment', 'change-composition', 'compatibility-policy', 'legacy-path-cleanup', 'redundancy', 'scope-discipline'].map((id) => ({
      id: id as PrecheckCandidate['checks'][number]['id'],
      verdict: 'pass' as const,
      evidence: [{ path: 'README.md', startLine: 1, endLine: 1, detail: 'Fixture change is within the approved scope.' }],
      rationale: 'The fixture change is within the approved scope.'
    }))
  };
}

function fakeClient(baseSha: string, headSha: string, state: FakeGitHubState): GitHubClient {
  return {
    version: () => ({ ok: true, value: '2.72.0' }),
    json: ((args: string[], options?: { input?: string }) => {
      if (args[1] === 'graphql') return { ok: true, value: { data: { viewer: { login: 'codex' } } } };
      if (args[0] === 'api' && args[1] === 'repos/acme/widgets') {
        return { ok: true, value: { full_name: 'acme/widgets', fork: false, permissions: { triage: true, push: true, admin: true } } };
      }
      if (args.some((value) => value.includes('/pulls/42'))) {
        return { ok: true, value: {
          number: 42,
          node_id: 'PR_42',
          html_url: 'https://github.com/acme/widgets/pull/42',
          state: 'open',
          title: 'Canonical report',
          body: '',
          draft: false,
          head: { ref: 'feature', sha: headSha, repo: { full_name: 'acme/widgets' } },
          base: { ref: 'main', sha: baseSha, repo: { full_name: 'acme/widgets' } },
          merged_at: null,
          merge_commit_sha: null
        } };
      }
      if (args.some((value) => value.includes('/issues/42/comments') || value.includes('/issues/comments/9'))) {
        if (args.includes('POST') || args.includes('PATCH')) {
          const body = options?.input ? JSON.parse(options.input).body as string : '';
          state.writes += 1;
          const current = state.comments.find((comment) => comment.body.includes(`<!-- sync-pr:${TASK_ID}:summary -->`));
          if (current) current.body = body;
          else state.comments.push({ id: 9, body });
          return { ok: true, value: { id: current?.id ?? 9 } };
        }
        return { ok: true, value: [state.comments] };
      }
      throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
    }) as GitHubClient['json'],
    text: () => ({ ok: true, value: '' })
  };
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-validation-transaction-'));
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

  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}\n');
  const changeReportScriptDir = path.join(root, '.agents', 'skills', 'create-pr', 'scripts');
  fs.mkdirSync(changeReportScriptDir, { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), '.agents', 'skills', 'create-pr', 'scripts', 'change-report.mjs'), path.join(changeReportScriptDir, 'change-report.mjs'));
  const fact = buildBoundFact({
    identity: {
      resource: { kind: 'number', value: 42 },
      repository: 'acme/widgets',
      url: 'https://github.com/acme/widgets/pull/42',
      head: { repository: 'acme/widgets', ref: 'feature', sha: headSha },
      base: { repository: 'acme/widgets', ref: 'main', sha: baseSha }
    },
    source: 'created',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    remoteState: 'open'
  });
  const taskPath = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskPath, [
    '---',
    `id: ${TASK_ID}`,
    'status: active',
    'current_step: code-review',
    'branch: feature',
    'agent_infra_version: v0.9.15-alpha.0',
    `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(fact))}`,
    '---',
    '',
    '# Task: Canonical manual validation recovery',
    '',
    '## Description',
    '',
    'Exercise coordinator recovery.',
    '',
    '## Context',
    '',
    '- branch: feature',
    '',
    '## Review Disagreement Ledger',
    '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|',
    '',
    '## Activity Log',
    '',
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(taskDir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(taskDir, 'review-code.md'), approvedReviewArtifact());
  const reviewReceipt: ArtifactReceipt = {
    event: 'review-code.completed',
    output: 'review-code.md',
    input: 'code.md',
    inputSha256: sha256File(path.join(taskDir, 'code.md')),
    completedAt: '2026-01-01 00:00:00+00:00'
  };
  const taskWithReceipt = upsertArtifactReceipt(fs.readFileSync(taskPath, 'utf8'), reviewReceipt);
  fs.writeFileSync(taskPath, upsertSection(fs.readFileSync(taskPath, 'utf8'), taskWithReceipt).content);

  const evidencePath = path.join(root, 'evidence.json');
  const evidence = createManualValidationEvidence({
    mode: 'task-bound', taskId: TASK_ID, branch: 'feature', commit: headSha, recoverable: true,
    scope: 'snapshot', command: 'node', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    exitCode: 0, signal: null, cleanup: 'completed'
  });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
  const summaryPath = path.join(root, 'summary.md');
  fs.writeFileSync(summaryPath, '## Summary\n\n<!-- canonical-pr-change-report -->\n');
  const reportPath = path.join(taskDir, 'pr-change-report.json');
  const digest = taskIntentDigest(fs.readFileSync(taskPath, 'utf8'));
  if (!digest.ok) throw new Error(digest.error.message);
  const mechanical = runMechanicalChangeReport(root, baseSha, headSha);
  const report = buildPrChangeReport({
    repository: 'acme/widgets', number: 42,
    base: { repository: 'acme/widgets', ref: 'main', sha: baseSha },
    head: { repository: 'acme/widgets', ref: 'feature', sha: headSha }
  }, digest.value.sha256, mechanical, candidate(digest.value.sha256));
  if (!report.ok) throw new Error(report.error.message);
  writePrChangeReportAtomic(reportPath, report.value);
  const artifactPath = path.join(taskDir, 'manual-validation.md');
  fs.writeFileSync(artifactPath, '# Manual Validation\n\nValidated.\n');
  return { root, taskId: TASK_ID, taskDir, taskPath, evidencePath, summaryPath, reportPath, baseSha, headSha };
}

function values(fixture: Fixture, prepare = false): Record<string, string> {
  return {
    ...(prepare ? { prepare: 'true' } : {}),
    evidenceFile: fixture.evidencePath,
    artifact: 'manual-validation.md',
    summaryFile: fixture.summaryPath,
    ...(prepare ? {} : { changeReportFile: fixture.reportPath }),
    agent: 'codex',
    result: 'no_op'
  };
}

function countStarted(taskPath: string): number {
  return (fs.readFileSync(taskPath, 'utf8').match(/Complete Manual Validation \[started\]/gu) || []).length;
}

function committedGeneration(fixture: Fixture, transactionId: string, prHeadSha: string, evidenceDigest: string, artifact: string) {
  const transaction = createManualValidationTransaction({
    transactionId,
    taskId: fixture.taskId,
    prNumber: 42,
    prHeadSha,
    evidenceDigest,
    summaryPreimage: { commentId: null, body: '', digest: summaryPreimageDigest('') },
    pendingSummaryDigest: 'c'.repeat(64),
    finalSummaryDigest: 'd'.repeat(64),
    artifact,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  const staged = transitionManualValidationTransaction(transaction, 'summary-staged');
  if (!staged.ok) throw new Error(staged.error.message);
  const receipt = createManualValidationReceipt({
    transactionId,
    taskId: fixture.taskId,
    prNumber: 42,
    prHeadSha,
    evidenceDigest,
    artifact,
    artifactSha256: 'e'.repeat(64),
    pendingSummaryDigest: staged.value.pendingSummaryDigest,
    finalSummaryDigest: staged.value.finalSummaryDigest,
    committedAt: '2026-01-01T00:00:00.000Z'
  });
  const receiptCommitted = transitionManualValidationTransaction(staged.value, 'receipt-committed', { committedReceipt: receipt.receiptDigest });
  if (!receiptCommitted.ok) throw new Error(receiptCommitted.error.message);
  const promoting = transitionManualValidationTransaction(receiptCommitted.value, 'final-promotion-in-progress', { eventAppended: true });
  if (!promoting.ok) throw new Error(promoting.error.message);
  const committed = transitionManualValidationTransaction(promoting.value, 'committed', { postWriteVerified: true });
  if (!committed.ok) throw new Error(committed.error.message);
  writeManualValidationTransactionAtomic(fixture.taskDir, committed.value);
  writeManualValidationReceiptAtomic(fixture.taskDir, receipt);
  return { transaction: committed.value, receipt };
}

function prepare(
  fixture: Fixture,
  state = { comments: [], writes: 0 } as FakeGitHubState,
  options: Parameters<typeof executeManualValidationTransaction>[3] = {}
) {
  return executeManualValidationTransaction(fixture.taskId, values(fixture, true), fixture.root, {
    ...options,
    client: options.client ?? fakeClient(fixture.baseSha, fixture.headSha, state)
  });
}

test('coordinator resumes a started-only generation with the persisted identity', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const started = applyTaskEvent({
    taskRef: fixture.taskId, event: 'manual-validation.started', agent: 'codex', initiator: 'model',
    requestId: 'mv-started-only', reasonCode: 'user-request', transactionId: 'mv-started-only'
  }, { repoRoot: fixture.root });
  assert.equal(started.status, 'applied');
  const result = await prepare(fixture);
  assert.equal(result.status, 'applied');
  assert.equal(result.transaction?.transactionId, 'mv-started-only');
  assert.equal(countStarted(fixture.taskPath), 1);
  const replay = await prepare(fixture);
  assert.equal(replay.status, 'applied');
  assert.equal(replay.transaction?.transactionId, 'mv-started-only');
  assert.equal(countStarted(fixture.taskPath), 1);
});

test('coordinator archives a committed generation before preparing the new head', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const old = committedGeneration(fixture, 'mv-old', fixture.baseSha, 'b'.repeat(64), 'manual-validation.md');
  const historyDir = path.join(fixture.taskDir, '.manual-validation', 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.renameSync(path.join(fixture.taskDir, '.manual-validation', 'receipt.json'), path.join(historyDir, 'receipt-mv-old-attempt-1.json'));
  const result = await prepare(fixture);
  assert.equal(result.status, 'applied');
  assert.equal(result.transaction?.transactionId === old.transaction.transactionId, false);
  assert.equal(fs.existsSync(manualValidationTransactionPath(fixture.taskDir)), true);
  assert.equal(fs.existsSync(path.join(fixture.taskDir, '.manual-validation', 'history', 'transaction-mv-old-attempt-1.json')), true);
  assert.equal(fs.existsSync(path.join(fixture.taskDir, '.manual-validation', 'history', 'receipt-mv-old-attempt-1.json')), true);
  assert.equal(countStarted(fixture.taskPath), 1);
});

test('coordinator fails closed when the archived receipt is invalid', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const old = committedGeneration(fixture, 'mv-invalid-history', fixture.baseSha, 'b'.repeat(64), 'manual-validation.md');
  const historyDir = path.join(fixture.taskDir, '.manual-validation', 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.renameSync(path.join(fixture.taskDir, '.manual-validation', 'receipt.json'), path.join(historyDir, 'receipt-mv-invalid-history-attempt-1.json'));
  const invalidReceipt = JSON.parse(fs.readFileSync(path.join(historyDir, 'receipt-mv-invalid-history-attempt-1.json'), 'utf8')) as Record<string, unknown>;
  invalidReceipt.prHeadSha = 'f'.repeat(40);
  fs.writeFileSync(path.join(historyDir, 'receipt-mv-invalid-history-attempt-1.json'), `${JSON.stringify(invalidReceipt)}\n`);
  const result = await prepare(fixture);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED');
  assert.equal(fs.existsSync(manualValidationTransactionPath(fixture.taskDir)), true);
  assert.equal(countStarted(fixture.taskPath), 0);
  assert.equal(old.transaction.phase, 'committed');
});

test('coordinator retries after archive completion without duplicating the started event', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const old = committedGeneration(fixture, 'mv-archived', fixture.baseSha, 'b'.repeat(64), 'manual-validation.md');
  const started = applyTaskEvent({
    taskRef: fixture.taskId, event: 'manual-validation.started', agent: 'codex', initiator: 'model',
    requestId: 'mv-new-after-archive', reasonCode: 'user-request', transactionId: 'mv-new-after-archive'
  }, { repoRoot: fixture.root });
  assert.equal(started.status, 'applied');
  archiveManualValidationGeneration(fixture.taskDir, old.transaction, true);
  const result = await prepare(fixture);
  assert.equal(result.status, 'applied');
  assert.equal(result.transaction?.transactionId, 'mv-new-after-archive');
  assert.equal(countStarted(fixture.taskPath), 1);
});

test('coordinator recovers a receipt-first archive interruption on the same retry identity', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const fault = { injected: false };
  const archiveGeneration = (taskDir: string, transaction: ManualValidationTransaction, requireReceipt?: boolean): void => {
    return archiveManualValidationGeneration(taskDir, transaction, requireReceipt, {
      afterReceiptMove: () => {
        if (!fault.injected) {
          fault.injected = true;
          throw new Error('injected archive interruption');
        }
      }
    });
  };
  const old = committedGeneration(fixture, 'mv-fault', fixture.baseSha, 'b'.repeat(64), 'manual-validation.md');
  const first = await prepare(fixture, undefined, { archiveGeneration });
  assert.equal(first.status, 'failed');
  assert.equal(first.error?.code, 'MANUAL_VALIDATION_TRANSACTION_RECOVERY_REQUIRED');
  assert.equal(countStarted(fixture.taskPath), 1);
  assert.equal(fs.existsSync(path.join(fixture.taskDir, '.manual-validation', 'history', 'receipt-mv-fault-attempt-1.json')), true);
  assert.equal(fs.existsSync(manualValidationTransactionPath(fixture.taskDir)), true);
  assert.equal(fs.existsSync(path.join(fixture.taskDir, '.manual-validation', 'history', 'transaction-mv-fault-attempt-1.json')), false);

  const retry = await prepare(fixture, undefined, { archiveGeneration });
  assert.equal(retry.status, 'applied');
  assert.equal(retry.transaction?.transactionId === old.transaction.transactionId, false);
  assert.equal(countStarted(fixture.taskPath), 1);
  assert.equal(fs.existsSync(path.join(fixture.taskDir, '.manual-validation', 'history', 'transaction-mv-fault-attempt-1.json')), true);

  const replay = await prepare(fixture, undefined, { archiveGeneration });
  assert.equal(replay.status, 'applied');
  assert.equal(replay.transaction?.transactionId, retry.transaction?.transactionId);
  assert.equal(replay.idempotent, true);
  assert.equal(countStarted(fixture.taskPath), 1);
});

test('actual coordinator execution converges on replay without repeated remote writes', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const state: FakeGitHubState = { comments: [], writes: 0 };
  const first = await executeManualValidationTransaction(fixture.taskId, values(fixture), fixture.root, { client: fakeClient(fixture.baseSha, fixture.headSha, state) });
  assert.equal(first.status, 'applied', JSON.stringify({ first, state }));
  assert.equal(first.transaction?.phase, 'committed');
  const writesAfterFirst = state.writes;
  assert.ok(writesAfterFirst > 0);
  const second = await executeManualValidationTransaction(fixture.taskId, values(fixture), fixture.root, { client: fakeClient(fixture.baseSha, fixture.headSha, state) });
  assert.equal(second.status, 'applied');
  assert.equal(second.transaction?.transactionId, first.transaction?.transactionId);
  assert.equal(state.writes, writesAfterFirst);
  assert.equal(countStarted(fixture.taskPath), 1);
});
