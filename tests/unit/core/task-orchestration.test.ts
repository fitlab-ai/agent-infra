import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  beginOrResumeOrchestration as beginOrResumeOrchestrationRaw,
  completeOrchestrationStage,
  pauseOrchestration,
  prepareOrchestrationDelegation as prepareOrchestrationDelegationRaw,
  readRun,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';

const snapshot = () => 'before-tree';
const modelPolicy = {
  executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
  reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
} as const;

function beginOrResumeOrchestration(
  taskRef: string,
  options: Parameters<typeof beginOrResumeOrchestrationRaw>[1] = {}
) {
  return beginOrResumeOrchestrationRaw(taskRef, { client: 'claude-code', modelPolicy, ...options });
}

function prepareOrchestrationDelegation(
  taskRef: string,
  input: Parameters<typeof prepareOrchestrationDelegationRaw>[1],
  options: Parameters<typeof prepareOrchestrationDelegationRaw>[2] = {}
) {
  return prepareOrchestrationDelegationRaw(taskRef, input, {
    supportsLifecycleDelegation: () => true,
    ...options
  });
}

function fixture(step: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: TASK-20260101-000001\ncurrent_step: ${step}\n---\n\n# Task\n`);
  return { root, taskDir };
}

function approvedCodeFixture(manualValidation = 0) {
  const f = fixture('code-review');
  fs.mkdirSync(path.join(f.root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), '{}\n');
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(f.taskDir, 'review-analysis.md'), '# Analysis Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(f.taskDir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(f.taskDir, 'review-plan.md'), '# Plan Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(f.taskDir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.taskDir, 'review-code.md'), `# Code Review\n\n- **审查输入**：\`code.md\`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：${manualValidation}\n`);
  return f;
}

function cleanCommitCandidateFixture(prFlow: unknown = 'required') {
  const f = approvedCodeFixture();
  const head = 'a'.repeat(40);
  fs.mkdirSync(path.join(f.root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), `${JSON.stringify({ prFlow })}\n`);
  fs.writeFileSync(path.join(f.taskDir, 'task.md'), `---\nid: TASK-20260101-000001\ncurrent_step: code-review\npr_number: 42\nlast_reviewed_commit: ${head}\n---\n\n# Task\n`);
  beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root,
    id: () => 'run-clean',
    now: () => '2026-01-01T00:00:00.000Z'
  });
  return { ...f, head };
}

test('begin is persistent and idempotent for a running task', () => {
  const f = fixture('requirement-analysis');
  const first = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-1', now: () => '2026-01-01T00:00:00.000Z'
  });
  assert.equal(first.status, 'running');
  assert.equal(first.changed, true);
  const second = beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  assert.equal(second.changed, false);
  assert.equal(second.run?.runId, 'run-1');
  assert.deepEqual(second.run?.modelPolicy, modelPolicy);
  assert.equal(second.run?.schemaVersion, 2);
  assert.equal(second.run?.modelPolicySource?.kind, 'explicit');
});

test('completed v2 runs are idempotent across client changes', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const runPath = path.join(f.taskDir, 'orchestration.json');
  const completed = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  completed.status = 'completed';
  fs.writeFileSync(runPath, `${JSON.stringify(completed, null, 2)}\n`);

  const result = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: f.root,
    client: 'codex'
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.changed, false);
  assert.equal(result.run?.runId, completed.runId);
});

test('begin requires a client and does not write state when no policy source is complete', () => {
  const missingClient = fixture('requirement-analysis');
  const withoutClient = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: missingClient.root,
    modelPolicy
  });
  assert.equal(withoutClient.error?.code, 'ORCHESTRATION_PAYLOAD_INVALID');

  const missingPolicy = fixture('requirement-analysis');
  const withoutPolicy = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: missingPolicy.root,
    client: 'claude-code'
  });
  assert.equal(withoutPolicy.error?.code, 'ORCHESTRATION_MODEL_POLICY_REQUIRED');
  assert.equal(withoutPolicy.error?.modelSelectionContext?.kind, 'interactive-only');
  assert.equal(fs.existsSync(path.join(missingPolicy.taskDir, 'orchestration.json')), false);
});

