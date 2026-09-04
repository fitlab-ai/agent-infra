import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, onPlatforms, sandboxControlSafeEnv } from '../../helpers.ts';
import { applyTaskEvent } from '../../../lib/task/events.ts';
import { prepareOrchestrationDelegation } from '../../../lib/task/orchestration.ts';
import { upsertArtifactReceipt, type ArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import {
  finalizeLocalArtifact,
  validateLocalArtifact,
  type LocalArtifactFamily
} from '../../../lib/task/local-artifact-finalization.ts';
import { parseInvalidationDocument } from '../../../lib/task/invalidation.ts';

function fixture(step = 'requirement-analysis-review') {
  const explicitStep = arguments.length > 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-event-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nstatus: active\ncurrent_step: ${step}\nassigned_to: claude\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.9.11-alpha.0\n---\n\n# Task\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), '# Analysis\n');
  if ((!explicitStep && step === 'requirement-analysis-review') || step === 'commit') {
    fs.writeFileSync(path.join(dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md'));
  }
  if (step === 'code-review' || step === 'commit') {
    fs.writeFileSync(path.join(dir, 'review-code.md'), reviewCodeArtifact());
  }
  return { root, id, dir, file: path.join(dir, 'task.md') };
}

function orchestrationReceipt(taskId: string, overrides: Record<string, unknown> = {}) {
  const status = typeof overrides.status === 'string' ? overrides.status : 'activated';
  const lifecycleProvenance = {
    protocolVersion: 3, packageVersion: '0.9.9-alpha.0',
    internalExecutableBuildHash: 'a'.repeat(64), lifecycleContractHash: 'b'.repeat(64),
    hookDefinitionHash: 'hook-hash', hookSource: 'project',
    hookSourcePathDigest: 'c'.repeat(64), hookSourceHash: 'd'.repeat(64),
    capabilitySessionId: 'parent-1', capabilityTurnId: 'parent-turn',
    capabilityToolUseId: 'capability-tool', controllerInstanceDigest: null,
    controlGeneration: null
  } as const;
  const hostEvidence = ['activated', 'stage-completed', 'sealed', 'consumed'].includes(status)
    ? {
        kind: 'codex-lifecycle-v2', hookDefinitionHash: 'hook-hash', startRevision: 4,
        stopRevision: null, consumer: null, consumedAt: null, protocolVersion: 3,
        packageVersion: '0.9.9-alpha.0', internalExecutableBuildHash: 'a'.repeat(64),
        lifecycleContractHash: 'b'.repeat(64), hookSource: 'project',
        hookSourcePathDigest: 'c'.repeat(64), hookSourceHash: 'd'.repeat(64),
        capabilitySessionId: 'parent-1', capabilityTurnId: 'parent-turn',
        spawnToolUseId: 'spawn-tool', spawnObservedAt: '2026-01-01T00:00:01.000Z',
        controllerInstanceDigest: null, controlGeneration: null
      }
    : null;
  return {
    id: 'receipt-1', taskId, runId: 'run-1', role: 'executor', stage: 'plan', round: 1,
    artifact: 'plan.md', client: 'codex', requestedModel: 'executor-model',
    requestedReasoningEffort: 'xhigh', actualModel: 'executor-model', actualReasoningEffort: 'xhigh',
    modelFallbackReason: null, reasoningEffortFallbackReason: null,
    parentId: 'parent-1', childId: 'child-1', spawnMode: 'fresh', agent: null,
    status, workspaceSnapshotScope: 'task', lifecycleProvenance,
    hostEvidence, beforeFingerprint: 'before', afterFingerprint: null, changedPaths: [],
    createdAt: '2026-01-01T00:00:00.000Z', preparedMonotonicMs: 1,
    spawnDispatchMonotonicMs: 2, activationDeadlineMonotonicMs: 3,
    spawnDispatchedAt: '2026-01-01T00:00:00.000Z',
    activationDeadlineAt: '2026-01-01T00:00:15.000Z', startEvidenceMonotonicMs: 2,
    activatedMonotonicMs: 2, activatedAt: '2026-01-01T00:00:01.000Z',
    sealedAt: null, consumedAt: null,
    ...overrides
  };
}

function currentRun(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId, runId: 'run-1', status: 'running', nextStage: 'plan', stepCount: 0, maxSteps: 24,
    modelPolicy: {
      executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
      reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
    },
    modelPolicySource: {
      kind: 'explicit', client: 'codex', resolvedAt: '2026-01-01T00:00:00.000Z'
    },
    recoveryHistory: [], baseline: '', pendingDelegation: null, receipts: [], pause: null,
    commitAuthorization: { issuedAt: null, consumedAt: null }, completionEvidence: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const event = args[1] ?? '';
  const lifecycle = /^(?:analyze|review-analysis|plan|review-plan|code|review-code|manual-validation|validation-run)\.(?:started|completed)$/.test(event);
  const hasTrigger = ['--initiator', '--request-id', '--reason-code'].some((flag) => args.includes(flag));
  const family = event.split('.')[0] ?? 'event';
  const trigger = lifecycle && !hasTrigger
    ? ['--initiator', 'model', '--request-id', `${args[0]}:${family}`, '--reason-code', 'user-request']
    : [];
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', ...args, ...trigger], { cwd: root, encoding: 'utf8', env });
}

function finalizeReview(
  f: ReturnType<typeof fixture>,
  scenario: (typeof reviewScenarios)[number]
) {
  return spawnSync('node', [
    INTERNAL_CLI_PATH, 'task-review', f.id, 'finalize-summary', '--stage', scenario.stage,
    '--artifact', scenario.artifact
  ], { cwd: f.root, encoding: 'utf8' });
}

function inspect(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-artifact', ...args], { cwd: root, encoding: 'utf8' });
}

function reviewCodeArtifact(input = 'code.md') {
  return `# Code Review\n\n- **审查输入**：\`${input}\`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n`;
}

function reviewArtifact(
  title: string,
  input: string,
  verdict = '通过',
  counts: ReviewCounts = { blockers: 0, major: 0, minor: 0 }
) {
  return `# ${title}\n\n- **审查输入**：\`${input}\`\n\n## 审查摘要\n\n- **总体结论**：${verdict}\n- **发现（AI 可处理）**：${counts.blockers} 阻塞项，${counts.major} 主要，${counts.minor} 次要 / **人工校验**：0\n`;
}

function sha256File(filePath: string) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function localArtifact(family: LocalArtifactFamily, suffix = '') {
  const sections = family === 'plan'
    ? [
        ['问题理解', '范围说明'], ['约束条件', '当前契约'], ['方案对比', '采用方案 A'],
        ['技术方法', '实现方法'], ['实施步骤', '步骤一'], ['文件清单', '文件列表'],
        ['验证策略', '验证方法']
      ]
    : family === 'code'
      ? [
          ['实现输入', '本轮实现输入'], ['变更文件', '文件列表'], ['关键代码说明', '实现说明'],
          ['测试结果', '测试通过'], ['与方案的差异', '无'], ['供审查关注的内容', '完成门禁'],
        ]
      : [
          ['需求来源', '用户描述'], ['需求理解', '范围说明'], ['相关文件', '文件列表'],
          ['影响评估', '影响说明'], ['技术风险', '风险说明'], ['工作量和复杂度评估', '复杂度说明']
        ];
  return [
    family === 'plan' ? '# 技术方案' : family === 'code' ? '# 实现报告' : '# 需求分析报告', '',
    ...sections.flatMap(([heading, body]) => [`## ${heading}`, body, '']),
    ...(family === 'code' ? [] : ['## 状态核对']),
    ...(family === 'code' ? ['## 状态核对', '```text', '$ git status -s', '```', '## 证据原文', '验证输出'] : ['```text', '$ git status -s', '```']),
    suffix
  ].join('\n');
}

function completionDigestArgs(dir: string, artifact: string, family: LocalArtifactFamily): string[] {
  const file = path.join(dir, artifact);
  const result = finalizeLocalArtifact({
    taskRef: path.basename(dir),
    repoRoot: path.resolve(dir, '../../../..'),
    family,
    artifact
  });
  assert.equal(result.status, 'passed', result.error?.message);
  return ['--artifact-sha256', result.artifactSha256!, '--semantic-digest', result.semanticDigest!];
}

function addReceipt(file: string, receipt: ArtifactReceipt) {
  const content = fs.readFileSync(file, 'utf8');
  const mutation = upsertArtifactReceipt(content, receipt);
  fs.writeFileSync(file, upsertSection(content, mutation).content);
}

function codeReport(plan = 'plan.md') {
  return localArtifact('code').replace('本轮实现输入', `- **模式**：init\n- **方案输入**：\`${plan}\`\n- **审查输入**：\`N/A\`\n- **裁决输入**：N/A\n- **账本 ID**：N/A\n- **裁决证据**：N/A\n- **需求摘要**：完成实现报告门禁\n`);
}

type ReviewCounts = { blockers: number; major: number; minor: number };

const reviewScenarios = [
  {
    family: 'review-analysis', stage: 'analysis', step: 'requirement-analysis-review',
    input: 'analysis.md', artifact: 'review-analysis.md', title: 'Analysis Review', findingId: 'AN-1'
  },
  {
    family: 'review-plan', stage: 'plan', step: 'technical-design-review',
    input: 'plan.md', artifact: 'review-plan.md', title: 'Plan Review', findingId: 'PL-1'
  },
  {
    family: 'review-code', stage: 'code', step: 'code',
    input: 'code.md', artifact: 'review-code.md', title: 'Code Review', findingId: 'CD-1'
  }
] as const;

function setLedger(file: string, rows: string[]) {
  const content = fs.readFileSync(file, 'utf8');
  const ledger = [
    '## Review Disagreement Ledger',
    '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|',
    ...rows,
    ''
  ].join('\n');
  const existing = /## Review Disagreement Ledger\n\n\| id \| stage \| round \| severity \| status \| evidence \|\n\|----\|-------\|-------\|----------\|--------\|----------\|\n[\s\S]*?(?=## Activity Log)/;
  fs.writeFileSync(file, content.replace(existing, ledger));
}

function prepareReview(
  scenario: (typeof reviewScenarios)[number],
  rows: string[],
  verdict = '通过',
  counts: ReviewCounts = { blockers: 0, major: 0, minor: 0 }
) {
  const f = fixture(scenario.step);
  fs.writeFileSync(path.join(f.dir, scenario.input), `# ${scenario.input}\n`);
  setLedger(f.file, rows);
  const started = run(f.root, [f.id, `${scenario.family}.started`, '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(
    path.join(f.dir, scenario.artifact),
    reviewArtifact(scenario.title, scenario.input, verdict, counts)
  );
  return f;
}

function completeReview(
  f: ReturnType<typeof fixture>,
  scenario: (typeof reviewScenarios)[number],
  verdict: 'approved' | 'changes-requested' | 'rejected',
  counts: ReviewCounts,
  extra: string[] = []
) {
  return run(f.root, [
    f.id, `${scenario.family}.completed`, '--agent', 'codex', '--artifact', scenario.artifact,
    '--verdict', verdict, '--blockers', String(counts.blockers), '--major', String(counts.major),
    '--minor', String(counts.minor), '--manual-validation', '0', ...extra
  ]);
}

function decisionFixture() {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), `## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n`);
  fs.writeFileSync(f.file, `---
id: ${f.id}
status: active
current_step: code-review
assigned_to: claude
updated_at: 2026-07-18 10:02:00+08:00
agent_infra_version: v0.9.11-alpha.0
last_reviewed_commit: abcdef1234567890
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 实现备注

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|
| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:59:00+08:00 | pending | |

## 产物生命周期收据

| event | output | input | input_sha256 | completed_at |
|-------|--------|-------|--------------|--------------|
| code.completed | code.md | plan.md | ${sha256File(path.join(f.dir, 'plan.md'))} | 2026-07-18 09:58:00+08:00 |

## Activity Log

- 2026-07-18 10:00:00+08:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md
`);
  return f;
}

test('internal task-event rejects a non-standard --agent token', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.started', '--agent', 'devuser']);
  assert.equal(out.status, 1);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EVENT_PAYLOAD_INVALID');
  assert.match(result.error.message, /invalid --agent 'devuser'/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('internal task-event normalizes a long --agent to the short token on write', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'claude-code']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /by claude — started/);
  assert.match(content, /assigned_to: claude/);
});

test('internal task-event accepts the human manual-executor token', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'human']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  assert.match(fs.readFileSync(f.file, 'utf8'), /by human — started/);
});

