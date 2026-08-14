import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, sandboxControlSafeEnv } from '../../helpers.ts';
import { applyTaskEvent } from '../../../lib/task/events.ts';
import { prepareOrchestrationDelegation } from '../../../lib/task/orchestration.ts';

function fixture(step = 'requirement-analysis-review') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-event-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\ncurrent_step: ${step}\nassigned_to: claude\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.0.0\n---\n\n# Task\n\n## Activity Log\n\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), '# Analysis\n');
  return { root, id, dir, file: path.join(dir, 'task.md') };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', ...args], { cwd: root, encoding: 'utf8', env });
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
  fs.writeFileSync(file, content.replace('## Activity Log', `${ledger}\n## Activity Log`));
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
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), `## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n`);
  fs.writeFileSync(f.file, `---
id: ${f.id}
current_step: code-review
assigned_to: claude
updated_at: 2026-07-18 10:02:00+08:00
agent_infra_version: v0.0.0
last_reviewed_commit: abcdef1234567890
---

# Task

## 实现备注

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|
| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:59:00+08:00 | pending | |

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

test('internal task-event applies a started/completed pair and replays as no-op', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /\]\(plan\.md\)/);
});

test('started derives its round and completion rejects an unlanded artifact', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.round, 1);
  assert.equal(startedResult.artifact, 'plan.md');
  const before = fs.readFileSync(f.file);
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md']);
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).error.code, 'ARTIFACT_NOT_FOUND');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('started replay keeps the open identity after its artifact lands', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
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

  fs.writeFileSync(path.join(f.dir, 'plan-r2.md'), '# Plan round 2\n');
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan-r2.md'
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /Plan Task \(Round 2\) \[started\]/);
  assert.match(content, /\]\(plan-r2\.md\)/);
});

test('completed event validates orchestration provenance before writing task state', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'claude-code']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
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

  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'claude-code', '--artifact', 'plan.md', '--orchestrated'
  ]);
  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_TRANSITION_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('standalone completion ignores a historical orchestration run without a pending delegation', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(f.dir, 'orchestration.json'), `${JSON.stringify({
    schemaVersion: 2,
    status: 'paused',
    pendingDelegation: null
  }, null, 2)}\n`);
  const runBefore = fs.readFileSync(path.join(f.dir, 'orchestration.json'));

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md'
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'orchestration.json')), runBefore);
});

test('standalone completion fails before writing when a delegation is pending', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    status: 'running',
    pendingDelegation: { status: 'prepared' }
  }, null, 2)}\n`);
  const taskBefore = fs.readFileSync(f.file);
  const runBefore = fs.readFileSync(runPath);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md'
  ]);

  assert.equal(completed.status, 1);
  assert.match(JSON.parse(completed.stdout).error.message, /ORCHESTRATION_STANDALONE_BUSY/);
  assert.deepEqual(fs.readFileSync(f.file), taskBefore);
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('orchestrated completion advances one matching activated delegation', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    taskId: f.id,
    runId: 'run-1',
    status: 'running',
    pendingDelegation: {
      id: 'receipt-1', taskId: f.id, runId: 'run-1', role: 'executor', stage: 'plan', round: 1,
      artifact: 'plan.md', client: 'codex', status: 'activated'
    }
  }, null, 2)}\n`);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', '--orchestrated'
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pendingDelegation.status, 'stage-completed');
});

test('orchestrated completion reports a distinct partial-write error when the run commit fails', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    taskId: f.id,
    runId: 'run-1',
    status: 'running',
    pendingDelegation: {
      id: 'receipt-1', taskId: f.id, runId: 'run-1', role: 'executor', stage: 'plan', round: 1,
      artifact: 'plan.md', client: 'codex', status: 'activated'
    }
  }, null, 2)}\n`);
  const taskBefore = fs.readFileSync(f.file);

  const result = applyTaskEvent({
    taskRef: f.id,
    event: 'plan.completed',
    agent: 'codex',
    artifact: 'plan.md',
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
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  const beforeCompletion = fs.readFileSync(f.file);
  const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', '--dry-run']);
  const completedResult = JSON.parse(completed.stdout);
  assert.equal(completedResult.status, 'planned');
  assert.equal(completedResult.operations.length, 4);
  assert.deepEqual(fs.readFileSync(f.file), beforeCompletion);
});