test('begin accepts a complete run-level policy when both roles use the same model', () => {
  const missing = fixture('requirement-analysis');
  const missingResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: missing.root, client: 'claude-code'
  });
  assert.equal(missingResult.error?.code, 'ORCHESTRATION_MODEL_POLICY_REQUIRED');
  assert.equal(fs.existsSync(path.join(missing.taskDir, 'orchestration.json')), false);

  const shared = fixture('requirement-analysis');
  const sharedResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: shared.root,
    client: 'claude-code',
    modelPolicy: {
      executor: { model: 'shared-model', reasoningEffort: 'high' },
      reviewer: { model: 'shared-model', reasoningEffort: 'high' }
    }
  });
  assert.equal(sharedResult.status, 'running');
  assert.deepEqual(sharedResult.run?.modelPolicy, {
    executor: { model: 'shared-model', reasoningEffort: 'high' },
    reviewer: { model: 'shared-model', reasoningEffort: 'high' }
  });
});

test('resume rejects policy changes and pauses legacy runs without model evidence', () => {
  const mismatch = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: mismatch.root });
  const mismatchResult = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: mismatch.root,
    client: 'claude-code',
    modelPolicy: { ...modelPolicy, executor: { ...modelPolicy.executor, model: 'other-model' } }
  });
  assert.equal(mismatchResult.error?.code, 'ORCHESTRATION_MODEL_POLICY_MISMATCH');

  const legacy = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: legacy.root });
  const runPath = path.join(legacy.taskDir, 'orchestration.json');
  const persisted = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  persisted.schemaVersion = 1;
  delete persisted.modelPolicy;
  delete persisted.modelPolicySource;
  delete persisted.recoveryHistory;
  persisted.status = 'paused';
  persisted.pause = {
    code: 'ORCHESTRATION_MODEL_EVIDENCE_MISSING',
    message: 'legacy policy missing',
    recoverable: false
  };
  fs.writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`);
  const resumed = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: legacy.root, client: 'claude-code', modelPolicy
  });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.run?.schemaVersion, 2);
  assert.equal(resumed.run?.recoveryHistory?.length, 1);
  const repeated = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: legacy.root, client: 'claude-code'
  });
  assert.equal(repeated.changed, false);
});

test('legacy recovery rejects historical receipts and malformed v2 state', () => {
  const historical = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: historical.root });
  const historicalPath = path.join(historical.taskDir, 'orchestration.json');
  const v1 = JSON.parse(fs.readFileSync(historicalPath, 'utf8'));
  v1.schemaVersion = 1;
  v1.modelPolicy = {
    executor: 'executor-model', reviewer: 'reviewer-model'
  };
  delete v1.modelPolicySource;
  delete v1.recoveryHistory;
  v1.receipts = [{ id: 'legacy-receipt' }];
  fs.writeFileSync(historicalPath, `${JSON.stringify(v1, null, 2)}\n`);
  const blocked = beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: historical.root, client: 'claude-code', modelPolicy
  });
  assert.equal(blocked.status, 'paused');
  assert.equal(blocked.run?.pause?.code, 'ORCHESTRATION_HISTORICAL_EFFORT_UNVERIFIED');

  const malformed = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: malformed.root });
  const malformedPath = path.join(malformed.taskDir, 'orchestration.json');
  const v2 = JSON.parse(fs.readFileSync(malformedPath, 'utf8'));
  delete v2.modelPolicySource;
  fs.writeFileSync(malformedPath, `${JSON.stringify(v2, null, 2)}\n`);
  assert.equal(beginOrResumeOrchestrationRaw('TASK-20260101-000001', {
    repoRoot: malformed.root, client: 'claude-code'
  }).error?.code, 'ORCHESTRATION_STATE_INVALID');
});

test('prepare validates requested model before capturing workspace state', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  let captures = 0;
  const captureWorkspace = () => { captures += 1; return 'snapshot'; };
  const missing = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code'
  }, { repoRoot: f.root, captureWorkspace });
  assert.equal(missing.error?.code, 'ORCHESTRATION_REQUESTED_MODEL_REQUIRED');
  const mismatch = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'wrong-model', requestedReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, captureWorkspace });
  assert.equal(mismatch.error?.code, 'ORCHESTRATION_REQUESTED_MODEL_MISMATCH');
  assert.equal(captures, 0);
});

test('prepare fails closed for clients without orchestration capability', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const result = prepareOrchestrationDelegationRaw('TASK-20260101-000001', {
    client: 'antigravity-cli'
  }, { repoRoot: f.root, captureWorkspace: snapshot });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.equal(result.changed, false);
});

test('prepare fails closed for Claude Code when native model evidence is not observable', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const result = prepareOrchestrationDelegationRaw('TASK-20260101-000001', {
    client: 'claude-code'
  }, { repoRoot: f.root, captureWorkspace: snapshot });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.equal(result.changed, false);
});

test('prepare fails closed for Codex when native lifecycle events are not observable', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  const result = prepareOrchestrationDelegationRaw('TASK-20260101-000001', {
    client: 'codex'
  }, { repoRoot: f.root, captureWorkspace: snapshot });
  assert.equal(result.error?.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.equal(result.changed, false);
});

test('route selects one fresh role from existing lifecycle facts', () => {
  const analysis = fixture('requirement-analysis');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: analysis.root }).next, {
    action: 'analyze-task', role: 'executor', stage: 'analysis', round: 1, artifact: 'analysis.md',
    requestedModel: null, requestedReasoningEffort: null
  });

  const review = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(review.taskDir, 'analysis.md'), '# Analysis\n');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: review.root }).next, {
    action: 'review-analysis', role: 'reviewer', stage: 'review-analysis', round: 1, artifact: 'review-analysis.md',
    requestedModel: null, requestedReasoningEffort: null
  });

  const code = fixture('technical-design-review');
  fs.writeFileSync(path.join(code.taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(code.taskDir, 'review-analysis.md'), '# Analysis Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(code.taskDir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(code.taskDir, 'review-plan.md'), '# Plan Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: code.root }).next, {
    action: 'code-task', role: 'executor', stage: 'code', round: 1, artifact: 'code.md',
    requestedModel: null, requestedReasoningEffort: null
  });
});

test('route requires the latest review to bind the latest artifact structurally', () => {
  const f = approvedCodeFixture();
  fs.writeFileSync(path.join(f.taskDir, 'code-r2.md'), '# Code round 2\n');
  fs.utimesSync(path.join(f.taskDir, 'review-code.md'), new Date(), new Date());

  assert.deepEqual(routeOrchestration('TASK-20260101-000001', { repoRoot: f.root }).next, {
    action: 'review-code', role: 'reviewer', stage: 'review-code', round: 2, artifact: 'review-code-r2.md',
    requestedModel: null, requestedReasoningEffort: null
  });
});

test('route allows commit when manual validation remains (complete-task gate owns the pending items)', () => {
  const manual = approvedCodeFixture(1);
  const routed = routeOrchestration('TASK-20260101-000001', { repoRoot: manual.root });
  assert.equal(routed.error, null);
  assert.deepEqual(routed.next, {
    action: 'commit', role: 'executor', stage: 'commit', round: 1, artifact: 'commit',
    requestedModel: null, requestedReasoningEffort: null
  });
});

test('route fails closed before commit when code review ledger work remains', () => {
  const ledger = approvedCodeFixture();
  fs.appendFileSync(path.join(ledger.taskDir, 'task.md'), '\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | blocker | open | review-code.md#CD-1 |\n');
  assert.equal(
    routeOrchestration('TASK-20260101-000001', { repoRoot: ledger.root }).error?.code,
    'ORCHESTRATION_LEDGER_BLOCKED'
  );
});

test('route completes a reviewed clean head without preparing a commit', () => {
  const f = cleanCommitCandidateFixture();
  const tree = 'b'.repeat(40);
  let captures = 0;
  const routed = routeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root,
    now: () => '2026-01-01T00:00:05.000Z',
    captureRepository: () => {
      captures += 1;
      return { head: f.head, headTree: tree, worktreeTree: tree };
    },
    inspectPullRequest: () => ({
      status: 'no-op',
      task: { prNumber: 42 },
      pullRequest: { head: { sha: f.head } },
      error: null
    })
  });

  assert.equal(routed.status, 'completed');
  assert.equal(routed.changed, true);
  assert.equal(routed.next, null);
  assert.equal(captures, 2);
  assert.deepEqual(routed.run?.completionEvidence, {
    kind: 'reviewed-head-clean',
    observedAt: '2026-01-01T00:00:05.000Z',
    head: f.head,
    headTree: tree,
    worktreeTree: tree,
    lastReviewedCommit: f.head,
    prNumber: 42,
    prHead: f.head
  });
  assert.deepEqual(routed.run?.commitAuthorization, { issuedAt: null, consumedAt: null });
  assert.equal(routed.run?.receipts.some((receipt) => receipt.stage === 'commit'), false);
});

test('route preserves commit for dirty repositories without inspecting the PR', () => {
  const f = cleanCommitCandidateFixture();
  let inspections = 0;
  const routed = routeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root,
    captureRepository: () => ({
      head: f.head,
      headTree: 'b'.repeat(40),
      worktreeTree: 'c'.repeat(40)
    }),
    inspectPullRequest: () => {
      inspections += 1;
      throw new Error('must not inspect');
    }
  });

  assert.equal(routed.status, 'running');
  assert.equal(routed.next?.stage, 'commit');
  assert.equal(inspections, 0);
});

test('route gates clean completion on an explicit required PR flow', () => {
  for (const config of [{ prFlow: 'disabled' }, {}]) {
    const f = cleanCommitCandidateFixture(config.prFlow);
    fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), `${JSON.stringify(config)}\n`);
    let captures = 0;
    const routed = routeOrchestration('TASK-20260101-000001', {
      repoRoot: f.root,
      captureRepository: () => {
        captures += 1;
        throw new Error('must not capture');
      }
    });
    assert.equal(routed.next?.stage, 'commit');
    assert.equal(captures, 0);
  }

  const missingPr = cleanCommitCandidateFixture();
  fs.writeFileSync(path.join(missingPr.taskDir, 'task.md'), `---\nid: TASK-20260101-000001\ncurrent_step: code-review\nlast_reviewed_commit: ${missingPr.head}\n---\n\n# Task\n`);
  let missingPrCaptures = 0;
  const routed = routeOrchestration('TASK-20260101-000001', {
    repoRoot: missingPr.root,
    captureRepository: () => {
      missingPrCaptures += 1;
      throw new Error('must not capture');
    }
  });
  assert.equal(routed.next?.stage, 'commit');
  assert.equal(missingPrCaptures, 0);
});

