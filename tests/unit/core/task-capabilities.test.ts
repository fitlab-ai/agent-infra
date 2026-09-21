import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { buildLifecycleFacts, canStart, recommendNext, type ExplicitTrigger, type LifecycleAction, type LifecycleFacts } from '../../../lib/task/capabilities.ts';
import { sha256File } from '../../../lib/task/artifact-receipts.ts';
import { invalidationMutation, createInvalidationOperation, targetIdFor, type InvalidationTarget } from '../../../lib/task/invalidation.ts';
import { buildQualificationAudit, renderQualificationAudit } from '../../../lib/task/qualification-audit.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import { parseLifecyclePathDecision } from '../../../lib/task/lifecycle-path.ts';

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

function pathState(path: '精简路径' | '标准路径' | '完整路径') {
  return parseLifecyclePathDecision(`# Analysis\n\n## 流程裁定\n\n- **本任务路径**：${path}。\n- **判定依据**：事实充分。\n- **未满足的更高路径条件**：没有更高路径事实。\n- **升级触发条件**：出现真实外部边界。\n`);
}

test('selected lifecycle path controls authorization without removing code review', () => {
  const streamlined = { ...facts('code'), pathState: pathState('精简路径'), artifacts: { ...facts('code').artifacts, analysis: ['analysis.md'] } };
  assert.equal(canStart('code', streamlined, { ...trigger, requestedAction: 'code' }).allowed, true);
  assert.equal(canStart('plan', streamlined, { ...trigger, requestedAction: 'plan' }).reasonCode, 'ARTIFACT_STAGE_NOT_SELECTED');
  assert.equal(recommendNext(streamlined).action, 'code');

  const standard = { ...facts('code'), pathState: pathState('标准路径'), artifacts: { ...facts('code').artifacts, analysis: ['analysis.md'], plan: ['plan.md'] } };
  assert.equal(canStart('code', standard, { ...trigger, requestedAction: 'code' }).allowed, true);
  assert.equal(canStart('review-plan', standard, { ...trigger, requestedAction: 'review-plan' }).reasonCode, 'ARTIFACT_STAGE_NOT_SELECTED');

  const invalid = { ...facts('plan'), pathState: { status: 'invalid' as const, decision: null, message: 'bad flow decision' } };
  assert.equal(canStart('analysis', invalid, trigger).allowed, true);
  assert.equal(canStart('code', invalid, { ...trigger, requestedAction: 'code' }).reasonCode, 'LIFECYCLE_PATH_INVALID');
});

test('pending rework pauses authorization except for an explicit new requirement', () => {
  const paused = {
    ...facts('code'),
    reworkIntents: [{
      intentId: 'RI-1', findingId: 'CD-1', sourceArtifact: 'review-code.md', sourceSha256: 'a'.repeat(64),
      target: 'pause' as const, classification: 'insufficient-evidence' as const,
      evidenceDigest: 'b'.repeat(64), taskFactDigest: 'c'.repeat(64), status: 'pending' as const,
      declaredAt: '2026-01-01T00:00:00.000Z', consumedAt: ''
    }]
  };
  assert.equal(canStart('code', paused, { ...trigger, requestedAction: 'code' }).reasonCode, 'REWORK_PAUSED');
  assert.equal(canStart('analysis', paused, trigger).reasonCode, 'REWORK_PAUSED');
  assert.equal(canStart('analysis', paused, { ...trigger, reasonCode: 'new-requirement' }).allowed, true);
});