test('internal task-event consumes a producer-qualified override under one task lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-event-override-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000002';
  const dir = path.join(root, '.agents', 'workspace', 'blocked', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nstatus: blocked\ncurrent_step: requirement-analysis-review\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.0.0\n---\n\n# Task\n\n## Activity Log\n\n`);
  try {
    const issued = spawnSync('node', [INTERNAL_CLI_PATH, 'task-override', id, 'issue',
      '--failure-id', 'task-event:TASK_STATE_MISMATCH', '--target', 'continue-local',
      '--operator', 'codex', '--reason', 'operator approved local event recovery',
      '--scope', 'task-event', '--expires-at', '2099-01-01 00:00:00+00:00'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(issued.status, 0, issued.stderr || issued.stdout);
    const ticket = (JSON.parse(issued.stdout) as { ticketId: string }).ticketId;
    const applied = spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', id, 'analyze.started',
      '--agent', 'codex', '--initiator', 'model', '--request-id', `override:${id}:analyze`, '--reason-code', 'user-request',
      '--override-ticket', ticket, '--override-target', 'continue-local', '--override-scope', 'task-event'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const result = JSON.parse(applied.stdout) as { status: string; humanOverride: { status: string } };
    assert.equal(result.status, 'applied');
    assert.equal(result.humanOverride.status, 'applied');
    assert.match(fs.readFileSync(path.join(dir, 'task.md'), 'utf8'), new RegExp(`\\| ${ticket} \\|.*\\| consumed \\|`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-event rejects combining dry-run with an override before any task mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-event-override-dry-run-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000003';
  const dir = path.join(root, '.agents', 'workspace', 'blocked', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nstatus: blocked\ncurrent_step: requirement-analysis-review\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.0.0\n---\n\n# Task\n\n## Activity Log\n\n`);
  try {
    const issued = spawnSync('node', [INTERNAL_CLI_PATH, 'task-override', id, 'issue',
      '--failure-id', 'task-event:TASK_STATE_MISMATCH', '--target', 'continue-local',
      '--operator', 'codex', '--reason', 'verify dry-run does not consume',
      '--scope', 'task-event', '--expires-at', '2099-01-01 00:00:00+00:00'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(issued.status, 0, issued.stderr || issued.stdout);
    const ticket = (JSON.parse(issued.stdout) as { ticketId: string }).ticketId;
    const beforeRetry = fs.readFileSync(path.join(dir, 'task.md'));
    const retried = spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', id, 'analyze.started',
      '--agent', 'codex', '--dry-run', '--override-ticket', ticket,
      '--override-target', 'continue-local', '--override-scope', 'task-event'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(retried.status, 1, retried.stderr || retried.stdout);
    const result = JSON.parse(retried.stdout) as { status: string; error: { code: string } };
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'EVENT_PAYLOAD_INVALID');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'task.md')), beforeRetry);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('internal task-event applies a started/completed pair and replays as no-op', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan')]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).toStep, 'technical-design');
  const intentPath = path.join(f.root, '.agents', 'workspace', '.local-artifact-finalization-intents', `${f.id}-plan-plan.md.json`);
  assert.equal(JSON.parse(fs.readFileSync(intentPath, 'utf8')).state, 'consumed');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /`plan\.md`/);
});

test('task-event rejects a different lifecycle start while one execution is open', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);

  const beforeBlocked = fs.readFileSync(f.file);
  const blocked = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
  assert.equal(blocked.status, 1);
  const blockedResult = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
  assert.equal(blockedResult.error.code, 'EVENT_TRANSITION_INVALID');
  assert.match(blockedResult.error.message, /EXECUTION_BUSY/);
  assert.deepEqual(fs.readFileSync(f.file), beforeBlocked);

  const replay = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(f.file), beforeBlocked);
});

test('task-event applies the same execution lock to both manual validation families', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);

  for (const event of ['manual-validation.started', 'validation-run.started']) {
    const blocked = run(f.root, [f.id, event, '--agent', 'codex']);
    assert.equal(blocked.status, 1, blocked.stderr);
    const result = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
    assert.equal(result.error.code, 'EVENT_TRANSITION_INVALID');
    assert.match(result.error.message, /EXECUTION_BUSY/);
  }
});

