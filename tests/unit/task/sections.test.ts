import test from 'node:test';
import assert from 'node:assert/strict';

import { DocumentMutationError, parseTable } from '../../../lib/task/sections.ts';

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