test('route fails closed for invalid orchestration configuration', () => {
  const f = cleanCommitCandidateFixture();
  fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), '{not-json\n');
  assert.equal(
    routeOrchestration('TASK-20260101-000001', { repoRoot: f.root }).error?.code,
    'ORCHESTRATION_CONFIG_INVALID'
  );

  const invalidPrFlow = cleanCommitCandidateFixture('always');
  assert.equal(
    routeOrchestration('TASK-20260101-000001', { repoRoot: invalidPrFlow.root }).error?.code,
    'ORCHESTRATION_CONFIG_INVALID'
  );
});

test('route fails closed across clean completion evidence boundaries', () => {
  const tree = 'b'.repeat(40);
  const cleanSnapshot = (head: string) => ({ head, headTree: tree, worktreeTree: tree });
  const inspection = (head: string) => ({
    status: 'no-op', task: { prNumber: 42 }, pullRequest: { head: { sha: head } }, error: null
  });

  const snapshotFailure = cleanCommitCandidateFixture();
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: snapshotFailure.root,
    captureRepository: () => { throw new Error('git failed'); }
  }).error?.code, 'ORCHESTRATION_SNAPSHOT_FAILED');

  const secondSnapshotFailure = cleanCommitCandidateFixture();
  let captures = 0;
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: secondSnapshotFailure.root,
    captureRepository: () => {
      captures += 1;
      if (captures === 2) throw new Error('git failed');
      return cleanSnapshot(secondSnapshotFailure.head);
    },
    inspectPullRequest: () => inspection(secondSnapshotFailure.head)
  }).error?.code, 'ORCHESTRATION_SNAPSHOT_FAILED');

  const reviewedMismatch = cleanCommitCandidateFixture();
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: reviewedMismatch.root,
    captureRepository: () => cleanSnapshot('d'.repeat(40))
  }).error?.code, 'ORCHESTRATION_REVIEWED_HEAD_MISMATCH');

  for (const status of ['blocked', 'failed'] as const) {
    const f = cleanCommitCandidateFixture();
    const routed = routeOrchestration('TASK-20260101-000001', {
      repoRoot: f.root,
      captureRepository: () => cleanSnapshot(f.head),
      inspectPullRequest: () => ({ status, error: { message: status } })
    });
    assert.equal(routed.error?.code, `ORCHESTRATION_PR_INSPECTION_${status.toUpperCase()}`);
  }

  const missingInspection = cleanCommitCandidateFixture();
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: missingInspection.root,
    captureRepository: () => cleanSnapshot(missingInspection.head),
    inspectPullRequest: () => ({ status: 'no-op', task: { prNumber: 42 }, error: null })
  }).error?.code, 'ORCHESTRATION_PR_INSPECTION_INVALID');

  const prNumberMismatch = cleanCommitCandidateFixture();
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: prNumberMismatch.root,
    captureRepository: () => cleanSnapshot(prNumberMismatch.head),
    inspectPullRequest: () => ({
      status: 'no-op', task: { prNumber: 43 },
      pullRequest: { head: { sha: prNumberMismatch.head } }, error: null
    })
  }).error?.code, 'ORCHESTRATION_PR_HEAD_MISMATCH');

  const prMismatch = cleanCommitCandidateFixture();
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: prMismatch.root,
    captureRepository: () => cleanSnapshot(prMismatch.head),
    inspectPullRequest: () => inspection('e'.repeat(40))
  }).error?.code, 'ORCHESTRATION_PR_HEAD_MISMATCH');

  const secondDirty = cleanCommitCandidateFixture();
  const dirtySnapshots = [
    cleanSnapshot(secondDirty.head),
    { head: secondDirty.head, headTree: tree, worktreeTree: 'c'.repeat(40) }
  ];
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: secondDirty.root,
    captureRepository: () => dirtySnapshots.shift()!,
    inspectPullRequest: () => inspection(secondDirty.head)
  }).next?.stage, 'commit');

  const changed = cleanCommitCandidateFixture();
  const changedSnapshots = [cleanSnapshot(changed.head), cleanSnapshot('f'.repeat(40))];
  assert.equal(routeOrchestration('TASK-20260101-000001', {
    repoRoot: changed.root,
    captureRepository: () => changedSnapshots.shift()!,
    inspectPullRequest: () => inspection(changed.head)
  }).error?.code, 'ORCHESTRATION_REPOSITORY_CHANGED');
});