test('task-event blocks other lifecycle starts while either manual validation family is open', () => {
  for (const event of ['manual-validation.started', 'validation-run.started']) {
    const f = fixture('code-review');
    const started = run(f.root, [f.id, event, '--agent', 'codex']);
    assert.equal(started.status, 0, started.stderr);

    const blocked = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
    assert.equal(blocked.status, 1, blocked.stderr);
    const result = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
    assert.equal(result.error.code, 'EVENT_TRANSITION_INVALID');
    assert.match(result.error.message, /EXECUTION_BUSY/);
  }
});

test('task-event requires an approved code review before either manual validation family starts', () => {
  for (const event of ['manual-validation.started', 'validation-run.started']) {
    const f = fixture('code-review');
    fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewArtifact('Code Review', 'code.md', '拒绝'));
    const blocked = run(f.root, [f.id, event, '--agent', 'codex']);
    assert.equal(blocked.status, 1, blocked.stderr);
    const result = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
    assert.equal(result.error.code, 'EVENT_TRANSITION_INVALID');
    assert.match(result.error.message, /CODE_REVIEW_NOT_APPROVED/);
  }
});

test('task-event requires an explicit trigger for lifecycle events', () => {
  const f = fixture('technical-design');
  const before = fs.readFileSync(f.file);
  const out = spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', f.id, 'analyze.started', '--agent', 'codex'], {
    cwd: f.root, encoding: 'utf8'
  });
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).error.code, 'EVENT_TRIGGER_REQUIRED');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('started derives its round and completion rejects an unlanded artifact', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.round, 1);
  assert.equal(startedResult.artifact, 'plan.md');
  const before = fs.readFileSync(f.file);
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', '--artifact-sha256', '0'.repeat(64), '--semantic-digest', '0'.repeat(64)]);
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).error.code, 'ARTIFACT_NOT_FOUND');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('local completion rejects a stale finalizer digest before mutating task state', () => {
  for (const kind of ['artifactSha256', 'semanticDigest'] as const) {
    const f = fixture();
    assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
    const artifact = path.join(f.dir, 'plan.md');
    fs.writeFileSync(artifact, localArtifact('plan'));
    const digests = completionDigestArgs(f.dir, 'plan.md', 'plan');
    const stale = kind === 'artifactSha256'
      ? ['--artifact-sha256', '0'.repeat(64), '--semantic-digest', digests[3]!]
      : ['--artifact-sha256', digests[1]!, '--semantic-digest', '0'.repeat(64)];
    const before = fs.readFileSync(f.file);

    const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...stale]);

    assert.equal(completed.status, 1);
    assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
});

