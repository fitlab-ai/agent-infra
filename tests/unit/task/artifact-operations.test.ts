import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getArtifactSchema, renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import {
  canonicalSemanticDigest,
  initializeArtifactSkeleton,
  inspectArtifactContract,
  inspectArtifactStructure
} from '../../../lib/task/artifact-operations.ts';
import { validateQualificationAudit } from '../../../lib/task/qualification-audit.ts';

const qualificationTask = `---
id: TASK-20260101-000001
---

## 约束

| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Keep the current contract. | assumption | test | test | unit test |  |  |

## 候选与否决方案

| candidate_id | statement | status | constraint_ids | impact | evidence |
| --- | --- | --- | --- | --- | --- |
| A | Use the current implementation. | pending | C-1 | requires qualification | unit test |
`;

test('artifact initialization renders a valid qualification audit for every workflow family', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-init-qualification-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), qualificationTask);

  for (const family of ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'] as const) {
    const artifact = `${family}.md`;
    const initialized = initializeArtifactSkeleton({ repoRoot: root, taskId, taskDir, family, artifact });
    assert.equal(initialized.status, 'applied', `${family}: ${JSON.stringify(initialized.error)}`);
    const content = fs.readFileSync(path.join(taskDir, artifact), 'utf8');
    assert.equal(validateQualificationAudit(qualificationTask, content, { family, artifact, require: true }).ok, true);
  }
});

test('structure inspection retains fence diagnostics and ignores fenced headings', () => {
  const schema = getArtifactSchema('plan')!;
  const filled = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family: 'plan', artifact: 'plan.md' })
    .replaceAll('<!-- artifact-slot:empty -->', 'body');
  for (const eol of ['\n', '\r\n']) {
    for (const [example, expected] of [
      ['~~~~md`\n## 问题理解：\n~~~\n## 问题理解\n~~~~', []],
      ['````md\n## 问题理解：\n```\n## 问题理解\n`````', []],
      ['```md\n## 问题理解：\n~~~', ['ARTIFACT_UNCLOSED_FENCE']],
      ['~~~~\n## 问题理解：\n~~~', ['ARTIFACT_UNCLOSED_FENCE']]
    ] as const) {
      const content = (filled + '\n' + example + '\n').replaceAll('\n', eol);
      const result = inspectArtifactStructure(content, schema);
      assert.deepEqual(result.diagnostics.map((item) => item.code), expected);
      assert.equal(result.semanticDigest, canonicalSemanticDigest(content));
    }
  }
});

test('structure inspection reports punctuation and missing sections without proposing mutations', () => {
  const schema = getArtifactSchema('plan')!;
  const valid = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family: 'plan', artifact: 'plan.md' })
    .replaceAll('<!-- artifact-slot:empty -->', '内容');
  const malformed = valid
    .replace('## 问题理解\n', '## 问题理解：\n')
    .replace('## 约束条件\n', '');
  const result = inspectArtifactStructure(malformed, schema);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'ARTIFACT_HEADING_TRAILING_PUNCTUATION'), true);
  assert.equal(result.diagnostics.some((item) => item.code === 'ARTIFACT_MISSING_SECTION'), true);
});

test('structure inspection fails closed for empty sections and reordered sections', () => {
  const schema = getArtifactSchema('plan')!;
  const valid = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family: 'plan', artifact: 'plan.md' })
    .replaceAll('<!-- artifact-slot:empty -->', '内容');
  const emptyBody = valid.replace('## 约束条件\n<!-- artifact-section:plan:constraints -->\n内容', '## 约束条件\n<!-- artifact-section:plan:constraints -->\n<!-- artifact-slot:empty -->');
  const empty = inspectArtifactStructure(emptyBody, schema);
  assert.equal(empty.ok, false);
  assert.ok(empty.diagnostics.some((item) => item.code === 'ARTIFACT_EMPTY_SECTION'));

  const first = '## 问题理解\n<!-- artifact-section:plan:understanding -->\n内容\n\n';
  const second = '## 约束条件\n<!-- artifact-section:plan:constraints -->\n内容\n\n';
  const reordered = valid.replace(first + second, second + first);
  const order = inspectArtifactStructure(reordered, schema);
  assert.equal(order.ok, false);
  assert.ok(order.diagnostics.some((item) => item.code === 'ARTIFACT_SECTION_ORDER_INVALID'));
});

test('structure inspection reports trailing punctuation for all registered families', () => {
  const families = ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'] as const;

  for (const family of families) {
    const artifact = `${family}.md`;
    const content = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family, artifact })
      .replaceAll('<!-- artifact-slot:empty -->', '内容');
    const [first, second] = getArtifactSchema(family)!.sections;
    const malformed = content
      .replace(`## ${first!.headings.zh}\n`, `## ${first!.headings.zh}：\n`)
      .replace(`## ${second!.headings.zh}\n`, `## ${second!.headings.zh}:\n`);
    const inspection = inspectArtifactStructure(malformed, getArtifactSchema(family)!);

    assert.equal(inspection.ok, false, family);
    assert.equal(
      inspection.diagnostics.filter((item) => item.code === 'ARTIFACT_HEADING_TRAILING_PUNCTUATION').length,
      2,
      family
    );
  }
});

test('shared artifact contract enforces localized review patterns from the schema registry', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const content = renderArtifactSkeleton({
      taskId: 'TASK-20260101-000001',
      family: 'review-code',
      artifact: 'review-code.md',
      locale
    }).replaceAll('<!-- artifact-slot:empty -->', 'content')
      + (locale === 'en'
        ? '\n### Approval Decision\nChanges Requested\n- **Overall Verdict**: Changes Requested\n- **Review Baseline Commit**: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\n- **Reviewed Diff Base**: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n- **Reviewed Diff Fingerprint**: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n- **Reviewed Snapshot Tree**: dddddddddddddddddddddddddddddddddddddddd\n$ git status -s\n'
        : '\n### 审查决定\n需要修改\n- **总体结论**：需要修改\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n- **审查基线提交**：`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\n- **审查差异基线**：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n- **审查差异指纹**：sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n- **审查快照树**：dddddddddddddddddddddddddddddddddddddddd\n$ git status -s\n');
    assert.equal(inspectArtifactContract(content, getArtifactSchema('review-code')!).ok, true, locale);

    const invalid = content.replace(/^### (?:审查决定|Approval Decision)$/m, '### Decision');
    const result = inspectArtifactContract(invalid, getArtifactSchema('review-code')!);
    assert.equal(result.ok, false, locale);
    assert.ok(result.diagnostics.some((item) => item.code === 'ARTIFACT_REQUIRED_PATTERN_MISSING'), locale);
  }
});
