import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLifecycleFacts, canStart, recommendNext, type ExplicitTrigger, type LifecycleAction, type LifecycleFacts } from '../../../lib/task/capabilities.ts';
import { invalidationMutation, createInvalidationOperation, targetIdFor, type InvalidationTarget } from '../../../lib/task/invalidation.ts';
import { buildQualificationAudit, renderQualificationAudit } from '../../../lib/task/qualification-audit.ts';
import { upsertSection } from '../../../lib/task/sections.ts';

const trigger: ExplicitTrigger = {
  initiator: 'model', requestId: 'request-1', requestedAction: 'analysis',
  reasonCode: 'upstream-fact-doubt'
};

function facts(currentStep: string): LifecycleFacts {
  return {
    taskState: 'active', currentStep, artifacts: {
      analysis: [], 'review-analysis': [], plan: [], 'review-plan': [], code: [], 'review-code': []
    }, artifactHashes: {}, reviews: {}, invalidation: { operations: [], targets: [] },
    reworkIntents: [],
    unresolvedLedger: { analysis: 0, plan: 0, code: 0 }, executionBusy: false
  };
}

function qualificationTask() {
  return `---\nid: TASK-20260101-000001\nstatus: active\ncurrent_step: requirement-analysis\n---\n\n# Task\n\n## \u7ea6\u675f\n\n| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| C-1 | Keep recovery bounded | derived | task-input | task.md | task.md#\u7ea6\u675f |  |  |\n\n## \u5019\u9009\u4e0e\u5426\u51b3\u65b9\u6848\n\n| candidate_id | statement | status | constraint_ids | impact | evidence |\n| --- | --- | --- | --- | --- | --- |\n| A | Rebuild the earliest stale stage | qualified | C-1 | bounded recovery | task.md#\u5019\u9009\u4e0e\u5426\u51b3\u65b9\u6848 |\n`;
}

test('explicit trigger authorization does not depend on current_step', () => {
  const first = canStart('analysis', facts('requirement-analysis'), trigger);
  const second = canStart('analysis', facts('completed'), trigger);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
});

test('recommendation facts cannot bypass a missing prerequisite', () => {
  const result = canStart('review-analysis', facts('requirement-analysis'), {
    ...trigger, requestedAction: 'review-analysis', reasonCode: 'user-request'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'ANALYSIS_ARTIFACT_REQUIRED');
});

test('pending invalidation blocks lifecycle authorization', () => {
  const result = canStart('analysis', {
    ...facts('code'), invalidation: {
      operations: [{ status: 'pending' } as never], targets: []
    }
  }, trigger);
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'INVALIDATION_INCOMPLETE');
});

test('lifecycle facts derive execution busy from an open lifecycle activity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-execution-'));
  try {
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    const open = [
      '---',
      'id: TASK-20260101-000001',
      'status: active',
      'current_step: requirement-analysis-review',
      '---',
      '',
      '# Task',
      '',
      '## Activity Log',
      '',
      '- 2026-01-01 00:00:00+00:00 — **Plan Task (Round 1) [started]** by codex — started',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(taskDir, 'task.md'), open);

    const busy = buildLifecycleFacts(taskDir, open, 'active');
    assert.equal(busy.ok, true);
    if (!busy.ok) return;
    assert.equal(busy.facts.executionBusy, true);

    const manualOpen = open.replace('Plan Task (Round 1)', 'Complete Manual Validation');
    fs.writeFileSync(path.join(taskDir, 'task.md'), manualOpen);
    const manualBusy = buildLifecycleFacts(taskDir, manualOpen, 'active');
    assert.equal(manualBusy.ok, true);
    if (!manualBusy.ok) return;
    assert.equal(manualBusy.facts.executionBusy, true);

    const completed = `${open}- 2026-01-01 00:01:00+00:00 — **Plan Task (Round 1)** by codex — Plan completed → plan.md\n`;
    fs.writeFileSync(path.join(taskDir, 'task.md'), completed);
    const idle = buildLifecycleFacts(taskDir, completed, 'active');
    assert.equal(idle.ok, true);
    if (!idle.ok) return;
    assert.equal(idle.facts.executionBusy, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution busy fact blocks capability authorization', () => {
  const result = canStart('analysis', { ...facts('code'), executionBusy: true }, trigger);
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'EXECUTION_BUSY');
});

test('recommendation is derived from lifecycle facts rather than current_step', () => {
  const first = recommendNext(facts('completed'));
  assert.equal(first.action, 'analysis');
  const withAnalysis = {
    ...facts('code-review'),
    artifacts: { ...facts('code-review').artifacts, analysis: ['analysis.md'] }
  };
  assert.equal(recommendNext(withAnalysis).action, 'review-analysis');
});

test('qualification recovery routes to the earliest stale stage and only authorizes that stage', () => {
  const stale = {
    ...facts('code'),
    artifacts: {
      analysis: ['analysis.md'], 'review-analysis': ['review-analysis.md'],
      plan: ['plan.md'], 'review-plan': ['review-plan.md'],
      code: ['code.md'], 'review-code': []
    },
    qualificationStale: true,
    qualificationStaleArtifacts: ['review-plan.md', 'analysis.md']
  } satisfies LifecycleFacts;

  const recommendation = recommendNext(stale);
  assert.equal(recommendation.action, 'analysis');
  assert.equal(recommendation.reasonCode, 'QUALIFICATION_RECOVERY_REQUIRED');

  const recoveryFacts = { ...stale, recommendedAction: recommendation.action };
  assert.equal(canStart('analysis', recoveryFacts, trigger).allowed, true);
  const busy = canStart('analysis', { ...recoveryFacts, executionBusy: true }, trigger);
  assert.equal(busy.allowed, false);
  assert.equal(busy.reasonCode, 'EXECUTION_BUSY');
  const skipped = canStart('review-code', recoveryFacts, { ...trigger, requestedAction: 'review-code' });
  assert.equal(skipped.allowed, false);
  assert.equal(skipped.reasonCode, 'QUALIFICATION_STALE');
});