test('route clean completion is idempotent', () => {
  const f = cleanCommitCandidateFixture();
  const tree = 'b'.repeat(40);
  const options = {
    repoRoot: f.root,
    now: () => '2026-01-01T00:00:05.000Z',
    captureRepository: () => ({ head: f.head, headTree: tree, worktreeTree: tree }),
    inspectPullRequest: () => ({
      status: 'no-op', task: { prNumber: 42 }, pullRequest: { head: { sha: f.head } }, error: null
    })
  };
  const first = routeOrchestration('TASK-20260101-000001', options);
  const second = routeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root,
    captureRepository: () => { throw new Error('must not recapture completed evidence'); }
  });
  assert.equal(first.changed, true);
  assert.equal(second.status, 'completed');
  assert.equal(second.changed, false);
  assert.deepEqual(second.run?.completionEvidence, first.run?.completionEvidence);
});

test('commit authorization is issued and the run completes even with pending manual validation', () => {
  const f = approvedCodeFixture(1);
  const now = () => '2026-01-01T00:00:00.000Z';
  const begun = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-mv', now
  });
  assert.equal(begun.run?.commitAuthorization.issuedAt, null);

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, id: () => 'receipt-mv', now, captureWorkspace: snapshot });
  assert.equal(prepared.next?.stage, 'commit');
  assert.equal(prepared.run?.pendingDelegation?.workspaceSnapshotScope, 'task');
  assert.equal(prepared.run?.commitAuthorization.issuedAt, '2026-01-01T00:00:00.000Z');

  assert.equal(activateOrchestrationDelegation('TASK-20260101-000001', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-mv', parentId: 'parent-mv',
    spawnMode: 'fresh', actualModel: 'executor-model', actualReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'commit', round: 1, artifact: 'commit', agent: 'claude-code'
  }, { repoRoot: f.root }).status, 'running');
  assert.equal(sealOrchestrationDelegation('TASK-20260101-000001', {
    childId: 'child-mv', exitCode: 0, afterFingerprint: 'after', changedPaths: []
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(advanceOrchestration('TASK-20260101-000001', { repoRoot: f.root, now }).status, 'completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(readRun(f.taskDir)?.pendingDelegation, null);
});

test('commit authorization is issued at eligible prepare and the receipt reaches completed', () => {
  const f = approvedCodeFixture();
  const now = () => '2026-01-01T00:00:00.000Z';
  const begun = beginOrResumeOrchestration('TASK-20260101-000001', {
    repoRoot: f.root, id: () => 'run-1', now
  });
  assert.equal(begun.run?.commitAuthorization.issuedAt, null);

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, id: () => 'receipt-1', now, captureWorkspace: snapshot });
  assert.equal(prepared.next?.stage, 'commit');
  assert.equal(prepared.run?.pendingDelegation?.workspaceSnapshotScope, 'task');
  assert.equal(prepared.run?.commitAuthorization.issuedAt, '2026-01-01T00:00:00.000Z');

  assert.equal(activateOrchestrationDelegation('TASK-20260101-000001', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-1', parentId: 'parent-1',
    spawnMode: 'fresh', actualModel: 'executor-model', actualReasoningEffort: 'xhigh'
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'commit', round: 1, artifact: 'commit', agent: 'claude-code'
  }, { repoRoot: f.root }).status, 'running');
  assert.equal(sealOrchestrationDelegation('TASK-20260101-000001', {
    childId: 'child-1', exitCode: 0, afterFingerprint: 'after', changedPaths: []
  }, { repoRoot: f.root, now }).status, 'running');
  assert.equal(advanceOrchestration('TASK-20260101-000001', { repoRoot: f.root, now }).status, 'completed');
  assert.equal(readRun(f.taskDir)?.commitAuthorization.consumedAt, '2026-01-01T00:00:00.000Z');
});

