import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { finalizeReviewSummary, preflightReviewSummary, prepareReviewSummaryCandidate } from '../../../../lib/task/review-finalization.ts';
import { getArtifactSchema, renderArtifactSkeleton } from '../../../../lib/task/artifact-schema.ts';
import { inspectArtifactContract } from '../../../../lib/task/artifact-operations.ts';
import { readArtifactRecoveryIntent } from '../../../../lib/task/artifact-repair-intent.ts';
import { updateTaskFrontmatter } from '../../../../lib/task/frontmatter.ts';
import {
  finalizeReviewSummaryContent,
  parseReviewSummary,
  parseVerdict,
  resolveCanonicalVerdict
} from '../../../../lib/task/review-artifacts.ts';

const counts = { blocker: 1, major: 2, minor: 3 };
const TASK_ID = 'TASK-20260101-000001';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const TEMPLATE_CASES = [
  { stage: 'analysis', family: 'review-analysis', locale: 'zh', relativePath: '.agents/skills/review-analysis/reference/report-template.md' },
  { stage: 'analysis', family: 'review-analysis', locale: 'en', relativePath: 'templates/.agents/skills/review-analysis/reference/report-template.en.md' },
  { stage: 'plan', family: 'review-plan', locale: 'zh', relativePath: '.agents/skills/review-plan/reference/report-template.md' },
  { stage: 'plan', family: 'review-plan', locale: 'en', relativePath: 'templates/.agents/skills/review-plan/reference/report-template.en.md' },
  { stage: 'code', family: 'review-code', locale: 'zh', relativePath: '.agents/skills/review-code/reference/report-template.md' },
  { stage: 'code', family: 'review-code', locale: 'en', relativePath: 'templates/.agents/skills/review-code/reference/report-template.en.md' }
] as const;

function officialTemplateSample(relativePath: string): string {
  const content = fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
  const sample = content.match(/```markdown\n([\s\S]*)\n```\s*$/);
  assert.ok(sample, `${relativePath} should include an official markdown sample`);
  return sample[1]!;
}

function filledOfficialReviewSample(
  family: 'review-analysis' | 'review-plan' | 'review-code',
  locale: 'zh' | 'en',
  relativePath: string,
  artifact: string
): string {
  const schema = getArtifactSchema(family);
  assert.ok(schema, `${relativePath} should map to an artifact schema`);
  const values: Record<string, string> = {
    '{review-round}': '1',
    '{review-artifact}': artifact,
    '{analysis-artifact}': 'analysis.md',
    '{plan-artifact}': 'plan.md',
    '{code-artifact}': 'code.md',
    '{reviewer-name}': 'codex',
    '{timestamp}': '2026-01-01 00:00:00+00:00',
    '{file-count and major modules}': '3 review modules',
    '{scope actually reviewed}': '3 review modules',
    '{本遍实际范围}': '3 个 review 模块',
    '{本轮实际范围}': '3 个 review 模块',
    '{通过 / 需要修改 / 拒绝}': '通过',
    '{Approved / Changes Requested / Rejected}': 'Approved',
    '{命令}': 'git status --short',
    '{command}': 'git status --short',
    '{本轮一次性从任务绑定 remote/base 读取的目标分支 SHA M；不可被后续实时目标覆盖}': 'a'.repeat(40),
    '{本轮一次性捕获的本地 HEAD R；必须等于本轮 HEAD}': 'a'.repeat(40),
    '{R 的兼容显示字段；必须与审查已检视提交相同}': 'a'.repeat(40),
    '{用于完整 diff/fingerprint 的 D；必须等于 merge-base(R, saved M)}': 'b'.repeat(40),
    '{git-workflow snapshot 输出的 fingerprint 字段}': `sha256:${'c'.repeat(64)}`,
    '{git-workflow snapshot 输出的 tree 字段}': 'd'.repeat(40),
    '{target branch SHA M read once from the task-bound remote/base at review start; never overwritten by a later live target}': 'a'.repeat(40),
    '{local HEAD R captured once for this round; must equal this round\'s HEAD}': 'a'.repeat(40),
    '{compatibility display of R; must equal Reviewed Head}': 'a'.repeat(40),
    '{D used for the complete diff/fingerprint; must equal merge-base(R, saved M)}': 'b'.repeat(40),
    '{fingerprint field from git-workflow snapshot}': `sha256:${'c'.repeat(64)}`,
    '{tree field from git-workflow snapshot}': 'd'.repeat(40)
  };
  let report = officialTemplateSample(relativePath);
  for (const [placeholder, value] of Object.entries(values)) report = report.replaceAll(placeholder, value);
  report = report.replace(
    /\n## (?:资格审计复核|Qualification Audit Review)\n[\s\S]*?(?=\n## (?:检视覆盖声明|Inspection Coverage)\n)/u,
    '\n'
  );
  report = `<!-- artifact-context:${TASK_ID}:${family}:1 -->\n${report}`;
  for (const section of schema.sections) {
    const heading = locale === 'zh' ? section.headings.zh : section.headings.en;
    const marker = `<!-- ${section.marker} -->`;
    const headingLine = `## ${heading}\n`;
    assert.equal(report.includes(`${headingLine}${marker}`), false, `${relativePath} should not already have ${marker}`);
    assert.ok(report.includes(headingLine), `${relativePath} should include ${heading}`);
    report = report.replace(headingLine, `${headingLine}${marker}\n`);
  }
  return report;
}

