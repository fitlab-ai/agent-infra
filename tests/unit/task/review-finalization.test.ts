import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { finalizeReviewSummary } from '../../../lib/task/review-finalization.ts';
import {
  finalizeReviewSummaryContent,
  parseReviewSummary,
  parseVerdict,
  resolveCanonicalVerdict
} from '../../../lib/task/review-artifacts.ts';

const counts = { blocker: 1, major: 2, minor: 3 };
const TASK_ID = 'TASK-20260101-000001';

function domainFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-finalization-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(dir, 'task.md'), `---
id: ${TASK_ID}
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## Activity Log

- 2026-01-01 00:00:00+00:00 — **Review Analysis (Round 1) [started]** by codex — started
`);
  const artifactPath = path.join(dir, 'review-analysis.md');
  fs.writeFileSync(artifactPath, `# Review

- **Review Input**: \`analysis.md\`

## Review Summary

- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors
`);
  return { root, dir, artifactPath };
}

test('review summary parser distinguishes canonical placeholders and numeric counts', () => {
  const placeholders = parseReviewSummary(`## Review Summary

- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors / **Manual validation**: 0
`);
  assert.equal(placeholders.ok, true);
  if (placeholders.ok) {
    assert.equal(placeholders.summary.countState, 'placeholders');
    assert.equal(placeholders.summary.counts, null);
    assert.equal(placeholders.summary.manualValidation, 0);
  }

  const numeric = parseReviewSummary(`## 审查摘要

- **总体结论**：需要修改
- **发现（AI 可处理）**：1 阻塞项，2 主要，3 次要 / **人工校验**：0
`);
  assert.equal(numeric.ok, true);
  if (numeric.ok) {
    assert.equal(numeric.summary.countState, 'numeric');
    assert.deepEqual(numeric.summary.counts, counts);
    assert.equal(numeric.summary.verdict, 'Changes Requested');
    assert.equal(numeric.summary.manualValidation, 0);
  }
});

test('canonical verdict rejects approved non-zero findings and unresolved placeholders', () => {
  assert.deepEqual(
    resolveCanonicalVerdict({ verdict: 'Approved', counts: { blocker: 1, major: 0, minor: 0 }, manualValidation: 0, countState: 'numeric' }),
    {
      ok: false,
      verdict: null,
      code: 'REVIEW_VERDICT_FINDING_MISMATCH',
      message: 'Approved verdict requires zero finalized findings'
    }
  );
  const pending = resolveCanonicalVerdict({ verdict: 'Approved', counts: null, manualValidation: 0, countState: 'placeholders' });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.code, 'REVIEW_FINDING_COUNTS_NOT_FINALIZED');
});

test('path verdict resolver preserves artifact and summary diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verdict-'));
  try {
    const missing = parseVerdict(path.join(root, 'missing.md'));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'REVIEW_ARTIFACT_NOT_FOUND');
    const artifact = path.join(root, 'review.md');
    fs.writeFileSync(artifact, '## Review Summary\n\n- **Overall Verdict**: Approved\n- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors\n');
    const placeholder = parseVerdict(artifact);
    assert.equal(placeholder.ok, false);
    if (!placeholder.ok) assert.equal(placeholder.code, 'REVIEW_FINDING_COUNTS_NOT_FINALIZED');
    fs.writeFileSync(artifact, '## Review Summary\n\n- **Overall Verdict**: Approved\n- **Findings (AI-actionable)**: 1 blocker, 0 majors, 0 minors\n');
    const mismatch = parseVerdict(artifact);
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.code, 'REVIEW_VERDICT_FINDING_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review summary finalization replaces only the canonical summary tokens', () => {
  const content = `# Review

## Review Summary

- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors / **Manual validation**: 0

## Evidence

\`{unresolved-blockers}\`
`;
  const result = finalizeReviewSummaryContent(content, counts);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, true);
    assert.match(result.content, /1 blockers, 2 majors, 3 minors/);
    assert.match(result.content, /`\{unresolved-blockers\}`/);
  }
});

test('review finalization does not treat a done-only historical row as an open round', () => {
  const f = domainFixture();
  const taskPath = path.join(f.dir, 'task.md');
  const taskContent = fs.readFileSync(taskPath, 'utf8').replace(
    '**Review Analysis (Round 1) [started]** by codex — started',
    '**Review Analysis (Round 1)** by codex — completed'
  );
  fs.writeFileSync(taskPath, taskContent, 'utf8');
  const before = fs.readFileSync(f.artifactPath, 'utf8');

  const result = finalizeReviewSummary(
    {
      taskRef: TASK_ID,
      stage: 'analysis',
      artifact: 'review-analysis.md'
    },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_ARTIFACT_IDENTITY_INVALID');
  assert.equal(fs.readFileSync(f.artifactPath, 'utf8'), before);
});

test('review summary finalization is idempotent and rejects mismatched numeric counts', () => {
  const content = `## 审查摘要

- **总体结论**：通过
- **发现（AI 可处理）**：1 阻塞项，2 主要，3 次要 / **人工校验**：0
`;
  const same = finalizeReviewSummaryContent(content, counts);
  assert.deepEqual(same, { ok: true, changed: false, content });

  const mismatch = finalizeReviewSummaryContent(content, { blocker: 0, major: 0, minor: 0 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, 'REVIEW_SUMMARY_COUNT_MISMATCH');
});

test('review summary parser fails closed on partial, mixed, or duplicate summary fields', () => {
  const invalid = [
    `## Review Summary

- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, 0 majors, {unresolved-minor} minors
`,
    `## 审查摘要

- **总体结论**：通过
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要
`,
    `## Review Summary

- **Overall Verdict**: Approved

## Review Summary

- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors
`
  ];

  for (const content of invalid) assert.equal(parseReviewSummary(content).ok, false);
});

test('review finalization preserves the artifact when atomic rename fails', () => {
  const f = domainFixture();
  const before = fs.readFileSync(f.artifactPath);
  const result = finalizeReviewSummary(
    {
      taskRef: TASK_ID,
      stage: 'analysis',
      artifact: 'review-analysis.md'
    },
    {
      repoRoot: f.root,
      randomSuffix: () => 'rename-failure',
      fileSystem: { renameSync: () => { throw new Error('rename failed'); } }
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_RENAME_FAILED');
  assert.deepEqual(fs.readFileSync(f.artifactPath), before);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.includes('.tmp-')), false);
});

test('review finalization detects a target conflict and removes its temporary file', () => {
  const f = domainFixture();
  const before = fs.readFileSync(f.artifactPath, 'utf8');
  let artifactReads = 0;
  const result = finalizeReviewSummary(
    {
      taskRef: TASK_ID,
      stage: 'analysis',
      artifact: 'review-analysis.md'
    },
    {
      repoRoot: f.root,
      randomSuffix: () => 'target-conflict',
      fileSystem: {
        readFileSync: (file) => {
          const content = fs.readFileSync(file, 'utf8');
          if (file === f.artifactPath && ++artifactReads === 2) return `${content}\nchanged`;
          return content;
        }
      }
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_ARTIFACT_CONFLICT');
  assert.equal(fs.readFileSync(f.artifactPath, 'utf8'), before);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.includes('.tmp-')), false);
});