test('local completion rejects a valid artifact without finalizer provenance', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan'));
  const local = validateLocalArtifact(fs.readFileSync(artifact, 'utf8'), { family: 'plan' });
  assert.equal(local.ok, true);
  const before = fs.readFileSync(f.file);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', sha256File(artifact), '--semantic-digest', local.semanticDigest
  ]);

  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('local completion rejects intent consumption failure before mutating task state', onPlatforms('linux', 'darwin'), () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan'));
  const finalized = finalizeLocalArtifact({
    taskRef: f.id,
    repoRoot: f.root,
    family: 'plan',
    artifact: 'plan.md'
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);
  const intentDir = path.join(f.root, '.agents', 'workspace', '.local-artifact-finalization-intents');
  const before = fs.readFileSync(f.file);

  fs.chmodSync(intentDir, 0o500);
  try {
    const completed = run(f.root, [
      f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
      '--artifact-sha256', finalized.artifactSha256!, '--semantic-digest', finalized.semanticDigest!
    ]);

    assert.equal(completed.status, 1);
    assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.readdirSync(intentDir).length, 1);
  } finally {
    fs.chmodSync(intentDir, 0o700);
  }
});

test('local repair provenance rejects semantic mutation between finalizer retries and completion', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan').replace('## 验证策略\n', '## 验证策略：\n'));

  const first = inspect(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(first.status, 1, first.stderr);
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.repairable, true);

  fs.writeFileSync(artifact, fs.readFileSync(artifact, 'utf8')
    .replace('## 验证策略：', '## 验证策略')
    .replace('$ git status -s', '$ git status --porcelain'));
  const second = inspect(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(second.status, 1, second.stderr);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.repairable, false);
  assert.ok(secondResult.diagnostics.some((item: { code: string }) => item.code === 'LOCAL_REPAIR_BASELINE_MISMATCH'));

  const before = fs.readFileSync(f.file);
  const local = validateLocalArtifact(fs.readFileSync(artifact, 'utf8'), { family: 'plan' });
  assert.equal(local.ok, true);
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', sha256File(artifact), '--semantic-digest', local.semanticDigest
  ]);
  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('local completion uses the repository verification config for its language', () => {
  const f = fixture();
  const sections = ['Problem Understanding', 'Constraints', 'Options Comparison', 'Technical Approach', 'Implementation Steps', 'File List', 'Verification Strategy', 'State Check'];
  const configDir = path.join(f.root, '.agents', 'skills', 'plan-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    checks: { artifact: { required_sections: sections, required_patterns: ['^\\$ '] } }
  }));
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, ['# Technical Plan', '', ...sections.flatMap((section) => [`## ${section}`, 'content']), '```text', '$ git status -s', '```'].join('\n'));
  const content = fs.readFileSync(artifact, 'utf8');
  const local = validateLocalArtifact(content, { family: 'plan', requiredSections: sections, requiredPatterns: ['^\\$ '] });
  assert.equal(local.ok, true, local.diagnostics.map((item) => item.message).join('; '));
  const finalized = finalizeLocalArtifact({
    taskRef: f.id,
    repoRoot: f.root,
    family: 'plan',
    artifact: 'plan.md',
    requiredSections: sections,
    requiredPatterns: ['^\\$ ']
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', finalized.artifactSha256!, '--semantic-digest', finalized.semanticDigest!
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
});

test('completed event preserves source @ content without blocking task state', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan', '\n@2x\n'));
  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan')]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.notDeepEqual(fs.readFileSync(f.file), before);
});

test('started replay keeps the open identity after its artifact lands', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  const result = JSON.parse(repeated.stdout);
  assert.equal(result.status, 'no-op');
  assert.equal(result.round, 1);
  assert.equal(result.artifact, 'plan.md');
  assert.equal((fs.readFileSync(f.file, 'utf8').match(/Plan Task \(Round 1\) \[started\]/g) ?? []).length, 1);
});

test('plan event reopens technical design after commit preparation', () => {
  const f = fixture('commit');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan round 1\n');

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'commit');
  assert.equal(startedResult.toStep, 'commit');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'plan-r2.md');

  fs.writeFileSync(path.join(f.dir, 'plan-r2.md'), localArtifact('plan'));
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan-r2.md', ...completionDigestArgs(f.dir, 'plan-r2.md', 'plan')
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /Plan Task \(Round 2\) \[started\]/);
  assert.match(content, /`plan-r2\.md`/);
});

test('plan event reopens technical design after code review', () => {
  const f = fixture('code-review');

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'code-review');
  assert.equal(startedResult.toStep, 'code-review');
  assert.equal(startedResult.round, 1);
  assert.equal(startedResult.artifact, 'plan.md');

  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan')
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  const completedResult = JSON.parse(completed.stdout);
  assert.equal(completedResult.fromStep, 'code-review');
  assert.equal(completedResult.toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /`plan\.md`/);
});

