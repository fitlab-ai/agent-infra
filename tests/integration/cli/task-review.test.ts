import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';

const scenarios = [
  { stage: 'analysis', family: 'review-analysis', input: 'analysis.md', step: 'requirement-analysis-review', findingId: 'AN-1' },
  { stage: 'plan', family: 'review-plan', input: 'plan.md', step: 'technical-design-review', findingId: 'PL-1' },
  { stage: 'code', family: 'review-code', input: 'code.md', step: 'code', findingId: 'CD-1' }
] as const;

function fixture(scenario: (typeof scenarios)[number], line: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-review-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, scenario.input), '# Input\n');
  fs.writeFileSync(path.join(dir, 'task.md'), `---
id: ${TASK_ID}
current_step: ${scenario.step}
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|
| ${scenario.findingId} | ${scenario.stage} | 1 | major | open | |

## Activity Log

- 2026-01-01 00:00:00+00:00 — **${scenario.family === 'review-analysis' ? 'Review Analysis' : scenario.family === 'review-plan' ? 'Review Plan' : 'Review Code'} (Round 1) [started]** by codex — started
`);
  const artifact = `${scenario.family}.md`;
  fs.writeFileSync(path.join(dir, artifact), `# Review

- **Review Input**: \`${scenario.input}\`

## Review Summary

- **Overall Verdict**: Changes Requested
${line}
`);
  return { root, dir, artifact };
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-review', ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

for (const scenario of scenarios) {
  test(`task-review finalizes the ${scenario.stage} summary from one ledger snapshot`, () => {
    const f = fixture(
      scenario,
      '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors / **Manual validation**: 0'
    );
    const result = run(f.root, [
      TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'applied');
    assert.equal(output.changed, true);
    assert.deepEqual(output.stageStatus.unresolvedFindingCounts, { blocker: 0, major: 1, minor: 0 });
    assert.match(fs.readFileSync(path.join(f.dir, f.artifact), 'utf8'), /0 blockers, 1 majors, 0 minors/);
  });
}

test('task-review dry-run reports a plan without changing artifact bytes', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const before = fs.readFileSync(path.join(f.dir, f.artifact));
  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact, '--dry-run'
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'planned');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, f.artifact)), before);
});

test('orchestrated finalization dry-run reports a mismatch without pausing the run', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    status: 'running',
    pendingDelegation: { status: 'prepared' }
  }, null, 2)}\n`);
  const artifactPath = path.join(f.dir, f.artifact);
  const artifactBefore = fs.readFileSync(artifactPath);
  const runBefore = fs.readFileSync(runPath);

  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact,
    '--orchestrated', '--dry-run'
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error.message, /ORCHESTRATION_PROVENANCE_MISMATCH/);
  assert.deepEqual(fs.readFileSync(artifactPath), artifactBefore);
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('standalone finalization ignores a historical run without a pending delegation', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    status: 'completed',
    pendingDelegation: null
  }, null, 2)}\n`);
  const runBefore = fs.readFileSync(runPath);

  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'applied');
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('standalone finalization fails before writing when a delegation is pending', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    status: 'running',
    pendingDelegation: { status: 'activated' }
  }, null, 2)}\n`);
  const artifactPath = path.join(f.dir, f.artifact);
  const artifactBefore = fs.readFileSync(artifactPath);
  const runBefore = fs.readFileSync(runPath);

  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error.message, /ORCHESTRATION_STANDALONE_BUSY/);
  assert.deepEqual(fs.readFileSync(artifactPath), artifactBefore);
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('orchestrated finalization accepts one matching activated delegation without advancing it', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify({
    schemaVersion: 2,
    taskId: TASK_ID,
    runId: 'run-1',
    status: 'running',
    pendingDelegation: {
      id: 'receipt-1', taskId: TASK_ID, runId: 'run-1', role: 'reviewer', stage: 'review-analysis',
      round: 1, artifact: f.artifact, client: 'codex', status: 'activated'
    }
  }, null, 2)}\n`);
  const runBefore = fs.readFileSync(runPath);

  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact, '--orchestrated'
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'applied');
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('task-review rejects a numeric count mismatch without changing artifact bytes', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors'
  );
  const before = fs.readFileSync(path.join(f.dir, f.artifact));
  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact
  ]);

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'REVIEW_SUMMARY_COUNT_MISMATCH');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, f.artifact)), before);
});
