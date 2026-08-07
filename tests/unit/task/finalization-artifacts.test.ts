import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMPLETION_BACKFILL_FAMILIES,
  inspectCompletionArtifacts
} from '../../../lib/task/finalization-artifacts.ts';

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-artifacts-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\n---\n`);
  return { repoRoot, taskId, taskDir };
}

test('completion inventory returns only canonical lifecycle artifacts in stable family and round order', () => {
  const f = fixture();
  try {
    for (const name of [
      'code.md', 'analysis-r2.md', 'plan.md', 'analysis.md',
      'manual-validation.md', 'pr-review.md', 'pr-review-r2.md'
    ]) fs.writeFileSync(path.join(f.taskDir, name), '# artifact\n');

    const result = inspectCompletionArtifacts(f.taskId, { repoRoot: f.repoRoot });
    assert.equal(result.status, 'ready');
    assert.deepEqual(COMPLETION_BACKFILL_FAMILIES, [
      'analysis', 'review-analysis', 'plan', 'review-plan',
      'code', 'review-code', 'manual-validation'
    ]);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.name), [
      'analysis.md', 'analysis-r2.md', 'plan.md', 'code.md', 'manual-validation.md'
    ]);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('completion inventory distinguishes an empty inventory from blocking topology diagnostics', () => {
  const f = fixture();
  try {
    assert.deepEqual(inspectCompletionArtifacts(f.taskId, { repoRoot: f.repoRoot }).artifacts, []);
    fs.writeFileSync(path.join(f.taskDir, 'analysis-r2.md'), '# gap\n');
    const result = inspectCompletionArtifacts(f.taskId, { repoRoot: f.repoRoot });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'ARTIFACT_TOPOLOGY_CONFLICT');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});
