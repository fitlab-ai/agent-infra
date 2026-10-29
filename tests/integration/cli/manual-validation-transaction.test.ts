import { taskWorkspaceProject, taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { executeManualValidationTransaction } from '../../../lib/internal/manual-validation.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';
import { buildPrChangeReport, runMechanicalChangeReport, taskIntentDigest, writePrChangeReportAtomic } from '../../../lib/platform/pr-change-report.ts';
import type { MechanicalChangeReport, PrecheckCandidate } from '../../../lib/platform/pr-change-report.ts';
import { applyTaskEvent } from '../../../lib/task/events.ts';
import { upsertArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import type { ArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import { createManualValidationReceipt, writeManualValidationReceiptAtomic } from '../../../lib/task/manual-validation-receipt.ts';
import { archiveManualValidationGeneration, createManualValidationTransaction, manualValidationTransactionPath, readManualValidationTransaction, summaryPreimageDigest, transitionManualValidationTransaction, writeManualValidationTransactionAtomic } from '../../../lib/task/manual-validation-transaction.ts';
import type { ManualValidationTransaction } from '../../../lib/task/manual-validation-transaction.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';
import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { createTempDir } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000042';

function manualSummaryContent() {
  return { overview: '实现摘要。', tests: { state: 'not-started', detail: 'CI 尚未启动。' }, review: { state: 'not-observed', detail: '未读取远端 Review。' }, manualValidation: { state: 'required', detail: '在生产环境完成权限校验。' }, humanDecisions: { open: 0, resolved: 0, detail: '无待处理裁决。' }, risks: '无额外风险记录。' };
}

type Fixture = {
  root: string;
  taskId: string;
  taskDir: string;
  taskPath: string;
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

function candidate(taskIntentSha256: string, diff: MechanicalChangeReport): PrecheckCandidate {
  return {
    taskIntentSha256,
    checks: ['target-alignment', 'change-composition', 'compatibility-policy', 'legacy-path-cleanup', 'redundancy', 'scope-discipline'].map((id) => ({
      id: id as PrecheckCandidate['checks'][number]['id'],
      verdict: 'pass' as const,
      evidence: [{ path: 'README.md', startLine: 1, endLine: 1, detail: 'Fixture change is within the approved scope.' }],
      rationale: 'The fixture change is within the approved scope.',
      ...(id === 'change-composition' ? { groups: [{
        id: 'manual-validation-transaction', target: 'Preserve manual-validation transaction safety',
        behaviorChange: 'Keep receipt and PR head binding through summary refresh.',
        necessity: 'Protect the final coordinator transaction.',
        files: diff.files.map((file) => file.oldPath ?? file.newPath!),
        tests: { coverage: 'This integration fixture exercises transaction, receipt and PR head paths.', cost: 'Existing fixture and cases are reused.' }
      }] } : {})
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
  const root = createTempDir('manual-validation-transaction-');
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

  const taskDir = path.join(taskWorkspaceRoot(root),  'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), platform: { type: 'github' } }) + '\n');
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
  fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：完整路径。\n- **判定依据**：夹具覆盖人工校验。\n- **未满足的更高路径条件**：没有更高路径。\n- **升级触发条件**：生命周期事实发生变化。\n');
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

  const summaryPath = path.join(root, 'summary.md');
  fs.writeFileSync(summaryPath, JSON.stringify(manualSummaryContent()));
  const reportPath = path.join(taskDir, 'pr-change-report.json');
  const digest = taskIntentDigest(fs.readFileSync(taskPath, 'utf8'));
  if (!digest.ok) throw new Error(digest.error.message);
  const mechanical = runMechanicalChangeReport(root, baseSha, headSha);
  const report = buildPrChangeReport({
    repository: 'acme/widgets', resource: { kind: 'number', value: 42 },
    base: { repository: 'acme/widgets', ref: 'main', sha: baseSha },
    head: { repository: 'acme/widgets', ref: 'feature', sha: headSha }
  }, digest.value.sha256, mechanical, candidate(digest.value.sha256, mechanical));
  if (!report.ok) throw new Error(report.error.message);
  writePrChangeReportAtomic(reportPath, report.value);
  const artifactPath = path.join(taskDir, 'manual-validation.md');
  fs.writeFileSync(artifactPath, '# Manual Validation\n\nValidated.\n');
  const completionFacts = ['analysis.md', 'code.md', 'review-code.md'].map((name) => {
    const artifactPath = path.join(taskDir, name);
    const content = fs.readFileSync(artifactPath, 'utf8');
    const family = name === 'analysis.md' ? 'analyze' : name === 'code.md' ? 'code' : 'review-code';
    return {
      event: `${family}.completed`, output: name, outputSha256: sha256File(artifactPath),
      semanticDigest: canonicalSemanticDigest(content), requestId: `fixture-${name}`, result: name === 'review-code' ? JSON.stringify({ manualValidation: 1 }) : content,
      lifecycleInputs: name === 'review-code.md' ? [{ name: 'code.md', sha256: sha256File(path.join(taskDir, 'code.md')) }] : []
    };
  });
  let completedTask = fs.readFileSync(taskPath, 'utf8').replace(
    /\n---\n/u,
    `\ncompletion_facts: '${JSON.stringify(completionFacts)}'\n---\n`
  );
  completedTask = completedTask.replace(
    '- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md',
    [
      '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started',
      '- 2026-01-01 00:00:01+00:00 — **Analyze Task (Round 1)** by codex — completed → analysis.md',
      '- 2026-01-01 00:00:02+00:00 — **Review Code (Round 1) [started]** by codex — started',
      '- 2026-01-01 00:00:03+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 1 → review-code.md'
    ].join('\n')
  );
  fs.writeFileSync(taskPath, completedTask);
  return { root, taskId: TASK_ID, taskDir, taskPath, summaryPath, reportPath, baseSha, headSha };
}

function values(fixture: Fixture, prepare = false): Record<string, string> {
  return {
    ...(prepare ? { prepare: 'true' } : {}),
    artifact: 'manual-validation.md',
    summaryFile: fixture.summaryPath,
    ...(prepare ? {} : { changeReportFile: fixture.reportPath }),
    agent: 'codex',
    result: 'no_op'
  };
}

function configureOpaqueIdentity(fixture: Fixture, config: Record<string, unknown> = {}): void {
  const taskContent = fs.readFileSync(fixture.taskPath, 'utf8');
  const fact = encodePrDeliveryFact(buildBoundFact({
    identity: {
      resource: { kind: 'id', value: 'mr:42' },
      repository: 'acme/widgets',
      url: 'https://opaque.example/changes/mr:42',
      head: { repository: 'acme/widgets', ref: 'feature', sha: fixture.headSha },
      base: { repository: 'acme/widgets', ref: 'main', sha: fixture.baseSha }
    },
    source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open'
  }));
  fs.writeFileSync(fixture.taskPath, taskContent.replace(/^pr_delivery_fact: .*$/m, `pr_delivery_fact: ${JSON.stringify(fact)}`));
  const source = path.resolve(process.cwd(), 'tests/fixtures/platform-providers/opaque-identity-provider.mjs');
  fs.writeFileSync(path.join(fixture.root, '.agents', '.airc.json'), JSON.stringify({
    project: taskWorkspaceProject(fixture.root),
    platform: { type: 'trae', providers: { trae: { source, config: {
      repository: 'acme/widgets', number: 42, baseSha: fixture.baseSha, headSha: fixture.headSha, ...config
    } } } }
  }));
  const digest = taskIntentDigest(fs.readFileSync(fixture.taskPath, 'utf8'));
  if (!digest.ok) throw new Error(digest.error.message);
  const mechanical = runMechanicalChangeReport(fixture.root, fixture.baseSha, fixture.headSha);
  const report = buildPrChangeReport({
    repository: 'acme/widgets', resource: { kind: 'id', value: 'mr:42' },
    base: { repository: 'acme/widgets', ref: 'main', sha: fixture.baseSha },
    head: { repository: 'acme/widgets', ref: 'feature', sha: fixture.headSha }
  }, digest.value.sha256, mechanical, candidate(digest.value.sha256, mechanical));
  if (!report.ok) throw new Error(report.error.message);
  writePrChangeReportAtomic(fixture.reportPath, report.value);
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

test('opaque PR identity completes the manual-validation transaction lifecycle', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  configureOpaqueIdentity(fixture);

  const first = await executeManualValidationTransaction(fixture.taskId, values(fixture), fixture.root);

  assert.equal(first.status, 'applied', JSON.stringify(first));
  assert.equal(first.transaction?.phase, 'committed');
  assert.equal(first.transaction?.prNumber, 42);
  assert.equal(first.receipt?.prNumber, 42);
  assert.equal(first.receipt?.prHeadSha, fixture.headSha);
  assert.match(fs.readFileSync(fixture.taskPath, 'utf8'), /\*\*Complete Manual Validation\*\* by codex — Manual validation passed/u);
});

test('opaque PR identity recovers a failed final summary promotion on coordinator retry', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  configureOpaqueIdentity(fixture, { failFinalOnce: true });

  const first = await executeManualValidationTransaction(fixture.taskId, values(fixture), fixture.root);
  assert.equal(first.status, 'failed');
  const failedTransaction = readManualValidationTransaction(fixture.taskDir);
  assert.equal(failedTransaction.ok, true);
  if (!failedTransaction.ok) return;
  assert.equal(failedTransaction.value.phase, 'recovery-required');

  const retry = await executeManualValidationTransaction(fixture.taskId, values(fixture), fixture.root);

  assert.equal(retry.status, 'applied', JSON.stringify(retry));
  assert.equal(retry.transaction?.phase, 'committed');
  assert.equal(retry.transaction?.prNumber, 42);
  assert.equal(retry.receipt?.prNumber, 42);
  assert.equal(retry.receipt?.prHeadSha, fixture.headSha);
});

test('coordinator replaces the Chinese manual-validation section and preserves canonical report order', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.summaryPath, JSON.stringify(manualSummaryContent()));
  const state: FakeGitHubState = { comments: [], writes: 0 };

  const result = await executeManualValidationTransaction(fixture.taskId, values(fixture), fixture.root, {
    client: fakeClient(fixture.baseSha, fixture.headSha, state)
  });

  assert.equal(result.status, 'applied', JSON.stringify(result));
  const body = state.comments[0]?.body ?? '';
  assert.match(body, /### ✅ 人工验证已通过\n\n状态：passed\n\n在生产环境完成权限校验。\n\n<!-- manual-validation-receipt: [^\n]+ -->/m);
  assert.equal((body.match(/^###\s+(?:⚠️\s+需人工校验|✅\s+人工验证已通过|⏳\s+人工验证待收尾)\s*$/gmu) ?? []).length, 1);
  const statusIndex = body.indexOf('### ✅ 人工验证已通过');
  const stateIndex = body.indexOf('状态：passed');
  const detailIndex = body.indexOf('在生产环境完成权限校验。');
  const receiptIndex = body.indexOf('<!-- manual-validation-receipt:');
  const decisionsIndex = body.indexOf('### 人工决策');
  const reportIndex = body.indexOf('### PR 代码增减');
  assert.ok(statusIndex >= 0 && stateIndex >= 0 && detailIndex >= 0 && receiptIndex >= 0 && decisionsIndex >= 0 && reportIndex >= 0);
  assert.ok(statusIndex < stateIndex && stateIndex < detailIndex && detailIndex < receiptIndex && receiptIndex < decisionsIndex && decisionsIndex < reportIndex);
});


test('manual validation preparation exposes missing log warning on first call and replay', async () => {
  const f = createFixture();
  try {
    fs.writeFileSync(f.taskPath, fs.readFileSync(f.taskPath, 'utf8').replace(/## Activity Log\n[\s\S]*?(?=\n## |$)/u, ''));
    for (const response of [await prepare(f), await prepare(f)]) {
      assert.equal(response.status, 'applied');
      assert.ok((response.warnings as { code: string }[]).some((warning) => warning.code === 'ACTIVITY_LOG_UNAVAILABLE'));
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
