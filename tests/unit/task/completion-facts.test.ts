import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hasValidArtifactCompletion } from '../../../lib/task/completion-facts.ts';
import { createTempDir, recordArtifactCompletions } from '../../helpers.ts';

function fixture() {
  const taskDir = createTempDir('completion-facts-');
  fs.writeFileSync(path.join(taskDir, 'task.md'), '---\nid: TASK-20260101-000001\n---\n\n# Task\n');
  fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(taskDir, 'review-analysis.md'), '# Review Analysis\n');
  fs.writeFileSync(path.join(taskDir, 'analysis-r2.md'), '# Analysis Round 2\n');
  recordArtifactCompletions(taskDir, [
    { name: 'analysis.md' },
    { name: 'review-analysis.md', lifecycleInputs: ['analysis.md'] },
    { name: 'analysis-r2.md', lifecycleInputs: ['review-analysis.md'] }
  ]);
  return taskDir;
}

test('historical completion validates the captured input chain without latest-round lookups', () => {
  const taskDir = fixture();
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');

  assert.equal(hasValidArtifactCompletion(task, taskDir, 'analysis-r2.md', 'analyze.completed'), true);
});

test('changed historical input bytes invalidate dependent completion facts', () => {
  const taskDir = fixture();
  fs.writeFileSync(path.join(taskDir, 'review-analysis.md'), '# Changed Review Analysis\n');
  const task = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');

  assert.equal(hasValidArtifactCompletion(task, taskDir, 'analysis-r2.md', 'analyze.completed'), false);
});

test('missing or extra input receipt edges invalidate a completion fact', () => {
  const taskDir = fixture();
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');
  const withoutReceipts = task.replace(/\n## (?:产物生命周期收据|Artifact Lifecycle Receipts)\n[\s\S]*$/u, '');
  fs.writeFileSync(taskPath, withoutReceipts);
  assert.equal(hasValidArtifactCompletion(withoutReceipts, taskDir, 'analysis-r2.md', 'analyze.completed'), false);

  recordArtifactCompletions(taskDir, [{ name: 'analysis-r2.md', lifecycleInputs: ['review-analysis.md'] }]);
  const withExpectedReceipt = fs.readFileSync(taskPath, 'utf8');
  const extraReceipt = withExpectedReceipt.replace(
    /\| analysis\.completed \| analysis-r2\.md \| review-analysis\.md \| ([a-f0-9]{64}) \| ([^|]+) \|/u,
    '| analysis.completed | analysis-r2.md | analysis.md | $1 | $2 |'
  );
  fs.writeFileSync(taskPath, extraReceipt);
  assert.equal(hasValidArtifactCompletion(extraReceipt, taskDir, 'analysis-r2.md', 'analyze.completed'), false);
});