test('orchestrated completion dry-run reports a provenance mismatch without pausing the run', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    status: 'running',
    pendingDelegation: { status: 'prepared' }
  }, null, 2)}\n`);
  const taskBefore = fs.readFileSync(f.file);
  const runBefore = fs.readFileSync(runPath);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', '--orchestrated', '--dry-run'
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
  const out = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md']);
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).error.code, 'EVENT_START_MISSING');
  assert.deepEqual(fs.readFileSync(f.file), before);
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

  fs.writeFileSync(path.join(f.dir, 'analysis-r2.md'), '# Analysis round 2\n');
  const completed = run(f.root, [
    f.id, 'analyze.completed', '--agent', 'codex', '--artifact', 'analysis-r2.md'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'requirement-analysis');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: requirement-analysis/);
  assert.match(content, /Analyze Task \(Round 2\) \[started\]/);
  assert.match(content, /\]\(analysis-r2\.md\)/);
});

test('analysis restart still rejects an unrelated workflow stage without changing task bytes', () => {
  const f = fixture('technical-design');
  const before = fs.readFileSync(f.file);

  const started = run(f.root, [f.id, 'analyze.started', '--agent', 'codex']);
  assert.notEqual(started.status, 0);
  assert.equal(JSON.parse(started.stdout).error.code, 'EVENT_TRANSITION_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
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
  test(`${scenario.family} event still rejects an unrelated workflow stage without changing task bytes`, () => {
    const f = fixture(scenario.step);
    fs.writeFileSync(path.join(f.dir, scenario.input), `# ${scenario.input}\n`);
    const before = fs.readFileSync(f.file);

    const started = run(f.root, [f.id, `${scenario.family}.started`, '--agent', 'codex']);
    assert.notEqual(started.status, 0);
    assert.equal(JSON.parse(started.stdout).error.code, 'EVENT_TRANSITION_INVALID');
    assert.deepEqual(fs.readFileSync(f.file), before);
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
  assert.match(content, /\]\(review-code\.md\)/);
});

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

test('approved review completion accepts matching non-zero finding counts', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, [
    '| CD-1 | code | 1 | blocker | open | review-code.md#CD-1 |',
    '| CD-2 | code | 1 | major | adjusted | review-code.md#CD-2 |',
    '| CD-3 | code | 1 | minor | needs-human-decision | review-code.md#CD-3 |'
  ], '通过', { blockers: 1, major: 1, minor: 1 });
  const completed = completeReview(f, scenario, 'approved', { blockers: 1, major: 1, minor: 1 });

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
  assert.match(fs.readFileSync(f.file, 'utf8'), /Verdict: Approved, blockers: 1, major: 1, minor: 1/);
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
  const f = prepareReview(scenario, [
    '| invalid | analysis | 1 | minor | open | review-analysis.md#finding |'
  ]);
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
  assert.match(content, /\]\(review-code-r2\.md\)/);
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

test('review-code event still rejects an unrelated workflow stage without changing task bytes', () => {
  const f = fixture('technical-design');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  const before = fs.readFileSync(f.file);

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.notEqual(started.status, 0);
  assert.equal(JSON.parse(started.stdout).error.code, 'EVENT_TRANSITION_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
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
  assert.match(content, /last_reviewed_commit:\s*$/m);
  assert.match(content, /\| II-1 .*\| pending \|\s*\|/);

  fs.writeFileSync(path.join(f.dir, 'code-r2.md'), '# Code round 2\n');
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '4'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).implementationInput, 'II-1');
  content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /\| II-1 .*\| consumed \| code-r2\.md \|/);
  assert.match(content, /Code Task \(Round 2, decision II-1\).*Code implemented/);

  const repeated = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '4'
  ]);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
});
