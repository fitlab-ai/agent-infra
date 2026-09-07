import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLocalArtifact,
  type LocalArtifactFamily
} from '../../../lib/task/local-artifact-finalization.ts';
import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import { buildQualificationAudit, renderQualificationAudit } from '../../../lib/task/qualification-audit.ts';

const PLAN_SECTIONS = [
  ['问题理解', '范围说明'],
  ['约束条件', '当前契约'],
  ['方案对比', '采用方案 A'],
  ['技术方法', '实现方法'],
  ['实施步骤', '步骤一'],
  ['文件清单', '文件列表'],
  ['验证策略', '验证方法'],
  ['状态核对', '```text\n$ git status -s\n```']
] as const;

const CODE_SECTIONS = [
  ['实现输入', '本轮实现输入'],
  ['变更文件', '文件列表'],
  ['关键代码说明', '实现说明'],
  ['测试结果', '测试通过'],
  ['与方案的差异', '无'],
  ['供审查关注的内容', '完成门禁'],
  ['状态核对', '```text\n$ git status -s\n```'],
  ['证据原文', '验证输出']
] as const;

function artifact(family: LocalArtifactFamily = 'plan'): string {
  const taskId = 'TASK-20260101-000001';
  let content = renderArtifactSkeleton({ taskId, family, artifact: `${family}.md` }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  content = content.replace(
    '## 状态核对\n<!-- artifact-section:',
    '## 状态核对\n<!-- artifact-section:'
  );
  return content.replace('## 状态核对\n<!-- artifact-section:plan:state-check -->\n内容', '## 状态核对\n<!-- artifact-section:plan:state-check -->\n```text\n$ git status -s\n```')
    .replace('## 状态核对\n<!-- artifact-section:code:state-check -->\n内容', '## 状态核对\n<!-- artifact-section:code:state-check -->\n```text\n$ git status -s\n```')
    .replace('## 状态核对\n<!-- artifact-section:analysis:state-check -->\n内容', '## 状态核对\n<!-- artifact-section:analysis:state-check -->\n```text\n$ git status -s\n```');
}

function diagnostic(result: ReturnType<typeof validateLocalArtifact>, code: string) {
  assert.equal(result.ok, false);
  const match = result.diagnostics.find((item) => item.code === code);
  assert.ok(match, `expected diagnostic ${code}`);
  return match;
}

test('local artifact validation ignores fenced headings and commands', () => {
  const content = artifact().replace(
    '## 验证策略\n<!-- artifact-section:plan:verification -->\n内容',
    '```md\n## 验证策略：\n$ fake command\n```'
  );

  const result = validateLocalArtifact(content, { family: 'plan' });

  const missing = diagnostic(result, 'LOCAL_ARTIFACT_MISSING_SECTION');
  assert.equal(missing.repairable, false);
});

test('one visible required H2 with one trailing colon is repairable and preserves semantic digest', () => {
  const malformed = artifact().replace('## 验证策略\n', '## 验证策略：\n');
  const failed = validateLocalArtifact(malformed, { family: 'plan' });
  const repair = diagnostic(failed, 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION');

  assert.equal(repair.repairable, true);
  assert.equal(repair.from, '验证策略：');
  assert.equal(repair.to, '验证策略');
  assert.equal(repair.line, 28);

  const repaired = validateLocalArtifact(malformed.replace('## 验证策略：', '## 验证策略'), { family: 'plan' });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.semanticDigest, failed.semanticDigest);
});

test('non-whitelisted content changes and ambiguous candidates fail closed', () => {
  const valid = validateLocalArtifact(artifact(), { family: 'plan' });
  assert.equal(valid.ok, true);

  const changed = validateLocalArtifact(artifact().replace('## 验证策略\n<!-- artifact-section:plan:verification -->\n内容', '## 验证策略\n<!-- artifact-section:plan:verification -->\n验证方法已改变'), { family: 'plan' });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.semanticDigest, valid.semanticDigest);

  const changedWhitespace = validateLocalArtifact(artifact().replace('$ git status -s', '$ git status  -s'), { family: 'plan' });
  assert.equal(changedWhitespace.ok, true);
  assert.notEqual(changedWhitespace.semanticDigest, valid.semanticDigest);

  const duplicateCandidate = artifact().replace(
    '## 验证策略\n',
    '## 验证策略：\n'
  ).replace(
    '## 状态核对\n',
    '## 验证策略：\n验证方法\n\n## 状态核对\n'
  );
  const duplicate = validateLocalArtifact(duplicateCandidate, { family: 'plan' });
  const duplicateDiagnostic = diagnostic(duplicate, 'LOCAL_ARTIFACT_DUPLICATE_SECTION');
  assert.equal(duplicateDiagnostic.repairable, false);
});

test('code reports support the same one-line heading repair and semantic baseline', () => {
  const malformed = artifact('code').replace('## 测试结果\n', '## 测试结果：\n');
  const failed = validateLocalArtifact(malformed, { family: 'code' });
  const repair = diagnostic(failed, 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION');

  assert.equal(repair.repairable, true);
  assert.equal(repair.from, '测试结果：');
  assert.equal(repair.to, '测试结果');

  const repaired = validateLocalArtifact(malformed.replace('## 测试结果：', '## 测试结果'), { family: 'code' });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.semanticDigest, failed.semanticDigest);
});

test('code report validation binds qualification relations to the started input', () => {
  const task = `---
id: TASK-20260101-000001
code_input_artifact: plan.md
code_input_sha256: ${'a'.repeat(64)}
---

# Task

## 约束

| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Use the approved plan | derived | task-input | task.md | task.md#约束 |  |  |

## 候选与否决方案

| candidate_id | statement | status | constraint_ids | impact | evidence |
| --- | --- | --- | --- | --- | --- |
| A | Use the approved plan | pending | C-1 | bounded | task.md#候选与否决方案 |
`;
  const audit = buildQualificationAudit(task);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;
  const content = `${artifact('code')}\n## 资格审计\n\n${renderQualificationAudit(audit.audit)}\n`;
  const result = validateLocalArtifact(content, { family: 'code', taskContent: task, artifact: 'code.md' });
  const mismatch = diagnostic(result, 'LOCAL_QUALIFICATION_AUDIT_INVALID');
  assert.match(mismatch.message, /QUALIFICATION_UPSTREAM_RELATION_MISMATCH/);
});