test('native start binds the unique prepared delegation without task identity', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  const started = activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-executor', childId: 'child-native',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'executor-model', actualReasoningEffort: 'xhigh'
  }, { repoRoot: f.root });

  assert.equal(started.status, 'running');
  assert.equal(started.run?.pendingDelegation?.taskId, 'TASK-20260101-000001');
  assert.equal(started.run?.pendingDelegation?.parentId, 'parent-session');
  assert.equal(started.run?.pendingDelegation?.childId, 'child-native');
});

test('managed native hook mismatches persist a recoverable pause', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  const started = activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'wrong-role',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'executor-model', actualReasoningEffort: 'xhigh'
  }, { repoRoot: f.root });

  assert.equal(started.status, 'paused');
  assert.equal(started.run?.pause?.code, 'DELEGATION_ROLE_MISMATCH');
});

test('repository pending guard includes paused runs that retain a delegation', () => {
  const f = fixture('requirement-analysis');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'opencode', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });
  pauseOrchestration('TASK-20260101-000001', 'HOOK_FAILED', 'hook failed', true, { repoRoot: f.root });

  const secondTaskDir = path.join(f.root, '.agents', 'workspace', 'active', 'TASK-20260101-000002');
  fs.mkdirSync(secondTaskDir, { recursive: true });
  fs.writeFileSync(
    path.join(secondTaskDir, 'task.md'),
    '---\nid: TASK-20260101-000002\ncurrent_step: requirement-analysis\n---\n\n# Task\n'
  );
  beginOrResumeOrchestration('TASK-20260101-000002', { repoRoot: f.root });

  const prepared = prepareOrchestrationDelegation('TASK-20260101-000002', {
    client: 'claude-code', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });

  assert.equal(prepared.error?.code, 'ORCHESTRATION_DELEGATION_BUSY');
  assert.equal(prepared.changed, false);
});