function officialTemplateDomainFixture(stage: 'analysis' | 'plan' | 'code', artifact: string, report: string) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'official-review-template-')));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const input of ['analysis.md', 'plan.md', 'code.md']) fs.writeFileSync(path.join(dir, input), '# input\n');
  const step = stage === 'analysis' ? 'Review Analysis' : stage === 'plan' ? 'Review Plan' : 'Review Code';
  fs.writeFileSync(path.join(dir, 'task.md'), `---
id: ${TASK_ID}
status: active
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## Activity Log

- 2026-01-01 00:00:00+00:00 — **${step} (Round 1) [started]** by codex — started
`);
  const artifactPath = path.join(dir, artifact);
  fs.writeFileSync(artifactPath, report);
  return { root, dir, artifactPath };
}

function domainFixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-finalization-')));
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
  const summary = `## 审查摘要
<!-- artifact-section:review-analysis:summary -->
- **总体结论**：通过
- **发现（AI 可处理）**：{unresolved-blockers} 阻塞项，{unresolved-major} 主要，{unresolved-minor} 次要
`;
  let review = renderArtifactSkeleton({ taskId: TASK_ID, family: 'review-analysis', artifact: 'review-analysis.md' })
    .replaceAll('<!-- artifact-slot:empty -->', '内容')
    .replace(/## 审查摘要\n<!-- artifact-section:review-analysis:summary -->\n内容/, summary.trimEnd())
    .replace('## 证据原文\n<!-- artifact-section:review-analysis:evidence -->\n内容', '## 证据原文\n<!-- artifact-section:review-analysis:evidence -->\n```text\n$ git status -s\n```');
  review += '\n### 审查决定\n通过\n';
  fs.writeFileSync(artifactPath, review);
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

test('official review template samples finalize for every stage and locale', () => {
  assert.equal(TEMPLATE_CASES.length, 6);

  for (const { stage, family, locale, relativePath } of TEMPLATE_CASES) {
    const artifact = `${family}.md`;
    const report = filledOfficialReviewSample(family, locale, relativePath, artifact);
    const schema = getArtifactSchema(family);
    assert.ok(schema);

    const structure = inspectArtifactContract(report, schema);
    assert.equal(
      structure.ok,
      true,
      `${relativePath}: ${structure.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`
    );

    const parsed = parseReviewSummary(report);
    assert.equal(parsed.ok, true, `${relativePath} should parse before finalization`);

    const fixture = officialTemplateDomainFixture(stage, artifact, report);
    try {
      const result = finalizeReviewSummary({ taskRef: TASK_ID, stage, artifact }, { repoRoot: fixture.root });
      assert.equal(result.status, 'applied', `${relativePath} should finalize`);
      assert.equal(result.error, null);

      const finalized = fs.readFileSync(fixture.artifactPath, 'utf8');
      const finalizedSummary = parseReviewSummary(finalized);
      assert.equal(finalizedSummary.ok, true, `${relativePath} should remain parseable after finalization`);
      if (finalizedSummary.ok) {
        assert.equal(finalizedSummary.summary.countState, 'numeric');
        assert.deepEqual(finalizedSummary.summary.counts, { blocker: 0, major: 0, minor: 0 });
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('review preflight seals every review family before ledger writes', () => {
  for (const { stage, family, locale, relativePath } of TEMPLATE_CASES) {
    const artifact = `${family}.md`;
    const fixture = officialTemplateDomainFixture(
      stage,
      artifact,
      filledOfficialReviewSample(family, locale, relativePath, artifact)
    );
    try {
      const taskBefore = fs.readFileSync(path.join(fixture.dir, 'task.md'), 'utf8');
      const result = preflightReviewSummary({ taskRef: TASK_ID, stage, artifact }, { repoRoot: fixture.root });

      assert.equal(result.status, 'passed', `${relativePath} should preflight`);
      assert.equal(result.error, null);
      assert.equal(fs.readFileSync(path.join(fixture.dir, 'task.md'), 'utf8'), taskBefore);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
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

test('review finalization revalidates a done-only current review artifact', () => {
  const f = domainFixture();
  const taskPath = path.join(f.dir, 'task.md');
  const taskContent = fs.readFileSync(taskPath, 'utf8').replace(
    '**Review Analysis (Round 1) [started]** by codex — started',
    '**Review Analysis (Round 1)** by codex — completed'
  );
  fs.writeFileSync(taskPath, taskContent, 'utf8');
  const result = finalizeReviewSummary(
    {
      taskRef: TASK_ID,
      stage: 'analysis',
      artifact: 'review-analysis.md'
    },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'applied');
});

test('review finalizer rejects a missing schema pattern before summary mutation', () => {
  const f = domainFixture();
  const before = fs.readFileSync(f.artifactPath, 'utf8');
  const invalid = before.replace('\n### 审查决定\n通过\n', '\n');
  fs.writeFileSync(f.artifactPath, invalid);

  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_ARTIFACT_STRUCTURE_INVALID');
  assert.match(result.error?.message ?? '', /ARTIFACT_REQUIRED_PATTERN_MISSING/);
  assert.equal(fs.readFileSync(f.artifactPath, 'utf8'), invalid);
});

test('review finalizer validates current content without a recovery candidate', () => {
  const f = domainFixture();
  const taskPath = path.join(f.dir, 'task.md');
  fs.writeFileSync(
    taskPath,
    fs.readFileSync(taskPath, 'utf8').replace(/- 2026-01-01 00:00:00\+00:00 — \*\*Review Analysis \(Round 1\) \[started\]\*\* by codex — started\n/u, '')
  );
  const invalid = fs.readFileSync(f.artifactPath, 'utf8').replace('\n### 审查决定\n通过\n', '\n');
  fs.writeFileSync(f.artifactPath, invalid);

  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_ARTIFACT_STRUCTURE_INVALID');
  assert.equal(readArtifactRecoveryIntent(f.root, TASK_ID, 'review-analysis', 'review-analysis.md'), null);
  assert.equal(fs.readFileSync(f.artifactPath, 'utf8'), invalid);
});

test('projection review preparation enforces the same artifact contract without publishing', () => {
  const f = domainFixture();
  try {
    const before = fs.readFileSync(f.artifactPath, 'utf8');
    const invalid = before.replace('\n### 审查决定\n通过\n', '\n');
    const prepared = prepareReviewSummaryCandidate(
      { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
      invalid,
      { repoRoot: f.root }
    );
    assert.equal(prepared.result.status, 'failed');
    assert.equal(prepared.result.error?.code, 'REVIEW_ARTIFACT_STRUCTURE_INVALID');
    assert.equal(fs.readFileSync(f.artifactPath, 'utf8'), before);
    assert.equal(readArtifactRecoveryIntent(f.root, TASK_ID, 'review-analysis', 'review-analysis.md'), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('review finalizer accepts a directly repaired formal artifact', () => {
  const f = domainFixture();
  const valid = fs.readFileSync(f.artifactPath, 'utf8');
  const malformed = valid.replace('## 检视覆盖声明\n', '');
  fs.writeFileSync(f.artifactPath, malformed);

  const failed = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'REVIEW_ARTIFACT_STRUCTURE_INVALID');
  fs.writeFileSync(f.artifactPath, valid);

  const finalized = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );
  assert.equal(finalized.status, 'applied');

  const retry = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );
  assert.equal(retry.status, 'no-op');
});

test('review finalizer refinalizes a changed passed artifact directly', () => {
  const f = domainFixture();
  try {
    const first = finalizeReviewSummary(
      { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
      { repoRoot: f.root }
    );
    assert.equal(first.error, null);
    fs.chmodSync(f.artifactPath, 0o600);
    fs.appendFileSync(f.artifactPath, '\n补充审查证据\n');

    const second = finalizeReviewSummary(
      { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
      { repoRoot: f.root }
    );
    assert.equal(second.error, null);
    assert.notEqual(second.artifactSha256, first.artifactSha256);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('review finalizer keeps an invalid formal artifact until it is directly repaired', () => {
  const f = domainFixture();
  const malformed = fs.readFileSync(f.artifactPath, 'utf8').replace('## 检视覆盖声明\n', '');
  fs.writeFileSync(f.artifactPath, malformed);

  const first = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );
  assert.equal(first.status, 'failed');
  const beforeRetry = fs.readFileSync(f.artifactPath, 'utf8');
  fs.writeFileSync(f.artifactPath, beforeRetry.replace('- **总体结论**：通过', '- **总体结论**：需要修改'));
  const second = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(second.status, 'failed');
  assert.equal(second.error?.code, 'REVIEW_ARTIFACT_STRUCTURE_INVALID');
  assert.notEqual(fs.readFileSync(f.artifactPath, 'utf8'), beforeRetry);
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

test('review summary parser ignores fenced examples and reads the visible summary', () => {
  const parsed = parseReviewSummary(`# Review

\`\`\`markdown
## Review Summary
- **Overall Verdict**: Rejected
- **Findings (AI-actionable)**: 9 blockers, 0 majors, 0 minors
\`\`\`

## Review Summary
- **Overall Verdict**: Approved
- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors
`);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.summary.verdict, 'Approved');
});

test('review finalization fails closed and preserves a clearly informal duplicate', () => {
  const f = domainFixture();
  fs.appendFileSync(
    f.artifactPath,
    `\n### AN-1：简短复核\n\n- 简短结论\n\n### AN-1：正式详情 [needs-human-decision]\n\n- **要决定什么**：选择方案\n`
  );
  const before = fs.readFileSync(f.artifactPath);
  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_DECISION_DETAIL_INVALID');
  assert.deepEqual(fs.readFileSync(f.artifactPath), before);
});

test('review finalization preserves anchored informal duplicates byte-for-byte', () => {
  const f = domainFixture();
  fs.appendFileSync(
    f.artifactPath,
    '\n<a id="old-review"></a>\n### AN-1：简短复核\n\n- 简短结论\n\n### AN-1：正式详情 [needs-human-decision]\n\n- **要决定什么**：选择方案\n'
  );
  const before = fs.readFileSync(f.artifactPath);
  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_DECISION_DETAIL_INVALID');
  assert.deepEqual(fs.readFileSync(f.artifactPath), before);
});

test('review finalization fails closed and preserves ambiguous decision-detail duplicates', () => {
  const f = domainFixture();
  fs.appendFileSync(
    f.artifactPath,
    `\n### AN-1：第一个详情 [needs-human-decision]\n\n- **要决定什么**：A\n\n### AN-1：第二个详情 [needs-human-decision]\n\n- **要决定什么**：B\n`
  );
  const before = fs.readFileSync(f.artifactPath, 'utf8');
  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_DECISION_DETAIL_INVALID');
  assert.equal(fs.readFileSync(f.artifactPath, 'utf8'), before);
});

test('review finalization preserves substantive unmarked duplicate details byte-for-byte', () => {
  const f = domainFixture();
  fs.appendFileSync(
    f.artifactPath,
    '\n### AN-1：上一轮复核理由\n\nPrevious review rationale\nThe earlier review recorded the cause and risk for this behavior.\n\n### AN-1：正式详情 [needs-human-decision]\n\n- **要决定什么**：选择方案\n'
  );
  const before = fs.readFileSync(f.artifactPath);
  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_DECISION_DETAIL_INVALID');
  assert.deepEqual(fs.readFileSync(f.artifactPath), before);
});

test('review finalization preserves summary-marked substantive duplicates byte-for-byte', () => {
  const f = domainFixture();
  fs.appendFileSync(
    f.artifactPath,
    '\n### AN-1: Security summary\n\n- privilege escalation allows unauthorized access\n\n### AN-1: Formal decision [needs-human-decision]\n\n- **What needs a decision**: choose the safe boundary\n'
  );
  const before = fs.readFileSync(f.artifactPath);
  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_DECISION_DETAIL_INVALID');
  assert.deepEqual(fs.readFileSync(f.artifactPath), before);
});

test('review finalization preserves a completed review artifact byte-for-byte', () => {
  const f = domainFixture();
  const taskPath = path.join(f.dir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');
  const fact = {
    version: 2, event: 'review-analysis.completed', output: 'review-analysis.md',
    outputSha256: 'a'.repeat(64), semanticDigest: 'b'.repeat(64), requestId: 'review-1', result: '{}',
    inputDigest: 'c'.repeat(64), resultDigest: 'd'.repeat(64)
  };
  fs.writeFileSync(taskPath, updateTaskFrontmatter(task, { completion_facts: JSON.stringify([fact]) }));
  const before = fs.readFileSync(f.artifactPath);

  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /completed artifact/u);
  assert.deepEqual(fs.readFileSync(f.artifactPath), before);
});

test('review finalization ignores fenced examples but preserves visible duplicates', () => {
  const f = domainFixture();
  fs.appendFileSync(
    f.artifactPath,
    '\n~~~~md `example`\n### AN-1：示例 [needs-human-decision]\n~~~~\n\n### AN-1：正式详情 [needs-human-decision]\n\n- **要决定什么**：选择方案\n\n### AN-1：简短复核\n\n- 简短结论\n'
  );
  const result = finalizeReviewSummary(
    { taskRef: TASK_ID, stage: 'analysis', artifact: 'review-analysis.md' },
    { repoRoot: f.root }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REVIEW_DECISION_DETAIL_INVALID');
});