test('streamlined design rework routes through analysis before plan', () => {
  const routed = {
    ...facts('code'),
    pathState: pathState('精简路径'),
    artifacts: { ...facts('code').artifacts, analysis: ['analysis.md'], code: ['code.md'], 'review-code': ['review-code.md'] },
    reworkIntents: [{
      intentId: 'RI-1', findingId: 'CD-1', sourceArtifact: 'review-code.md', sourceSha256: 'a'.repeat(64),
      target: 'plan' as const, classification: 'design' as const,
      evidenceDigest: 'b'.repeat(64), taskFactDigest: 'c'.repeat(64), status: 'pending' as const,
      declaredAt: '2026-01-01T00:00:00.000Z', consumedAt: ''
    }]
  } satisfies LifecycleFacts;

  assert.deepEqual(recommendNext(routed), {
    action: 'analysis', reasonCode: 'REWORK_INTENT_PENDING', evidence: ['RI-1', 'CD-1']
  });
  assert.equal(canStart('analysis', routed, { ...trigger, requestedAction: 'analysis', reasonCode: 'review-finding' }).allowed, true);
  assert.equal(canStart('plan', routed, { ...trigger, requestedAction: 'plan', reasonCode: 'review-finding' }).reasonCode, 'REWORK_INTENT_TARGET_MISMATCH');

  const standard = { ...routed, pathState: pathState('标准路径') } satisfies LifecycleFacts;
  assert.equal(recommendNext(standard).action, 'plan');
  assert.equal(canStart('plan', standard, { ...trigger, requestedAction: 'plan', reasonCode: 'review-finding' }).allowed, true);
});

test('resolved human decisions route every stage back to review and code decisions honor implementation intent', () => {
  for (const stage of ['analysis', 'plan', 'code'] as const) {
    const review = `review-${stage}` as 'review-analysis' | 'review-plan' | 'review-code';
    const state = {
      ...facts(stage), pathState: pathState('完整路径'),
      artifacts: {
        analysis: ['analysis.md'], 'review-analysis': ['review-analysis.md'],
        plan: ['plan.md'], 'review-plan': ['review-plan.md'], code: ['code.md'], 'review-code': ['review-code.md']
      },
      reviewedInputs: { 'review-analysis': 'analysis.md', 'review-plan': 'plan.md', 'review-code': 'code.md' },
      reviews: {
        'review-analysis': stage === 'analysis' ? 'changes-requested' : 'approved',
        'review-plan': stage === 'plan' ? 'changes-requested' : 'approved',
        'review-code': stage === 'code' ? 'changes-requested' : 'approved'
      },
      resolvedHumanDecisions: { [stage]: 'review' as const }
    } satisfies LifecycleFacts;
    assert.equal(recommendNext(state).action, review, stage);
  }
  const implementation = {
    ...facts('code'), pathState: pathState('完整路径'),
    artifacts: {
      analysis: ['analysis.md'], 'review-analysis': ['review-analysis.md'],
      plan: ['plan.md'], 'review-plan': ['review-plan.md'], code: ['code.md'], 'review-code': ['review-code.md']
    },
    reviewedInputs: { 'review-analysis': 'analysis.md', 'review-plan': 'plan.md', 'review-code': 'code.md' },
    reviews: { 'review-analysis': 'approved', 'review-plan': 'approved', 'review-code': 'changes-requested' },
    resolvedHumanDecisions: { code: 'implementation' as const }
  } satisfies LifecycleFacts;
  assert.equal(recommendNext(implementation).action, 'code');
  assert.equal(canStart('code', implementation, {
    ...trigger, requestedAction: 'code', implementationInput: 'II-1'
  }).allowed, true);
});

