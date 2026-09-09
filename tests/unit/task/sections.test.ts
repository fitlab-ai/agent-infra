import test from 'node:test';
import assert from 'node:assert/strict';

import { DocumentMutationError, parseTable, extractSection, extractSubSection, findSectionHeading, upsertSection, mutateTableRow } from '../../../lib/task/sections.ts';

const columns = ['id', 'message'] as const;
const aliases = ['Ledger', '账本'] as const;

function parse(content: string) {
  return parseTable(content, { sectionAliases: aliases, columns });
}

test('parseTable reads English and Chinese sections with LF or CRLF', () => {
  for (const [heading, eol] of [['Ledger', '\n'], ['账本', '\r\n']] as const) {
    const content = [`## ${heading}`, '', '| id | message |', '|----|---------|', '| X-1 | value |', ''].join(eol);
    const table = parse(content);
    assert.equal(table?.heading, heading);
    assert.deepEqual(table?.rows[0]?.values, { id: 'X-1', message: 'value' });
  }
});

test('parseTable decodes escaped pipes and backslashes', () => {
  const table = parse('## Ledger\n\n| id | message |\n|----|---------|\n| X-1 | a \\| b \\\\ c |\n');
  assert.equal(table?.rows[0]?.values.message, 'a | b \\ c');
});

test('parseTable fails closed on ambiguous sections, duplicate keys, malformed rows, and unclosed escapes', () => {
  const fixtures = [
    '## Ledger\n\n| id | message |\n|----|---------|\n\n## 账本\n\n| id | message |\n|----|---------|\n',
    '## Ledger\n\n| id | message |\n|----|---------|\n| X-1 | a |\n| X-1 | b |\n',
    '## Ledger\n\n| id | message |\n|----|---------|\n| X-1 | a | extra |\n',
    '## Ledger\n\n| id | message |\n|----|---------|\n| X-1 | trailing \\|\n'
  ];
  for (const content of fixtures) {
    assert.throws(() => parse(content), DocumentMutationError);
  }
});

test('parseTable distinguishes a missing section from a section with the wrong schema', () => {
  assert.equal(parse('# Task\n'), null);
  assert.throws(
    () => parse('## Ledger\n\n| id | detail |\n|----|--------|\n'),
    (error: unknown) => error instanceof DocumentMutationError && error.code === 'TABLE_NOT_FOUND'
  );
});

test('section reads and writes ignore fenced headings and preserve outside bytes and EOLs', () => {
  for (const eol of ['\n', '\r\n']) {
    const prefix = ['# Task', '````md', '## Ledger', 'example', '```', '## Ledger', 'still fenced', '````', '', '## 账本', ''].join(eol);
    const suffix = ['## Next', 'untouched  ', ''].join(eol);
    const content = prefix + eol + 'real  ' + eol + eol + suffix;
    assert.equal(extractSection(content, ['Ledger', '账本']), 'real  ');
    assert.equal(findSectionHeading(content, ['Ledger', '账本']), '账本');
    const result = upsertSection(content, { aliases, heading: 'Ledger', body: 'changed  ' });
    assert.equal(result.content, prefix + eol + 'changed  ' + eol + eol + suffix);
    assert.equal(upsertSection(result.content, { aliases, heading: 'Ledger', body: 'changed  ' }).content, result.content);
  }
});

test('section policies retain H2/H3 boundaries and reject duplicate visible mutation targets', () => {
  const content = '## Parent\n### Ledger\nold\n### Sibling\nsame\n## Next\nend\n';
  assert.equal(extractSection(content, ['Ledger']), '');
  const updated = upsertSection(content, { aliases: ['Ledger'], heading: 'Ledger', body: 'new' });
  assert.equal(updated.content, '## Parent\n### Ledger\n\nnew\n\n### Sibling\nsame\n## Next\nend\n');
  assert.throws(() => upsertSection(content + '\n## Ledger\nother\n', { aliases: ['Ledger'], heading: 'Ledger', body: 'new' }), { code: 'TASK_DOCUMENT_INVALID' });
  const bilingual = '## 账本\nfirst\n## Ledger\nsecond\n';
  assert.equal(extractSection(bilingual, ['Ledger', '账本']), 'first');
  assert.equal(findSectionHeading(bilingual, ['Ledger', '账本']), 'Ledger');
  assert.equal(extractSection('## Ledger', ['Ledger']), '');
});

test('table read and mutation select the visible table while preserving fenced examples', () => {
  const table = '| id | message |\n| --- | --- |\n| X-1 | old |\n';
  const example = '~~~md\n## Ledger\n' + table + '~~~\n';
  const prefix = '## Ledger\n\n' + example + '\n';
  const content = prefix + table;
  assert.equal(parse(content)?.rows[0]?.values.message, 'old');
  const changed = mutateTableRow(content, { kind: 'table-row', action: 'upsert', sectionAliases: aliases, columns, keyColumn: 'id', key: 'X-1', values: { message: 'new' } });
  assert.equal(changed.content, prefix + table.replace('old', 'new'));
  assert.equal(parse(changed.content)?.rows[0]?.values.message, 'new');
});

test('subsection extraction ignores fenced identifiers without confusing identifier prefixes', () => {
  const content = '```md\n### PL-1\nexample\n```\n### PL-10\nother\n### PL-1：real\nkeep\n```\n## Fake boundary\n```\n### PL-2\nnext\n';
  assert.equal(extractSubSection(content, 'PL-1'), '### PL-1：real\nkeep\n```\n## Fake boundary\n```');
});
