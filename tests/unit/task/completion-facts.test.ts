import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hasArtifactCompletionRecord, hasValidArtifactCompletion } from '../../../lib/task/completion-facts.ts';
import { hasOpenArtifactRound, validateArtifactPublication } from '../../../lib/task/artifact-lifecycle.ts';
import { createTempDir, recordArtifactCompletions } from '../../helpers.ts';

function fixture() {
  const taskDir = createTempDir('completion-facts-');
  fs.writeFileSync(path.join(taskDir, 'task.md'), '---\nid: TASK-20260101-000001\n---\n\n# Task\n');
  fs.writeFileSync(path.join(taskDir, 'review-analysis.md'), '# Review Analysis\n');
  fs.writeFileSync(path.join(taskDir, 'analysis-r2.md'), '# Analysis Round 2\n');
  recordArtifactCompletions(taskDir, [{ name: 'analysis-r2.md', lifecycleInputs: ['review-analysis.md'] }]);
  return taskDir;
}

test('completion facts without optional lifecycleInputs still validate their own output', () => {
  const taskDir = fixture();
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');
  const facts = JSON.parse(/^completion_facts: '(.+)'$/mu.exec(task)![1]!) as Array<Record<string, unknown>>;
  delete facts[0]!.lifecycleInputs;
  const withoutOptionalInputs = task.replace(/^completion_facts:.*$/mu, `completion_facts: '${JSON.stringify(facts)}'`);

  assert.equal(hasValidArtifactCompletion(withoutOptionalInputs, taskDir, 'analysis-r2.md', 'analyze.completed'), true);
});

test('identity-bearing malformed completion facts remain present and invalid', () => {
  const taskDir = fixture();
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');
  const facts = JSON.parse(/^completion_facts: '(.+)'$/mu.exec(task)![1]!) as Array<Record<string, unknown>>;
  facts.find((fact) => fact.output === 'analysis-r2.md')!.outputSha256 = 'broken';
  const damaged = task.replace(/^completion_facts:.*$/mu, `completion_facts: '${JSON.stringify(facts)}'`);
  assert.equal(hasArtifactCompletionRecord(damaged, 'analysis-r2.md', 'analyze.completed'), true);
  assert.equal(hasValidArtifactCompletion(damaged, taskDir, 'analysis-r2.md', 'analyze.completed'), false);
  const openStarted = damaged.replace(
    /- 2026-01-01 00:00:01\+00:00 — \*\*Analyze Task \(Round 2\)\*\* by codex — completed → analysis-r2\.md\n/u,
    ''
  );
  fs.writeFileSync(taskPath, openStarted);
  assert.throws(() => hasOpenArtifactRound(taskDir, openStarted, 'analysis', 2), /completion evidence.*invalid/u);
  assert.notEqual(validateArtifactPublication(taskDir, 'analysis', 'analysis-r2.md'), null);
});

test('missing and empty completion facts remain resumable while a present scalar fails closed', () => {
  const taskDir = createTempDir('completion-facts-empty-');
  const taskPath = path.join(taskDir, 'task.md');
  fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# Analysis\n');
  const task = '---\nid: TASK-20260101-000001\n---\n\n# Task\n\n## Activity Log\n\n- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started\n';
  fs.writeFileSync(taskPath, task);
  const withoutFacts = task;
  const emptyFacts = task.replace('\n---\n', "\ncompletion_facts: '[]'\n---\n");

  assert.equal(hasArtifactCompletionRecord(withoutFacts, 'analysis.md', 'analyze.completed'), false);
  assert.equal(hasOpenArtifactRound(taskDir, withoutFacts, 'analysis', 1), true);
  fs.writeFileSync(taskPath, withoutFacts);
  assert.equal(validateArtifactPublication(taskDir, 'analysis', 'analysis.md'), null);
  assert.equal(hasArtifactCompletionRecord(emptyFacts, 'analysis.md', 'analyze.completed'), false);
  assert.equal(hasOpenArtifactRound(taskDir, emptyFacts, 'analysis', 1), true);

  fs.writeFileSync(taskPath, emptyFacts);
  assert.equal(validateArtifactPublication(taskDir, 'analysis', 'analysis.md'), null);
  const scalarFacts = task.replace('\n---\n', '\ncompletion_facts: 42\n---\n');
  assert.equal(hasArtifactCompletionRecord(scalarFacts, 'analysis.md', 'analyze.completed'), true);
  assert.throws(() => hasOpenArtifactRound(taskDir, scalarFacts, 'analysis', 1), /completion evidence.*invalid/u);
  fs.writeFileSync(taskPath, scalarFacts);
  assert.notEqual(validateArtifactPublication(taskDir, 'analysis', 'analysis.md'), null);
});
