import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectDecisionDetailDuplicates,
  normalizeDecisionDetailForDisplay,
  parseDecisionDetailBlocks,
  resolveDecisionDetail
} from '../../../lib/task/decision-details.ts';

test('decision detail parsing ignores headings and anchors inside fenced code', () => {
  const content = [
    '~~~md',
    '### HD-1：伪造详情 [needs-human-decision]',
    '<a id="HD-1"></a>',
    '~~~',
    '',
    '### HD-1：真实详情 [needs-human-decision]',
    '- **要决定什么**：真实选择',
    ''
  ].join('\n');

  const blocks = parseDecisionDetailBlocks(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.id, 'HD-1');
  assert.match(blocks[0]?.content ?? '', /真实详情/);
  assert.doesNotMatch(blocks[0]?.content ?? '', /伪造详情/);
});

test('decision detail parsing accepts backticks in tilde fence info strings', () => {
  const content = [
    '~~~~md `example`',
    '### AN-1：伪造详情 [needs-human-decision]',
    '<a id="AN-1"></a>',
    '~~~~',
    '',
    '### AN-1：真实详情 [needs-human-decision]',
    '- **要决定什么**：真实选择',
    ''
  ].join('\r\n');

  const blocks = parseDecisionDetailBlocks(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.heading, 'AN-1：真实详情 [needs-human-decision]');

  const resolved = resolveDecisionDetail(content, 'AN-1', 'AN-1');
  assert.equal(resolved.status, 'found');
  if (resolved.status === 'found') assert.equal(resolved.block.heading, blocks[0]?.heading);
});

test('decision detail parsing honors fence delimiters, lengths, and CRLF endings', () => {
  const content = [
    '```md',
    '### AN-1：反引号示例 [needs-human-decision]',
    '~~~',
    '```',
    '',
    '~~~~md `example`',
    '### AN-1：波浪线示例 [needs-human-decision]',
    '~~~',
    '````',
    '~~~~',
    '',
    '### AN-1：真实详情 [needs-human-decision]',
    '- **要决定什么**：真实选择',
    ''
  ].join('\r\n');

  const blocks = parseDecisionDetailBlocks(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.heading, 'AN-1：真实详情 [needs-human-decision]');
});

test('decision detail resolution uses exact ids and ignores an earlier informal block', () => {
  const content = [
    '### CD-1：上一轮简短复核',
    '- 简短说明',
    '',
    '### CD-1：正式裁决 [needs-human-decision]',
    '- **要决定什么**：选择方案',
    '',
    '### CD-11：另一个正式裁决 [needs-human-decision]',
    '- **要决定什么**：另一个选择',
    ''
  ].join('\n');

  const resolved = resolveDecisionDetail(content, 'CD-1', 'CD-1');
  assert.equal(resolved.status, 'found');
  if (resolved.status === 'found') assert.match(resolved.block.content, /正式裁决/);

  const longId = resolveDecisionDetail(content, 'CD-11', 'CD-11');
  assert.equal(longId.status, 'found');
  if (longId.status === 'found') assert.match(longId.block.content, /另一个正式裁决/);
});

test('explicit evidence anchors select the following canonical block and duplicate anchors are ambiguous', () => {
  const content = [
    '### CD-1：简短复核',
    '- 简短说明',
    '',
    '<a id="CD-1-detail"></a>',
    '### CD-1：正式实现裁决 [needs-human-decision]',
    '- **要决定什么**：选择实现边界',
    ''
  ].join('\n');

  const resolved = resolveDecisionDetail(content, 'CD-1', 'CD-1-detail');
  assert.equal(resolved.status, 'found');
  if (resolved.status === 'found') assert.match(resolved.block.content, /正式实现裁决/);

  const duplicated = resolveDecisionDetail(
    `${content}<a id="CD-1-detail"></a>\n### CD-1：另一个正式块 [needs-human-decision]\n`,
    'CD-1',
    'CD-1-detail'
  );
  assert.equal(duplicated.status, 'ambiguous');
});

test('explicit evidence anchors fail closed when the next visible structure is not the target heading', () => {
  const followingStructures = [
    '### Unrelated context',
    '### CD-11: Another decision [needs-human-decision]',
    'context before the decision',
    '<a id="other-anchor"></a>'
  ];

  for (const following of followingStructures) {
    const content = [
      '<a id="CD-1-detail"></a>',
      following,
      '### CD-1: Formal decision [needs-human-decision]',
      '- **What needs a decision**: choose the boundary',
      ''
    ].join('\n');

    const resolved = resolveDecisionDetail(content, 'CD-1', 'CD-1-detail');
    assert.equal(resolved.status, 'missing');
  }
});

test('duplicate details are reported without selecting a block for removal', () => {
  const content = [
    '### PL-1：简短复核',
    '- 简短结论',
    '',
    '### PL-1：正式方案选择 [needs-human-decision]',
    '- **要决定什么**：选择方案',
    ''
  ].join('\n');

  const inspection = inspectDecisionDetailDuplicates(content);
  assert.equal(inspection.ok, false);
  if (!inspection.ok) {
    assert.deepEqual(inspection.duplicates.map((duplicate) => duplicate.id), ['PL-1']);
    assert.equal(inspection.duplicates[0]?.blocks.length, 2);
  }
});

