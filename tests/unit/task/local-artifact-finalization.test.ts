import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLocalArtifact,
  type LocalArtifactFamily
} from '../../../lib/task/local-artifact-finalization.ts';

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

function artifact(family: LocalArtifactFamily = 'plan'): string {
  const title = family === 'plan' ? '# 技术方案' : '# 需求分析报告';
  return [title, '', ...PLAN_SECTIONS.flatMap(([heading, body]) => [`## ${heading}`, body, ''])].join('\n');
}

function diagnostic(result: ReturnType<typeof validateLocalArtifact>, code: string) {
  assert.equal(result.ok, false);
  const match = result.diagnostics.find((item) => item.code === code);
  assert.ok(match, `expected diagnostic ${code}`);
  return match;
}

test('local artifact validation ignores fenced headings and commands', () => {
  const content = artifact().replace(
    '## 验证策略\n验证方法',
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
  assert.equal(repair.line, 21);

  const repaired = validateLocalArtifact(malformed.replace('## 验证策略：', '## 验证策略'), { family: 'plan' });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.semanticDigest, failed.semanticDigest);
});

test('non-whitelisted content changes and ambiguous candidates fail closed', () => {
  const valid = validateLocalArtifact(artifact(), { family: 'plan' });
  assert.equal(valid.ok, true);

  const changed = validateLocalArtifact(artifact().replace('验证方法', '验证方法已改变'), { family: 'plan' });
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
