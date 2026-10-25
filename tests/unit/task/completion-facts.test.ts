import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hasArtifactCompletionRecord, hasValidArtifactCompletion } from '../../../lib/task/completion-facts.ts';
import { sha256File, upsertArtifactReceipts } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import { hasOpenArtifactRound, validateArtifactPublication } from '../../../lib/task/artifact-lifecycle.ts';
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
  const missingTaskDir = fixture();
  const missingTaskPath = path.join(missingTaskDir, 'task.md');
  const validMissingBaseline = fs.readFileSync(missingTaskPath, 'utf8');
  assert.equal(hasValidArtifactCompletion(validMissingBaseline, missingTaskDir, 'analysis-r2.md', 'analyze.completed'), true);
  const withoutExpectedEdge = validMissingBaseline.replace(/^\| analysis\.completed \| analysis-r2\.md \| review-analysis\.md \|[^\n]*\n/mu, '');
  assert.notEqual(withoutExpectedEdge, validMissingBaseline);
  fs.writeFileSync(missingTaskPath, withoutExpectedEdge);
  assert.equal(hasValidArtifactCompletion(withoutExpectedEdge, missingTaskDir, 'analysis-r2.md', 'analyze.completed'), false);

  const extraTaskDir = fixture();
  const extraTaskPath = path.join(extraTaskDir, 'task.md');
  const validExtraBaseline = fs.readFileSync(extraTaskPath, 'utf8');
  assert.equal(hasValidArtifactCompletion(validExtraBaseline, extraTaskDir, 'analysis-r2.md', 'analyze.completed'), true);
  fs.writeFileSync(path.join(extraTaskDir, 'review-analysis-r2.md'), '# Another Review Analysis\n');
  const extraReceipt = {
    event: 'analysis.completed' as const,
    output: 'analysis-r2.md',
    input: 'review-analysis-r2.md',
    inputSha256: sha256File(path.join(extraTaskDir, 'review-analysis-r2.md')),
    completedAt: '2026-01-01 00:00:00+00:00'
  };
  const mutation = upsertArtifactReceipts(validExtraBaseline, [extraReceipt]);
  const withExtraReceipt = upsertSection(validExtraBaseline, mutation).content;
  assert.equal(hasValidArtifactCompletion(withExtraReceipt, extraTaskDir, 'analysis-r2.md', 'analyze.completed'), false);
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
    /- 2026-01-01 00:00:05\+00:00 — \*\*Analyze Task \(Round 2\)\*\* by codex — completed → analysis-r2\.md\n/u,
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