test('anchored informal duplicate details remain ambiguous and preserve the anchor', () => {
  const content = [
    '<a id="old-review"></a>',
    '### CD-1：简短复核',
    '- 简短说明',
    '',
    '### CD-1：正式裁决 [needs-human-decision]',
    '- **要决定什么**：选择方案',
    ''
  ].join('\n');

  const inspection = inspectDecisionDetailDuplicates(content);
  assert.equal(inspection.ok, false);
  if (!inspection.ok) assert.equal(inspection.duplicates[0]?.id, 'CD-1');

  const resolved = resolveDecisionDetail(content, 'CD-1', 'old-review');
  assert.equal(resolved.status, 'missing');
});

test('substantive unmarked duplicate details are ambiguous and preserve content', () => {
  const content = [
    '### AN-1：上一轮复核理由',
    '',
    'Previous review rationale',
    'The earlier review recorded the cause and risk for this behavior.',
    '',
    '### AN-1：正式详情 [needs-human-decision]',
    '- **要决定什么**：选择方案',
    ''
  ].join('\n');

  const inspection = inspectDecisionDetailDuplicates(content);
  assert.equal(inspection.ok, false);
  if (!inspection.ok) assert.equal(inspection.duplicates[0]?.id, 'AN-1');
});

test('summary-marked substantive duplicate details remain ambiguous', () => {
  const content = [
    '### AN-1: Security summary',
    '- privilege escalation allows unauthorized access',
    '',
    '### AN-1: Formal decision [needs-human-decision]',
    '- **What needs a decision**: choose the safe boundary',
    ''
  ].join('\n');

  const inspection = inspectDecisionDetailDuplicates(content);
  assert.equal(inspection.ok, false);
  if (!inspection.ok) assert.equal(inspection.duplicates[0]?.id, 'AN-1');
});

test('ambiguous canonical duplicates fail closed and preserve content', () => {
  const content = [
    '### AN-1：第一个选择 [needs-human-decision]',
    '- **要决定什么**：A',
    '',
    '### AN-1：第二个选择 [needs-human-decision]',
    '- **要决定什么**：B',
    ''
  ].join('\n');

  const inspection = inspectDecisionDetailDuplicates(content);
  assert.equal(inspection.ok, false);
  if (!inspection.ok) assert.equal(inspection.duplicates[0]?.id, 'AN-1');
});

test('display normalization puts the decision context before options and recording help', () => {
  const source = [
    '### HD-1：输出顺序 [needs-human-decision]',
    '',
    '- **会影响什么**：影响 review 流程',
    '- **为什么现在要决定**：现在必须继续',
    '- **要决定什么**：是否自动修复',
    '',
    '#### 方案 A：自动修复',
    '- **实际会怎么做**：删除明确的简版',
    '- **例子**：像整理重复文件',
    '',
    '#### 方案 B：只报错',
    '- **实际会怎么做**：等待人工处理',
    '- **例子**：像贴一张待处理便签',
    '',
    '- **建议选哪个**：方案 A',
    '- **为什么这样建议**：成本更低',
    ''
  ].join('\n');

  const block = parseDecisionDetailBlocks(source)[0]!;
  const normalized = normalizeDecisionDetailForDisplay(block);
  assert.ok(normalized.indexOf('**要决定什么**') < normalized.indexOf('**为什么现在要决定**'));
  assert.ok(normalized.indexOf('**为什么现在要决定**') < normalized.indexOf('**会影响什么**'));
  assert.ok(normalized.indexOf('#### 方案 A') < normalized.indexOf('**建议选哪个**'));
  assert.ok(normalized.indexOf('**建议选哪个**') < normalized.indexOf('**为什么这样建议**'));
});

test('display normalization recognizes the English canonical field labels', () => {
  const source = [
    '### HD-1: English ordering [needs-human-decision]',
    '',
    '- **What this affects**: affected review flow',
    '- **Why a decision is needed now**: work is waiting',
    '- **What needs a decision**: choose an implementation',
    '- **What could go wrong**: the wrong behavior remains',
    '',
    '#### Option A: Automatic repair',
    '- **What would actually be done**: remove the clearly short duplicate',
    '- **What happens after choosing it**: validation continues',
    '- **Benefits**: no manual cleanup',
    '- **Trade-offs**: conservative cases remain',
    '- **Example or analogy**: like sorting an obvious duplicate note',
    '',
    '#### Option B: Report only',
    '- **What would actually be done**: leave the duplicate for a maintainer',
    '- **What happens after choosing it**: the workflow pauses',
    '- **Benefits**: no automatic deletion',
    '- **Trade-offs**: more manual work',
    '- **Example or analogy**: like leaving a marked note on a desk',
    '',
    '- **Recommended choice**: Option A',
    '- **Why this choice**: it handles the clear case automatically',
    ''
  ].join('\n');

  const block = parseDecisionDetailBlocks(source)[0]!;
  const normalized = normalizeDecisionDetailForDisplay(block);
  assert.ok(normalized.indexOf('**What needs a decision**') < normalized.indexOf('**Why a decision is needed now**'));
  assert.ok(normalized.indexOf('**Why a decision is needed now**') < normalized.indexOf('**What this affects**'));
  assert.ok(normalized.indexOf('#### Option A') < normalized.indexOf('**Recommended choice**'));
  assert.ok(normalized.indexOf('**Recommended choice**') < normalized.indexOf('**Why this choice**'));
});