test('native stop derives the workspace delta before sealing the unique delegation', () => {
  const f = fixture('requirement-analysis-review');
  const capturedScopes: Array<string | null> = [];
  const captureWorkspace = ({ taskId }: { taskId: string | null }) => {
    capturedScopes.push(taskId);
    return capturedScopes.length === 1 ? 'before-tree' : 'after-tree';
  };
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'reviewer-model', requestedReasoningEffort: 'high'
  }, {
    repoRoot: f.root, captureWorkspace
  });
  activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-stop',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'reviewer-model', actualReasoningEffort: 'high'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'claude-code'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-stop'
  }, {
    repoRoot: f.root,
    captureWorkspace,
    diffWorkspace: () => [
      '.agents/workspace/active/TASK-20260101-000001/review-analysis.md',
      '.agents/workspace/active/TASK-20260101-000001/task.md',
      '.agents/workspace/active/TASK-20260101-000001/orchestration.json'
    ]
  });

  assert.equal(stopped.status, 'running');
  assert.equal(stopped.run?.pendingDelegation?.status, 'sealed');
  assert.equal(stopped.run?.pendingDelegation?.afterFingerprint, 'after-tree');
  assert.deepEqual(capturedScopes, ['TASK-20260101-000001', 'TASK-20260101-000001']);
});

