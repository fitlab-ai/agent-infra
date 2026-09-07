import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';
import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';

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
  let content = renderArtifactSkeleton({ taskId: TASK_ID, family: scenario.family, artifact, locale: 'en' })
    .replaceAll('<!-- artifact-slot:empty -->', 'content');
  content = content.replace(
    `## Review Summary\n<!-- artifact-section:${scenario.family}:summary -->\ncontent`,
    `## Review Summary\n<!-- artifact-section:${scenario.family}:summary -->\n- **Overall Verdict**: Changes Requested\n${line}`
  );
  content = content.replace(
    `## Raw Evidence\n<!-- artifact-section:${scenario.family}:evidence -->\ncontent`,
    `## Raw Evidence\n<!-- artifact-section:${scenario.family}:evidence -->\n\`\`\`text\n$ git status -s\n\`\`\``
  );
  fs.writeFileSync(path.join(dir, artifact), content);
  return { root, dir, artifact };
}

function reviewReceipt(artifact: string, overrides: Record<string, unknown> = {}) {
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
    id: 'receipt-1', taskId: TASK_ID, runId: 'run-1', role: 'reviewer',
    stage: 'review-analysis', round: 1, artifact, client: 'codex',
    requestedModel: 'reviewer-model', requestedReasoningEffort: 'high',
    actualModel: 'reviewer-model', actualReasoningEffort: 'high',
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

function currentRun(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID, runId: 'run-1', status: 'running', nextStage: 'review-analysis',
    stepCount: 0, maxSteps: 24,
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
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun({
    pendingDelegation: reviewReceipt(f.artifact, {
      status: 'prepared', parentId: null, childId: null, spawnMode: null,
      actualModel: null, actualReasoningEffort: null, spawnDispatchMonotonicMs: null,
      activationDeadlineMonotonicMs: null, spawnDispatchedAt: null, activationDeadlineAt: null,
      startEvidenceMonotonicMs: null, activatedMonotonicMs: null, activatedAt: null
    })
  }), null, 2)}\n`);
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

test('standalone finalization ignores a current run without a pending delegation', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const runPath = path.join(f.dir, 'orchestration.json');
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun({
    status: 'completed', nextStage: null,
    commitAuthorization: { issuedAt: null, consumedAt: '2026-01-01T00:00:01.000Z' }
  }), null, 2)}\n`);
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
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun({
    pendingDelegation: reviewReceipt(f.artifact)
  }), null, 2)}\n`);
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
  fs.writeFileSync(runPath, `${JSON.stringify(currentRun({
    pendingDelegation: reviewReceipt(f.artifact)
  }), null, 2)}\n`);
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

test('task-review reports duplicate decision details without changing artifact bytes', () => {
  const scenario = scenarios[0];
  const f = fixture(
    scenario,
    '- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors'
  );
  const artifactPath = path.join(f.dir, f.artifact);
  fs.appendFileSync(
    artifactPath,
    '\n### AN-1: Short review\n\n- Short conclusion\n\n### AN-1: Formal detail [needs-human-decision]\n\n- **What needs a decision**: choose a repair\n'
  );
  const before = fs.readFileSync(artifactPath);

  const result = run(f.root, [
    TASK_ID, 'finalize-summary', '--stage', scenario.stage, '--artifact', f.artifact
  ]);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.error.code, 'REVIEW_DECISION_DETAIL_INVALID');
  assert.deepEqual(fs.readFileSync(artifactPath), before);
});