test('completed event validates orchestration provenance before writing task state', () => {
  const f = fixture();
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: f.root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: f.root });
  spawnSync('git', ['add', '.'], { cwd: f.root });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: f.root });

  const orchestrate = (args: string[]) => spawnSync(
    'node', [INTERNAL_CLI_PATH, 'task-orchestration', f.id, ...args],
    { cwd: f.root, encoding: 'utf8', env: sandboxControlSafeEnv() }
  );
  assert.equal(orchestrate([
    'begin-or-resume', '--client', 'claude-code',
    '--executor-model', 'executor-model', '--executor-reasoning-effort', 'xhigh',
    '--reviewer-model', 'reviewer-model', '--reviewer-reasoning-effort', 'high'
  ]).status, 0);
  const prepared = prepareOrchestrationDelegation(f.id, {
    client: 'claude-code', requestedModel: 'reviewer-model', requestedReasoningEffort: 'high'
  }, {
    repoRoot: f.root,
    supportsLifecycleDelegation: () => true
  });
  assert.equal(prepared.status, 'running');
  assert.equal(orchestrate([
    'hook-start', '--native-agent', 'agent-infra-lifecycle-reviewer', '--child-id', 'child-1',
    '--parent-id', 'parent-1', '--spawn-mode', 'fresh', '--actual-model', 'reviewer-model',
    '--actual-reasoning-effort', 'high'
  ]).status, 0);

  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'claude-code']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));

  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'claude-code', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan'), '--orchestrated'
  ]);
  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_TRANSITION_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('standalone completion ignores a current orchestration run without a pending delegation', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  fs.writeFileSync(path.join(f.dir, 'orchestration.json'), `${JSON.stringify(currentRun(f.id, {
    status: 'paused', nextStage: null,
    pause: { code: 'ORCHESTRATION_RETRYABLE', message: 'retry later', recoverable: true }
  }), null, 2)}\n`);
  const runBefore = fs.readFileSync(path.join(f.dir, 'orchestration.json'));

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan')
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'orchestration.json')), runBefore);
});

test('standalone completion fails before writing when a delegation is pending', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun(f.id, {
    pendingDelegation: orchestrationReceipt(f.id, {
      status: 'prepared', parentId: null, childId: null, spawnMode: null,
      actualModel: null, actualReasoningEffort: null, spawnDispatchMonotonicMs: null,
      activationDeadlineMonotonicMs: null, spawnDispatchedAt: null, activationDeadlineAt: null,
      startEvidenceMonotonicMs: null, activatedMonotonicMs: null, activatedAt: null
    })
  }), null, 2)}\n`);
  const taskBefore = fs.readFileSync(f.file);
  const runBefore = fs.readFileSync(runPath);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan')
  ]);

  assert.equal(completed.status, 1);
  assert.match(JSON.parse(completed.stdout).error.message, /ORCHESTRATION_STANDALONE_BUSY/);
  assert.deepEqual(fs.readFileSync(f.file), taskBefore);
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('orchestrated completion advances one matching activated delegation', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun(f.id, {
    pendingDelegation: orchestrationReceipt(f.id)
  }), null, 2)}\n`);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan'), '--orchestrated'
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pendingDelegation.status, 'stage-completed');
});

test('orchestrated completion reports a distinct partial-write error when the run commit fails', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun(f.id, {
    pendingDelegation: orchestrationReceipt(f.id)
  }), null, 2)}\n`);
  const finalized = finalizeLocalArtifact({
    taskRef: f.id,
    repoRoot: f.root,
    family: 'plan',
    artifact: 'plan.md'
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);
  const taskBefore = fs.readFileSync(f.file);

  const result = applyTaskEvent({
    taskRef: f.id,
    event: 'plan.completed',
    agent: 'codex',
    initiator: 'model',
    requestId: `test:${f.id}:plan`,
    reasonCode: 'user-request',
    artifact: 'plan.md',
    artifactSha256: finalized.artifactSha256!,
    semanticDigest: finalized.semanticDigest!,
    orchestrated: true
  }, {
    repoRoot: f.root,
    commitOrchestrationCompletion: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'EVENT_ORCHESTRATION_COMMIT_FAILED');
  assert.notDeepEqual(fs.readFileSync(f.file), taskBefore);
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pendingDelegation.status, 'activated');
});

test('task-event only accepts --orchestrated for lifecycle completion events', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const result = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--orchestrated']);

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'EVENT_PAYLOAD_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('manual validation keeps code-review and supports multiple fixed-action rounds', () => {
  const f = fixture('code-review');
  for (const [round, name] of [[1, 'manual-validation.md'], [2, 'manual-validation-r2.md']] as const) {
    const started = run(f.root, [f.id, 'manual-validation.started', '--agent', 'codex']);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).round, round);
    fs.writeFileSync(path.join(f.dir, name), '# Manual validation\n');
    const done = run(f.root, [f.id, 'manual-validation.completed', '--agent', 'codex', '--artifact', name, '--summary-result', 'summary updated']);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(JSON.parse(done.stdout).toStep, 'code-review');
  }
  const content = fs.readFileSync(f.file, 'utf8');
  assert.equal((content.match(/Complete Manual Validation \[started\]/g) ?? []).length, 2);
  assert.match(content, /manual-validation-r2\.md/);
});

test('manual validation keeps commit after PR preparation', () => {
  const f = fixture('commit');
  const started = run(f.root, [f.id, 'manual-validation.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).toStep, 'commit');

  fs.writeFileSync(path.join(f.dir, 'manual-validation.md'), '# Manual validation\n');
  const done = run(f.root, [
    f.id, 'manual-validation.completed', '--agent', 'codex',
    '--artifact', 'manual-validation.md', '--summary-result', 'summary updated'
  ]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).toStep, 'commit');
  assert.match(fs.readFileSync(f.file, 'utf8'), /current_step: commit/);
});

test('dry-run returns planned without changing task bytes for start and completion', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1', '--dry-run']);
  assert.equal(JSON.parse(out.stdout).status, 'planned');
  assert.deepEqual(fs.readFileSync(f.file), before);

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const beforeCompletion = fs.readFileSync(f.file);
  const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan'), '--dry-run']);
  const completedResult = JSON.parse(completed.stdout);
  assert.equal(completedResult.status, 'planned');
  assert.equal(completedResult.operations.length, 4);
  assert.deepEqual(fs.readFileSync(f.file), beforeCompletion);
});

test('orchestrated completion dry-run reports a provenance mismatch without pausing the run', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun(f.id, {
    pendingDelegation: orchestrationReceipt(f.id, {
      status: 'prepared', parentId: null, childId: null, spawnMode: null,
      actualModel: null, actualReasoningEffort: null, spawnDispatchMonotonicMs: null,
      activationDeadlineMonotonicMs: null, spawnDispatchedAt: null, activationDeadlineAt: null,
      startEvidenceMonotonicMs: null, activatedMonotonicMs: null, activatedAt: null
    })
  }), null, 2)}\n`);
  const taskBefore = fs.readFileSync(f.file);
  const runBefore = fs.readFileSync(runPath);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.dir, 'plan.md', 'plan'), '--orchestrated', '--dry-run'
  ]);

  assert.equal(completed.status, 1);
  assert.match(JSON.parse(completed.stdout).error.message, /ORCHESTRATION_PROVENANCE_MISMATCH/);
  assert.deepEqual(fs.readFileSync(f.file), taskBefore);
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('task-event timestamps keep an ASCII offset in negative-offset timezones', () => {
  const f = fixture();
  const env = { ...process.env, TZ: 'America/Los_Angeles' };
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1'], env);
  assert.equal(started.status, 0, started.stderr);
  assert.match(JSON.parse(started.stdout).timestamp, /-\d{2}:\d{2}$/);
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1'], env);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
});

