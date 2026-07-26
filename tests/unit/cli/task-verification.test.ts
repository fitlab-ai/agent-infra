import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VERIFICATION_CATALOG,
  verifyTaskEvent
} from '../../../lib/task/verification.ts';

const EXPECTED_EVENTS = [
  'analyze.awaiting-input', 'analyze.completed', 'review-analysis.completed',
  'plan.completed', 'review-plan.completed', 'code.completed', 'review-code.completed',
  'manual-validation.completed', 'block-task.completed', 'cancel-task.completed',
  'commit.completed', 'complete-task.preflight', 'complete-task.completed',
  'create-pr.completed', 'create-task.completed', 'import-codescan.completed',
  'import-dependabot.completed', 'import-issue.completed', 'watch-pr.completed'
] as const;

function fixture(state: 'active' | 'blocked' | 'completed' = 'active') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verification-unit-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\n---\n`);
  return { root, taskId, taskDir };
}

function engine(status: 'pass' | 'fail' | 'blocked') {
  return (input: { mode: string; skillName: string; checks: string[] }) => ({
    ...(input.mode === 'gate' ? { gate: status, checks: [] } : { status, type: input.checks[0], message: 'fixture' }),
    skill: input.skillName, summary: 'fixture summary', action: 'fixture action'
  });
}

test('verification catalog is a closed mapping of all nineteen business events', () => {
  assert.deepEqual(Object.keys(VERIFICATION_CATALOG).sort(), [...EXPECTED_EVENTS].sort());
  const expected = {
    'analyze.awaiting-input': ['analyze-task', 'active', 'checks', undefined, ['task-meta']],
    'analyze.completed': ['analyze-task', 'active', 'gate', 'analysis', undefined],
    'review-analysis.completed': ['review-analysis', 'active', 'gate', 'review-analysis', undefined],
    'plan.completed': ['plan-task', 'active', 'gate', 'plan', undefined],
    'review-plan.completed': ['review-plan', 'active', 'gate', 'review-plan', undefined],
    'code.completed': ['code-task', 'active', 'gate', 'code', undefined],
    'review-code.completed': ['review-code', 'active', 'gate', 'review-code', undefined],
    'manual-validation.completed': ['complete-manual-validation', 'active', 'gate', 'manual-validation', undefined],
    'block-task.completed': ['block-task', 'blocked', 'gate', undefined, undefined],
    'cancel-task.completed': ['cancel-task', 'completed', 'gate', undefined, undefined],
    'commit.completed': ['commit', 'active', 'gate', undefined, undefined],
    'complete-task.preflight': ['complete-task', 'active', 'checks', undefined, ['review-ledger', 'post-review-commit', 'platform-sync-preflight']],
    'complete-task.completed': ['complete-task', 'completed', 'gate', undefined, undefined],
    'create-pr.completed': ['create-pr', 'active', 'gate', undefined, undefined],
    'create-task.completed': ['create-task', 'active', 'gate', undefined, undefined],
    'import-codescan.completed': ['import-codescan', 'active', 'gate', undefined, undefined],
    'import-dependabot.completed': ['import-dependabot', 'active', 'gate', undefined, undefined],
    'import-issue.completed': ['import-issue', 'active', 'gate', undefined, undefined],
    'watch-pr.completed': ['watch-pr', 'active', 'gate', undefined, undefined]
  } as const;
  for (const event of EXPECTED_EVENTS) {
    const spec = VERIFICATION_CATALOG[event];
    assert.deepEqual([spec.skill, spec.expectedState, spec.mode, spec.artifactFamily, spec.checks], expected[event]);
  }
});

test('verification rejects workspace and artifact identity mismatches before invoking checks', () => {
  const f = fixture();
  let calls = 0;
  const checkEngine = (input: Parameters<ReturnType<typeof engine>>[0]) => { calls += 1; return engine('pass')(input); };
  const wrongState = verifyTaskEvent({ taskRef: f.taskId, event: 'block-task.completed' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(wrongState.error?.code, 'VERIFY_TASK_STATE_MISMATCH');
  const missingArtifact = verifyTaskEvent({ taskRef: f.taskId, event: 'code.completed' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(missingArtifact.error?.code, 'VERIFY_ARTIFACT_REQUIRED');
  const extraArtifact = verifyTaskEvent({ taskRef: f.taskId, event: 'commit.completed', artifact: 'code.md' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(extraArtifact.error?.code, 'VERIFY_ARTIFACT_UNEXPECTED');
  assert.equal(calls, 0);
});

test('preflight stops on the first non-pass and preserves blocked exit semantics', () => {
  const f = fixture();
  let calls = 0;
  const result = verifyTaskEvent({ taskRef: f.taskId, event: 'complete-task.preflight' }, {
    repoRoot: f.root,
    engine(input: Parameters<ReturnType<typeof engine>>[0]) { calls += 1; return engine('blocked')(input); }
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.invocations.length, 1);
  assert.equal(calls, 1);
});

test('unknown events fail with a stable orchestration error', () => {
  const f = fixture();
  const unknown = verifyTaskEvent({ taskRef: f.taskId, event: 'unknown.completed' }, { repoRoot: f.root });
  assert.equal(unknown.error?.code, 'VERIFY_EVENT_UNKNOWN');
});