test('native stop preserves legacy snapshot scope for an old pending receipt', () => {
  const f = fixture('requirement-analysis-review');
  const capturedScopes: Array<string | null> = [];
  const captureWorkspace = ({ taskId }: { taskId: string | null }) => {
    capturedScopes.push(taskId);
    return capturedScopes.length === 1 ? 'before-tree' : 'after-tree';
  };
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'reviewer-model', requestedReasoningEffort: 'high'
  }, {
    repoRoot: f.root, captureWorkspace
  });
  const runPath = path.join(f.taskDir, 'orchestration.json');
  const persisted = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  delete persisted.pendingDelegation.workspaceSnapshotScope;
  fs.writeFileSync(runPath, `${JSON.stringify(persisted, null, 2)}\n`);
  activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-legacy',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'reviewer-model', actualReasoningEffort: 'high'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'claude-code'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-legacy'
  }, {
    repoRoot: f.root,
    captureWorkspace,
    diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000001/review-analysis.md']
  });

  assert.equal(stopped.status, 'running');
  assert.equal(stopped.run?.pendingDelegation?.status, 'sealed');
  assert.deepEqual(capturedScopes, ['TASK-20260101-000001', null]);
});

test('reviewer snapshot shape mismatch fails closed to a recoverable pause', () => {
  const f = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(f.taskDir, 'analysis.md'), '# Analysis\n');
  beginOrResumeOrchestration('TASK-20260101-000001', { repoRoot: f.root });
  prepareOrchestrationDelegation('TASK-20260101-000001', {
    client: 'claude-code', requestedModel: 'reviewer-model', requestedReasoningEffort: 'high'
  }, {
    repoRoot: f.root, captureWorkspace: snapshot
  });
  activateMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-rollback',
    parentId: 'parent-session', spawnMode: 'fresh', actualModel: 'reviewer-model', actualReasoningEffort: 'high'
  }, { repoRoot: f.root });
  completeOrchestrationStage('TASK-20260101-000001', {
    stage: 'review-analysis', round: 1, artifact: 'review-analysis.md', agent: 'claude-code'
  }, { repoRoot: f.root });

  const stopped = sealMatchingOrchestrationDelegation('claude-code', {
    nativeAgent: 'agent-infra-lifecycle-reviewer', childId: 'child-rollback'
  }, {
    repoRoot: f.root,
    captureWorkspace: () => 'legacy-after-tree',
    diffWorkspace: () => ['.agents/workspace/active/TASK-20260101-000002/analysis.md']
  });

  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.run?.pause?.code, 'DELEGATION_REVIEWER_WRITE_FORBIDDEN');
  assert.equal(stopped.run?.pause?.recoverable, true);
});
