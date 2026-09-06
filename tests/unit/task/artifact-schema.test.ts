import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_SCHEMAS,
  getArtifactSchema,
  renderArtifactSkeleton
} from '../../../lib/task/artifact-schema.ts';
import { inspectArtifactStructure } from '../../../lib/task/artifact-operations.ts';

test('artifact schema registry defines the six workflow families with unique ordered sections', () => {
  assert.equal(ARTIFACT_SCHEMAS.length, 6);
  const ids = new Set<string>();
  for (const schema of ARTIFACT_SCHEMAS) {
    assert.ok(schema.sections.length > 0);
    let previousOrder = 0;
    for (const section of schema.sections) {
      assert.ok(section.id);
      assert.equal(ids.has(`${schema.family}:${section.id}`), false);
      ids.add(`${schema.family}:${section.id}`);
      assert.ok(section.order > previousOrder);
      previousOrder = section.order;
      assert.ok(section.headings.zh);
      assert.ok(section.headings.en);
      assert.equal(section.marker, `artifact-section:${schema.family}:${section.id}`);
    }
  }
  assert.equal(getArtifactSchema('code')?.family, 'code');
  assert.equal(getArtifactSchema('unknown'), null);
});

test('artifact skeleton contains identity metadata and non-semantic section markers', () => {
  const content = renderArtifactSkeleton({
    taskId: 'TASK-20260101-000001',
    family: 'plan',
    artifact: 'plan.md',
    locale: 'zh-CN'
  });

  assert.match(content, /artifact-context:TASK-20260101-000001:plan:1/);
  const schema = getArtifactSchema('plan')!;
  for (const section of schema.sections) {
    assert.match(content, new RegExp(`^##\\s+${section.headings.zh}$`, 'm'));
    assert.equal(content.match(new RegExp(`artifact-section:plan:${section.id}`, 'g'))?.length, 1);
  }
  assert.doesNotMatch(content, /\$ /);
  const structure = inspectArtifactStructure(content, schema);
  assert.equal(structure.ok, false);
  assert.ok(structure.diagnostics.some((item) => item.code === 'ARTIFACT_EMPTY_SECTION'));
});

test('structure scanner ignores fenced headings and proposes one safe punctuation repair', () => {
  const headings = getArtifactSchema('analysis')!.sections.map((section, index) => (
    `## ${index === 0 ? `${section.headings.zh}：` : section.headings.zh}\n内容`
  ));
  const content = ['# Analysis', '```markdown', '## 需求来源', '```', ...headings].join('\n');
  const structure = inspectArtifactStructure(content, getArtifactSchema('analysis')!);

  assert.equal(structure.ok, false);
  assert.equal(structure.repair?.kind, 'replace-line');
  assert.equal(structure.repair?.from, '需求来源：');
  assert.equal(structure.repair?.to, '需求来源');
  assert.equal(structure.diagnostics.filter((item) => item.code === 'ARTIFACT_MISSING_SECTION').length, 0);
});