test('completion without an open start fails without changing the file', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', '--artifact-sha256', '0'.repeat(64), '--semantic-digest', '0'.repeat(64)]);
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).error.code, 'EVENT_START_MISSING');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('historical done-only activity does not suppress a new current start', () => {
  const f = fixture();
  fs.appendFileSync(
    f.file,
    '- 2026-01-01 00:00:00+00:00 — **Plan Task (Round 1)** by codex — historical completion\n'
  );

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  assert.match(fs.readFileSync(f.file, 'utf8'), /Plan Task \(Round 1\) \[started\]/);
});

test('analysis can restart from code when task requirements expand', () => {
  const f = fixture('code');

  const started = run(f.root, [f.id, 'analyze.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'code');
  assert.equal(startedResult.toStep, 'code');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'analysis-r2.md');

  fs.writeFileSync(path.join(f.dir, 'analysis-r2.md'), localArtifact('analysis'));
  const completed = run(f.root, [
    f.id, 'analyze.completed', '--agent', 'codex', '--artifact', 'analysis-r2.md', ...completionDigestArgs(f.dir, 'analysis-r2.md', 'analysis')
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'requirement-analysis');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: requirement-analysis/);
  assert.match(content, /Analyze Task \(Round 2\) \[started\]/);
  assert.match(content, /`analysis-r2\.md`/);
});

test('source completion records resumable invalidation and downstream writers fail closed until reconcile', () => {
  const f = fixture('code');
  fs.writeFileSync(path.join(f.dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md'));
  for (const name of ['plan.md', 'review-plan.md', 'code.md', 'review-code.md']) {
    fs.writeFileSync(path.join(f.dir, name), `# ${name}\n`);
  }
  addReceipt(f.file, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(f.dir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  addReceipt(f.file, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.dir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  addReceipt(f.file, {
    event: 'code.completed', output: 'code.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.dir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  addReceipt(f.file, {
    event: 'review-code.completed', output: 'review-code.md', input: 'code.md',
    inputSha256: sha256File(path.join(f.dir, 'code.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const started = run(f.root, [f.id, 'analyze.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  fs.writeFileSync(path.join(f.dir, 'analysis-r2.md'), localArtifact('analysis'));
  const completed = run(f.root, [
    f.id, 'analyze.completed', '--agent', 'codex', '--artifact', 'analysis-r2.md',
    ...completionDigestArgs(f.dir, 'analysis-r2.md', 'analysis')
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  const invalidation = parseInvalidationDocument(fs.readFileSync(f.file, 'utf8'));
  assert.equal(invalidation.ok, true);
  if (!invalidation.ok) return;
  assert.equal(invalidation.document.operations[0]?.status, 'pending');
  assert.equal(invalidation.document.targets.every((target) => target.status === 'pending'), true);
  assert.equal(invalidation.document.targets.filter((target) => target.targetKind === 'artifact').length, 5);
  assert.equal(invalidation.document.targets.filter((target) => target.targetKind === 'receipt').length, 4);
  assert.equal(invalidation.document.targets.filter((target) => target.targetKind === 'approval').length, 3);
  assert.equal(invalidation.document.targets.filter((target) => target.targetKind === 'reviewed-snapshot').length, 1);

  const blocked = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).error.code, 'TASK_INVALIDATION_BLOCKED');

  const reconciled = spawnSync('node', [INTERNAL_CLI_PATH, 'task-invalidation', f.id, 'reconcile'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(reconciled.status, 0, reconciled.stdout || reconciled.stderr);
  const retried = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
  assert.equal(retried.status, 0, retried.stdout || retried.stderr);
});

test('analysis restart is authorized by explicit intent without current-step adjacency', () => {
  const f = fixture('technical-design');
  const started = run(f.root, [f.id, 'analyze.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).artifact, 'analysis-r2.md');
});

test('explicit trigger can start analysis without a current_step adjacency match', () => {
  const f = fixture('technical-design');
  const started = run(f.root, [
    f.id, 'analyze.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'req-new-requirement', '--reason-code', 'new-requirement'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).artifact, 'analysis-r2.md');
});

for (const scenario of [
  {
    family: 'review-analysis', step: 'requirement-analysis-review', input: 'analysis.md',
    title: 'Analysis Review', first: 'review-analysis.md', second: 'review-analysis-r2.md'
  },
  {
    family: 'review-plan', step: 'technical-design-review', input: 'plan.md',
    title: 'Plan Review', first: 'review-plan.md', second: 'review-plan-r2.md'
  }
] as const) {
  test(`${scenario.family} event completes a supplemental round from its review stage`, () => {
    const f = fixture(scenario.step);
    fs.writeFileSync(path.join(f.dir, scenario.input), `# ${scenario.input}\n`);
    fs.writeFileSync(path.join(f.dir, scenario.first), reviewArtifact(scenario.title, scenario.input));

    const started = run(f.root, [f.id, `${scenario.family}.started`, '--agent', 'codex']);
    assert.equal(started.status, 0, started.stderr);
    const startedResult = JSON.parse(started.stdout);
    assert.equal(startedResult.status, 'applied');
    assert.equal(startedResult.fromStep, scenario.step);
    assert.equal(startedResult.toStep, scenario.step);
    assert.equal(startedResult.round, 2);
    assert.equal(startedResult.artifact, scenario.second);

    fs.writeFileSync(path.join(f.dir, scenario.second), reviewArtifact(scenario.title, scenario.input));
    const completed = run(f.root, [
      f.id, `${scenario.family}.completed`, '--agent', 'codex', '--artifact', scenario.second,
      '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
    ]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).toStep, scenario.step);
    const content = fs.readFileSync(f.file, 'utf8');
    assert.match(content, new RegExp(scenario.second.replace('.', '\\.')));
    assert.match(content, new RegExp(`current_step: ${scenario.step}`));
  });
}

for (const scenario of [
  { family: 'review-analysis', step: 'technical-design', input: 'analysis.md' },
  { family: 'review-plan', step: 'requirement-analysis-review', input: 'plan.md' }
] as const) {
  test(`${scenario.family} event is authorized by explicit intent without current-step adjacency`, () => {
    const f = fixture(scenario.step);
    fs.writeFileSync(path.join(f.dir, scenario.input), `# ${scenario.input}\n`);

    const started = run(f.root, [f.id, `${scenario.family}.started`, '--agent', 'codex']);
    assert.equal(started.status, 0, started.stdout || started.stderr);
  });
}

test('review-code event completes the regular code review path', () => {
  const f = fixture('code');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');

  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'code-review');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: code-review/);
  assert.match(content, /`review-code\.md`/);
});

for (const scenario of reviewScenarios) {
  test(`${scenario.family} completion records the reviewed input digest receipt`, () => {
    const f = prepareReview(scenario, []);
    const startedContent = fs.readFileSync(f.file, 'utf8');
    assert.match(startedContent, /^review_input_artifact: /m);
    assert.match(startedContent, /^review_input_sha256: [a-f0-9]{64}$/m);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    assert.equal(completed.status, 0, completed.stderr);
    const digest = sha256File(path.join(f.dir, scenario.input));
    const content = fs.readFileSync(f.file, 'utf8');
    assert.match(content, new RegExp(`\\| ${scenario.family}\\.completed \\| ${scenario.artifact} \\| ${scenario.input} \\| ${digest} \\|`));
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} completes a finalized non-advancing review`, () => {
    const f = prepareReview(scenario, [
      `| ${scenario.findingId} | ${scenario.stage} | 1 | minor | open | ${scenario.artifact}#finding |`
    ], '需要修改', { blockers: 0, major: 0, minor: 1 });

    const finalized = finalizeReview(f, scenario);
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const finalization = JSON.parse(finalized.stdout);
    assert.equal(finalization.status, 'no-op');
    assert.equal(finalization.stageStatus.canAdvance, false);

    const completed = completeReview(f, scenario, 'changes-requested', { blockers: 0, major: 0, minor: 1 });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} preserves a known pending decision during unrelated artifact repair`, () => {
    const f = prepareReview(scenario, [
      `| HD-1 | ${scenario.stage} | - | decision | needs-human-decision | ${scenario.artifact}#HD-1 |`
    ], '需要修改');
    const artifactPath = path.join(f.dir, scenario.artifact);
    const original = fs.readFileSync(artifactPath, 'utf8');
    fs.writeFileSync(
      artifactPath,
      `${original.replace('0 阻塞项，0 主要，0 次要', '{unresolved-blockers} 阻塞项，{unresolved-major} 主要，{unresolved-minor} 次要')}\n### HD-1: Decision [needs-human-decision]\n\n- **What needs a decision**: choose a repair\n`
    );

    const finalized = finalizeReview(f, scenario);
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const finalization = JSON.parse(finalized.stdout);
    assert.equal(finalization.status, 'applied');
    assert.equal(finalization.changed, true);
    assert.equal(finalization.stageStatus.canAdvance, false);
    assert.match(fs.readFileSync(artifactPath, 'utf8'), /0 阻塞项，0 主要，0 次要/);
    assert.match(fs.readFileSync(artifactPath, 'utf8'), /### HD-1: Decision \[needs-human-decision\]/);

    const completed = completeReview(f, scenario, 'changes-requested', { blockers: 0, major: 0, minor: 0 });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} rejects input changes after the review artifact is written`, () => {
    const f = prepareReview(scenario, []);
    fs.writeFileSync(path.join(f.dir, scenario.input), `# ${scenario.input} changed\n`);
    const before = fs.readFileSync(f.file);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    const result = JSON.parse(completed.stdout);

    assert.equal(completed.status, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'EVENT_ARTIFACT_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} rejects approved finding counts that differ from the ${scenario.stage} ledger`, () => {
    const f = prepareReview(scenario, [
      `| ${scenario.findingId} | ${scenario.stage} | 1 | minor | open | ${scenario.artifact}#finding |`
    ]);
    const before = fs.readFileSync(f.file);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    const result = JSON.parse(completed.stdout);

    assert.equal(completed.status, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.changed, false);
    assert.equal(result.error.code, 'EVENT_FINDING_COUNT_MISMATCH');
    assert.match(result.error.message, new RegExp(`${scenario.stage} ledger`));
    assert.match(result.error.message, /minor ledger 1, payload 0/);
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

test('approved review completion rejects non-zero finding counts even when payload and ledger match', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, [
    '| CD-1 | code | 1 | blocker | open | review-code.md#CD-1 |',
    '| CD-2 | code | 1 | major | adjusted | review-code.md#CD-2 |',
    '| CD-3 | code | 1 | minor | needs-human-decision | review-code.md#CD-3 |'
  ], '通过', { blockers: 1, major: 1, minor: 1 });
  const before = fs.readFileSync(f.file);
  const completed = completeReview(f, scenario, 'approved', { blockers: 1, major: 1, minor: 1 });

  assert.equal(completed.status, 1);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.error.code, 'EVENT_VERDICT_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

for (const verdict of ['changes-requested', 'rejected'] as const) {
  test(`${verdict} review completion rejects finding counts that differ from the ledger`, () => {
    const scenario = reviewScenarios[2];
    const f = prepareReview(
      scenario,
      ['| CD-1 | code | 1 | minor | open | review-code.md#CD-1 |'],
      verdict === 'changes-requested' ? '需要修改' : '拒绝'
    );
    const before = fs.readFileSync(f.file);
    const completed = completeReview(f, scenario, verdict, { blockers: 0, major: 0, minor: 0 });

    assert.equal(completed.status, 1);
    assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_FINDING_COUNT_MISMATCH');
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

test('review completion rejects unresolved summary placeholders before mutating task.md', () => {
  const scenario = reviewScenarios[0];
  const f = prepareReview(scenario, []);
  const artifactPath = path.join(f.dir, scenario.artifact);
  fs.writeFileSync(
    artifactPath,
    fs.readFileSync(artifactPath, 'utf8')
      .replace('0 阻塞项，0 主要，0 次要', '{unresolved-blockers} 阻塞项，{unresolved-major} 主要，{unresolved-minor} 次要')
  );
  const before = fs.readFileSync(f.file);
  const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });

  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_FINDING_COUNT_MISMATCH');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('approved dry-run rejects mismatched finding counts without changing task bytes', () => {
  const scenario = reviewScenarios[1];
  const f = prepareReview(scenario, [
    '| PL-1 | plan | 1 | major | open | review-plan.md#PL-1 |'
  ]);
  const before = fs.readFileSync(f.file);
  const completed = completeReview(
    f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 }, ['--dry-run']
  );
  const result = JSON.parse(completed.stdout);

  assert.equal(completed.status, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EVENT_FINDING_COUNT_MISMATCH');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('approved review completion reports an invalid ledger as an invalid task document', () => {
  const scenario = reviewScenarios[0];
  const f = prepareReview(scenario, []);
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace(
    '|----|-------|-------|----------|--------|----------|',
    '|----|-------|-------|----------|--------|----------|\n| invalid | analysis | 1 | minor | open | review-analysis.md#finding |'
  ));
  const before = fs.readFileSync(f.file);
  const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  const result = JSON.parse(completed.stdout);

  assert.equal(completed.status, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TASK_DOCUMENT_INVALID');
  assert.match(result.error.message, /LEDGER_ID_INVALID/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('completed approved review remains a no-op after the ledger changes', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  assert.equal(completed.status, 0, completed.stderr);

  const content = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(
    f.file,
    content.replace(
      '|----|-------|-------|----------|--------|----------|',
      '|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | minor | open | review-code.md#CD-1 |'
    )
  );
  const beforeReplay = fs.readFileSync(f.file);
  const replayed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });

  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(f.file), beforeReplay);
});

test('review-code event completes a supplemental round against the latest code artifact', () => {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  fs.appendFileSync(
    f.file,
    '- 2026-01-01 00:01:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md\n'
  );

  const artifact = inspect(f.root, [f.id, 'inspect', '--family', 'review-code']);
  assert.equal(artifact.status, 0, artifact.stderr);
  const artifactResult = JSON.parse(artifact.stdout);
  assert.equal(artifactResult.status, 'ready');
  assert.deepEqual(artifactResult.next, { round: 2, name: 'review-code-r2.md' });
  assert.equal(artifactResult.inputs[0].name, 'code.md');

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'code-review');
  assert.equal(startedResult.toStep, 'code-review');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'review-code-r2.md');

  fs.writeFileSync(path.join(f.dir, 'review-code-r2.md'), reviewCodeArtifact());
  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code-r2.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'code-review');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Review Code \(Round 2\) \[started\]/);
  assert.match(content, /`review-code-r2\.md`/);
});

test('review-code event allows a supplemental round after commit preparation', () => {
  const f = fixture('commit');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  fs.appendFileSync(
    f.file,
    '- 2026-01-01 00:01:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md\n'
  );

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'commit');
  assert.equal(startedResult.toStep, 'commit');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'review-code-r2.md');
});

test('review-code event is authorized by explicit intent without current-step adjacency', () => {
  const f = fixture('technical-design');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
});

test('decision code event clears the review baseline and consumes its input on completion', () => {
  const f = decisionFixture();
  const started = run(f.root, [
    f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.implementationInput, 'II-1');
  let content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Code Task \(Round 2, decision II-1\) \[started\]/);
  assert.match(content, /^code_input_artifact: plan\.md$/m);
  assert.match(content, /^code_input_sha256: [a-f0-9]{64}$/m);
  assert.match(content, /last_reviewed_commit:\s*$/m);
  assert.match(content, /\| II-1 .*\| pending \|\s*\|/);

  fs.writeFileSync(path.join(f.dir, 'code-r2.md'), codeReport());
  const digests = completionDigestArgs(f.dir, 'code-r2.md', 'code');
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '4', ...digests
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).implementationInput, 'II-1');
  content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /\| II-1 .*\| consumed \| code-r2\.md \|/);
  assert.match(content, /Code Task \(Round 2, decision II-1\).*Code implemented/);
  assert.match(content, new RegExp(`\\| code.completed \\| code-r2\\.md \\| plan\\.md \\| ${sha256File(path.join(f.dir, 'plan.md'))} \\|`));

  const repeated = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '4', ...digests
  ]);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
});

