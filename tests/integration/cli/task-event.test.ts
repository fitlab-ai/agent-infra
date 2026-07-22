import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

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
  return `# Code Review\n\n- **审查输入**：\`${input}\`\n`;
}

function reviewArtifact(title: string, input: string) {
  return `# ${title}\n\n- **审查输入**：\`${input}\`\n`;
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
| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 10:01:00+08:00 | pending | |

## Activity Log

- 2026-07-18 10:00:00+08:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md
`);
  return f;
}

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
  assert.equal(started.status, 0, started.stderr);
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
