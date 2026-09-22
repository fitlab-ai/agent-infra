import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { convertCompletionFacts } from '../../../lib/task/artifact-fact-conversion.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { sha256File } from '../../../lib/task/artifact-receipts.ts';
import { parseTypedTaskFrontmatter } from '../../../lib/task/frontmatter.ts';
import { updateTaskFrontmatter } from '../../../lib/task/frontmatter.ts';
import { buildQualificationAudit, renderQualificationAudit } from '../../../lib/task/qualification-audit.ts';
import { withTaskExecutionLock } from '../../../lib/task/task-execution-lock.ts';

test('explicit fact conversion validates legacy evidence and writes version 2 atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-fact-conversion-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(taskDir, { recursive: true });
  const artifactPath = path.join(taskDir, 'analysis.md');
  const taskPath = path.join(taskDir, 'task.md');
  const task = [
    '---', 'id: TASK-20260101-000001', 'status: active', 'current_step: requirement-analysis', 'agent_infra_version: v0.11.4-alpha.0',
    '---', '', '# Task', '', '## Task Input', '', 'Stable input.', '',
    '## Constraints', '',
    '| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| C-1 | Preserve history | assumption | task-input | task.md | task.md#constraints |  |  |', '',
    '## Candidate and Rejected Options', '',
    '| candidate_id | statement | status | constraint_ids | impact | evidence |',
    '| --- | --- | --- | --- | --- | --- |', '',
    '## Review Disagreement Ledger', '',
    '| id | stage | round | severity | status | evidence |',
    '| --- | --- | --- | --- | --- | --- |', ''
  ].join('\n');
  fs.writeFileSync(taskPath, task);
  const audit = buildQualificationAudit(task);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;
  const artifact = [
    '# Analysis', '', '## Flow Decision', '',
    '- **Path**: streamlined', '- **Basis**: bounded change',
    '- **Unmet Higher-path Conditions**: none', '- **Upgrade Triggers**: new scope', '',
    '## Qualification Audit', '', renderQualificationAudit(audit.audit), ''
  ].join('\n');
  fs.writeFileSync(artifactPath, artifact);
  const legacy = [{
    event: 'analyze.completed', output: 'analysis.md', outputSha256: sha256File(artifactPath),
    semanticDigest: canonicalSemanticDigest(artifact), requestId: 'analysis-1', result: '{}'
  }];
  fs.writeFileSync(taskPath, updateTaskFrontmatter(task, { completion_facts: JSON.stringify(legacy) }));

  try {
    const result = convertCompletionFacts('TASK-20260101-000001', { repoRoot: root });
    assert.equal(result.status, 'applied', JSON.stringify(result));
    assert.equal(result.converted, 1);
    const frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(taskPath, 'utf8'));
    const converted = JSON.parse(String(frontmatter.completion_facts));
    assert.equal(converted[0].version, 2);
    assert.match(converted[0].inputDigest, /^[a-f0-9]{64}$/u);
    assert.match(converted[0].resultDigest, /^[a-f0-9]{64}$/u);
    assert.equal(converted[0].selectionReason, 'converted-v1');

    const convertedBytes = fs.readFileSync(taskPath);
    fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('Stable input.', 'Changed input.'));
    const changedBytes = fs.readFileSync(taskPath);
    const repeated = convertCompletionFacts('TASK-20260101-000001', { repoRoot: root });
    assert.equal(repeated.status, 'no-op');
    assert.deepEqual(fs.readFileSync(taskPath), changedBytes);
    assert.notDeepEqual(changedBytes, convertedBytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fact conversion refuses to bypass an active task execution lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-fact-conversion-lock-'));
  const id = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), [
    '---', `id: ${id}`, 'status: active', 'current_step: requirement-analysis',
    `completion_facts: '${JSON.stringify([])}'`, '---', '', '# Task', ''
  ].join('\n'));
  try {
    const result = withTaskExecutionLock(root, id, 'test-holder', () => convertCompletionFacts(id, { repoRoot: root }));
    assert.equal(result.status, 'failed');
    assert.match(result.error?.code ?? '', /LOCK/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fact conversion leaves malformed legacy evidence unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-fact-conversion-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  fs.mkdirSync(taskDir, { recursive: true });
  const original = [
    '---', 'id: TASK-20260101-000001', 'status: active', 'current_step: requirement-analysis',
    `completion_facts: '${JSON.stringify([{ event: 'analyze.completed', output: 'analysis.md' }])}'`,
    '---', '', '# Task', ''
  ].join('\n');
  fs.writeFileSync(path.join(taskDir, 'task.md'), original);
  try {
    const result = convertCompletionFacts('TASK-20260101-000001', { repoRoot: root });
    assert.equal(result.status, 'failed');
    assert.equal(fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