test('qualification recovery only evaluates the latest active artifact in each family', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-qualification-latest-'));
  try {
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    const content = qualificationTask();
    fs.writeFileSync(path.join(taskDir, 'task.md'), content);
    fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# legacy analysis\n');
    const built = buildQualificationAudit(content);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    fs.writeFileSync(path.join(taskDir, 'analysis-r2.md'), `# Current analysis\n\n## \u8d44\u683c\u5ba1\u8ba1\n\n${renderQualificationAudit(built.audit)}\n`);

    const result = buildLifecycleFacts(taskDir, content, 'active');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.facts.qualificationStale, false);
    assert.deepEqual(result.facts.qualificationStaleArtifacts, []);
    assert.equal(recommendNext(result.facts).action, 'review-analysis');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit source provenance requires a matching artifact hash', () => {
  const result = canStart('analysis', {
    ...facts('completed'), artifactHashes: { 'review-code.md': 'a'.repeat(64) }
  }, {
    ...trigger, sourceArtifact: 'review-code.md', sourceSha256: 'b'.repeat(64)
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'SOURCE_ARTIFACT_HASH_MISMATCH');
});

test('approved reviews without latest input bindings cannot authorize downstream actions', () => {
  const stale = {
    ...facts('code-review'),
    artifacts: {
      analysis: ['analysis.md'], 'review-analysis': ['review-analysis.md'],
      plan: ['plan.md'], 'review-plan': ['review-plan.md'],
      code: ['code.md'], 'review-code': ['review-code.md']
    },
    reviews: {
      'review-analysis': 'approved', 'review-plan': 'approved', 'review-code': 'approved'
    } as LifecycleFacts['reviews'],
    reviewedInputs: {}
  } satisfies LifecycleFacts;

  const cases: Array<{ action: LifecycleAction; trigger: ExplicitTrigger; reasonCode: string }> = [
    {
      action: 'plan',
      trigger: { ...trigger, requestedAction: 'plan' },
      reasonCode: 'ANALYSIS_REVIEW_NOT_LATEST'
    },
    {
      action: 'code',
      trigger: { ...trigger, requestedAction: 'code' },
      reasonCode: 'PLAN_REVIEW_NOT_LATEST'
    },
    {
      action: 'code',
      trigger: { ...trigger, requestedAction: 'code', implementationInput: 'II-1' },
      reasonCode: 'CODE_REVIEW_NOT_LATEST'
    },
    {
      action: 'manual-validation',
      trigger: { ...trigger, requestedAction: 'manual-validation' },
      reasonCode: 'CODE_REVIEW_NOT_LATEST'
    },
    {
      action: 'validation-run',
      trigger: { ...trigger, requestedAction: 'validation-run' },
      reasonCode: 'CODE_REVIEW_NOT_LATEST'
    }
  ];

  for (const { action, trigger: actionTrigger, reasonCode } of cases) {
    const result = canStart(action, stale, actionTrigger);
    assert.equal(result.allowed, false, `${action} should reject a stale approval`);
    assert.equal(result.reasonCode, reasonCode);
  }
});

test('completed invalidation removes stale review approvals from lifecycle facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-invalidation-'));
  try {
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    const taskPath = path.join(taskDir, 'task.md');
    let content = '---\nid: TASK-20260101-000001\nstatus: active\ncurrent_step: code-review\n---\n\n# Task\n';
    for (const [name, value] of [
      ['analysis.md', '# Analysis\n'],
      ['review-analysis.md', '# Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n'],
      ['plan.md', '# Plan\n'],
      ['review-plan.md', '# Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n']
    ] as const) {
      fs.writeFileSync(path.join(taskDir, name), value);
    }
    const source = {
      sourceFamily: 'analysis', sourceArtifact: 'analysis-r2.md', sourceRound: 2,
      sourceSha256: 'a'.repeat(64), createdAt: '2026-01-01 00:00:00+00:00', updatedAt: '2026-01-01 00:00:00+00:00'
    };
    const operation = createInvalidationOperation(source);
    const targetShape = {
      targetKind: 'artifact' as const, targetFamily: 'review-plan', targetArtifact: 'review-plan.md', targetRound: 1,
      targetSha256: 'b'.repeat(64)
    };
    const target: InvalidationTarget = {
      ...targetShape, targetId: targetIdFor(operation.operationId, targetShape), operationId: operation.operationId,
      status: 'completed', reasonCode: 'upstream-replaced', updatedAt: source.updatedAt
    };
    content = upsertSection(content, invalidationMutation(content, {
      operations: [{ ...operation, status: 'completed', processed: 1, total: 1, completedAt: source.updatedAt }],
      targets: [target]
    })).content;
    fs.writeFileSync(taskPath, content);

    const result = buildLifecycleFacts(taskDir, content, 'active');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.facts.artifacts['review-plan'], []);
    assert.equal(result.facts.reviews['review-plan'], undefined);
    assert.equal(canStart('code', result.facts, { ...trigger, requestedAction: 'code' }).reasonCode, 'PLAN_REVIEW_REQUIRED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