test('rework classification uses ordered completed review cycles and ignores an approved boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-rework-cycles-'));
  try {
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    const analysis = '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：完整路径。\n- **判定依据**：需审查。\n- **未满足的更高路径条件**：无。\n- **升级触发条件**：无。\n';
    fs.writeFileSync(path.join(taskDir, 'analysis.md'), analysis);
    const rows: string[] = [];
    for (const round of [1, 2, 3]) {
      const input = round === 1 ? 'code.md' : `code-r${round}.md`;
      const output = round === 1 ? 'review-code.md' : `review-code-r${round}.md`;
      fs.writeFileSync(path.join(taskDir, input), `# Code ${round}\n`);
      fs.writeFileSync(path.join(taskDir, output), `# Review\n\n- **审查输入**：\`${input}\`\n\n## 审查摘要\n\n- **总体结论**：${round === 2 ? '通过' : '需要修改'}\n- **发现（AI 可处理）**：1 阻塞项，0 主要，0 次要 / **人工校验**：0\n`);
      const hash = createHash('sha256').update(fs.readFileSync(path.join(taskDir, input))).digest('hex');
      rows.unshift(`| review-code.completed | ${output} | ${input} | ${hash} | 2026-01-0${round} 00:00:00+00:00 |`);
    }
    let content = `---\nid: TASK-20260101-000001\nstatus: active\n---\n# Task\n\n## 产物生命周期收据\n\n| event | output | input | input_sha256 | completed_at |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
    fs.writeFileSync(path.join(taskDir, 'task.md'), content);
    let result = buildLifecycleFacts(taskDir, content);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.facts.reworkClassificationRequired, []);

    const approved = fs.readFileSync(path.join(taskDir, 'review-code-r2.md'), 'utf8').replace('通过', '需要修改');
    fs.writeFileSync(path.join(taskDir, 'review-code-r2.md'), approved);
    result = buildLifecycleFacts(taskDir, content);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.facts.reworkClassificationRequired, ['code']);

    const latestHash = createHash('sha256').update(fs.readFileSync(path.join(taskDir, 'review-code-r3.md'))).digest('hex');
    content += `\n## 返工意图\n\n| intent_id | finding_id | source_artifact | source_sha256 | target | classification | evidence_digest | task_fact_digest | status | declared_at | consumed_at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| RI-1 | CD-1 | review-code-r3.md | ${latestHash} | code | implementation | ${'a'.repeat(64)} | ${'b'.repeat(64)} | consumed | 2026-01-03T00:00:00.000Z | 2026-01-03T01:00:00.000Z |\n`;
    fs.writeFileSync(path.join(taskDir, 'task.md'), content);
    result = buildLifecycleFacts(taskDir, content);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.facts.reworkClassificationRequired, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test('pending invalidation blocks lifecycle authorization but preserves the logical next action', () => {
  const pending = {
    ...facts('code'), invalidation: {
      operations: [{ status: 'pending' } as never], targets: []
    }
  };
  const result = canStart('analysis', pending, trigger);
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'INVALIDATION_INCOMPLETE');
  assert.equal(recommendNext(pending).action, 'analysis');
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

test('invalidated review history does not require rework classification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-invalidated-rework-'));
  try {
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：精简路径。\n- **判定依据**：边界明确。\n- **未满足的更高路径条件**：无需额外设计。\n- **升级触发条件**：范围变化。\n');
    const receipts: string[] = [];
    const names = [
      { input: 'code.md', output: 'review-code.md', round: 1 },
      { input: 'code-r2.md', output: 'review-code-r2.md', round: 2 }
    ] as const;
    for (const { input, output, round } of names) {
      fs.writeFileSync(path.join(taskDir, input), `# Code ${round}\n`);
      fs.writeFileSync(path.join(taskDir, output), `# Review\n\n- **审查输入**：\`${input}\`\n\n## 审查摘要\n\n- **总体结论**：需要修改\n- **发现（AI 可处理）**：0 阻塞项，1 主要，0 次要 / **人工校验**：0\n`);
      const inputHash = createHash('sha256').update(fs.readFileSync(path.join(taskDir, input))).digest('hex');
      receipts.push(`| review-code.completed | ${output} | ${input} | ${inputHash} | 2026-01-0${round} 00:00:00+00:00 |`);
    }
    let content = `---\nid: TASK-20260101-000001\nstatus: active\n---\n# Task\n\n## 产物生命周期收据\n\n| event | output | input | input_sha256 | completed_at |\n| --- | --- | --- | --- | --- |\n${receipts.join('\n')}\n`;
    const source = {
      sourceFamily: 'analysis', sourceArtifact: 'analysis-r2.md', sourceRound: 2,
      sourceSha256: 'a'.repeat(64), createdAt: '2026-01-03 00:00:00+00:00', updatedAt: '2026-01-03 00:00:00+00:00'
    };
    const operation = createInvalidationOperation(source);
    const targets = names.flatMap(({ input, output, round }) => [
      { targetKind: 'artifact' as const, targetFamily: 'code', targetArtifact: input, targetRound: round },
      { targetKind: 'artifact' as const, targetFamily: 'review-code', targetArtifact: output, targetRound: round }
    ]).map((shape) => {
      const targetShape = {
        ...shape,
        targetSha256: createHash('sha256').update(fs.readFileSync(path.join(taskDir, shape.targetArtifact))).digest('hex')
      };
      return {
        ...targetShape, targetId: targetIdFor(operation.operationId, targetShape), operationId: operation.operationId,
        status: 'completed' as const, reasonCode: 'upstream-replaced', updatedAt: source.updatedAt
      };
    });
    content = upsertSection(content, invalidationMutation(content, {
      operations: [{ ...operation, status: 'completed', processed: targets.length, total: targets.length, completedAt: source.updatedAt }],
      targets
    })).content;
    fs.writeFileSync(path.join(taskDir, 'task.md'), content);

    const result = buildLifecycleFacts(taskDir, content, 'active');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.facts.artifacts.code, []);
    assert.deepEqual(result.facts.artifacts['review-code'], []);
    assert.deepEqual(result.facts.reworkClassificationRequired, []);
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
    fs.writeFileSync(path.join(taskDir, 'analysis-r2.md'), `# Current analysis\n\n## 流程裁定\n\n- **本任务路径**：完整路径。\n- **判定依据**：需要独立审查。\n- **未满足的更高路径条件**：已选最高路径。\n- **升级触发条件**：无。\n\n## \u8d44\u683c\u5ba1\u8ba1\n\n${renderQualificationAudit(built.audit)}\n`);

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

test('lifecycle facts use completed review receipts rather than review body formatting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-review-receipt-'));
  try {
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    const artifacts = {
      'analysis.md': '# Analysis\n',
      'review-analysis.md': '# Review\n\n- **审查输入**：analysis.md\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n',
      'plan.md': '# Plan\n',
      'review-plan.md': '# Review\n\n- **审查输入**：plan.md\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n',
      'code.md': '# Code\n',
      'review-code.md': '# Review\n\n- **审查输入**：code.md\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n'
    };
    for (const [name, value] of Object.entries(artifacts)) fs.writeFileSync(path.join(taskDir, name), value);
    const receipt = (event: string, output: string, input: string) =>
      `| ${event} | ${output} | ${input} | ${sha256File(path.join(taskDir, input))} | 2026-01-01 00:00:00+00:00 |`;
    const content = [
      '---', 'id: TASK-20260101-000001', 'status: active', 'current_step: code-review', '---', '', '# Task', '',
      '## 产物生命周期收据', '',
      '| event | output | input | input_sha256 | completed_at |',
      '| --- | --- | --- | --- | --- |',
      receipt('review-analysis.completed', 'review-analysis.md', 'analysis.md'),
      receipt('review-plan.completed', 'review-plan.md', 'plan.md'),
      receipt('review-code.completed', 'review-code.md', 'code.md'),
      '', '## Activity Log', ''
    ].join('\n');
    fs.writeFileSync(path.join(taskDir, 'task.md'), content);

    const result = buildLifecycleFacts(taskDir, content, 'active');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.facts.reviewedInputs, {
      'review-analysis': 'analysis.md', 'review-plan': 'plan.md', 'review-code': 'code.md'
    });
    assert.equal(canStart('plan', result.facts, { ...trigger, requestedAction: 'plan' }).allowed, true);
    assert.equal(canStart('code', result.facts, { ...trigger, requestedAction: 'code' }).allowed, true);
    assert.equal(canStart('manual-validation', result.facts, { ...trigger, requestedAction: 'manual-validation' }).allowed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
      ['analysis.md', '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：完整路径。\n- **判定依据**：需要独立审查。\n- **未满足的更高路径条件**：已选最高路径。\n- **升级触发条件**：无。\n'],
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