test('code completion rejects a report without a canonical plan input', () => {
  const f = decisionFixture();
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'code-r2.md'), codeReport('missing-plan.md'));
  const digests = completionDigestArgs(f.dir, 'code-r2.md', 'code');
  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '1', ...digests
  ]);
  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('code completion rejects a plan changed after code started', () => {
  const f = fixture('technical-design-review');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan v1\n');
  fs.writeFileSync(path.join(f.dir, 'review-plan.md'), reviewArtifact('Plan Review', 'plan.md'));
  addReceipt(f.file, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.dir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan v2\n');
  fs.writeFileSync(path.join(f.dir, 'code.md'), codeReport());
  const digests = completionDigestArgs(f.dir, 'code.md', 'code');
  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code.md',
    '--files-modified', '1', '--tests-passed', '1', ...digests
  ]);
  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('code completion requires current finalizer provenance and rejects a semantic mutation', () => {
  const f = decisionFixture();
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1']);
  assert.equal(started.status, 0, started.stderr);
  const artifact = path.join(f.dir, 'code-r2.md');
  fs.writeFileSync(artifact, codeReport());
  const content = fs.readFileSync(artifact, 'utf8');
  const local = validateLocalArtifact(content, { family: 'code' });
  assert.equal(local.ok, true, local.diagnostics.map((item) => item.message).join('; '));

  const withoutProvenance = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '1',
    '--artifact-sha256', sha256File(artifact), '--semantic-digest', local.semanticDigest
  ]);
  assert.equal(withoutProvenance.status, 1);
  assert.equal(JSON.parse(withoutProvenance.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');

  const finalized = finalizeLocalArtifact({
    taskRef: f.id, repoRoot: f.root, family: 'code', artifact: 'code-r2.md'
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);
  fs.appendFileSync(artifact, '\nsemantic mutation\n');
  const before = fs.readFileSync(f.file);
  const changed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '1',
    '--artifact-sha256', finalized.artifactSha256!, '--semantic-digest', finalized.semanticDigest!
  ]);
  assert.equal(changed.status, 1);
  assert.equal(JSON.parse(changed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
});
