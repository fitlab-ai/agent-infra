import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTaskFrontmatter,
  parseTypedTaskFrontmatter,
  updateTaskFrontmatter
} from '../../../lib/task/frontmatter.ts';
import { extractTitle } from '../../../lib/task/frontmatter.ts';

test('parseTaskFrontmatter returns key/value map', () => {
  const fm = parseTaskFrontmatter('---\nid: TASK-1\ntype: feature\n---\nbody\n');
  assert.deepEqual(fm, { id: 'TASK-1', type: 'feature' });
});

test('parseTaskFrontmatter preserves empty values', () => {
  const fm = parseTaskFrontmatter('---\nstart_date:\ntarget_date: 2026-06-15\n---\n');
  assert.equal(fm.start_date, '');
  assert.equal(fm.target_date, '2026-06-15');
});

test('parseTaskFrontmatter handles values containing colons', () => {
  const fm = parseTaskFrontmatter('---\ncreated_at: 2026-06-12 16:27:37+08:00\n---\n');
  assert.equal(fm.created_at, '2026-06-12 16:27:37+08:00');
});

test('parseTaskFrontmatter ignores body content after closing ---', () => {
  const fm = parseTaskFrontmatter('---\nid: x\n---\n# Title: with colon\nbody: should be ignored\n');
  assert.deepEqual(fm, { id: 'x' });
});

test('parseTaskFrontmatter returns {} when no frontmatter present', () => {
  assert.deepEqual(parseTaskFrontmatter('no frontmatter here\n'), {});
});

test('parseTaskFrontmatter returns {} when frontmatter block is unclosed', () => {
  assert.deepEqual(parseTaskFrontmatter('---\nid: orphan\nstill here\n'), {});
});

test('extractTitle pulls the first H1 (Chinese 任务 prefix)', () => {
  const t = extractTitle('---\nid: x\n---\n# 任务：新增 ai task CLI\n\n## 描述\n');
  assert.equal(t, '新增 ai task CLI');
});

test('extractTitle pulls the first H1 (plain English)', () => {
  const t = extractTitle('# Add bare numeric short ids\n\nbody\n');
  assert.equal(t, 'Add bare numeric short ids');
});

test('extractTitle returns empty string when no H1 found', () => {
  assert.equal(extractTitle('## not h1\nbody\n'), '');
});

test('typed frontmatter reads scalars and preserves empty values', () => {
  assert.deepEqual(parseTypedTaskFrontmatter('---\nname: sample\ncount: 2\nenabled: true\nempty:\nnone: null\n---\n'), {
    name: 'sample',
    count: 2,
    enabled: true,
    empty: '',
    none: null
  });
});

test('updateTaskFrontmatter replaces and appends scalars without touching other bytes', () => {
  const input = '---\r\nid: TASK-1\r\nunknown: keep # comment\r\n---\r\n# Body\r\n';
  assert.equal(
    updateTaskFrontmatter(input, { id: 'TASK-2', enabled: true, target_date: '' }),
    '---\r\nid: TASK-2\r\nunknown: keep # comment\r\nenabled: true\r\ntarget_date:\r\n---\r\n# Body\r\n'
  );
});

test('updateTaskFrontmatter rejects duplicate target keys', () => {
  assert.throws(
    () => updateTaskFrontmatter('---\nid: one\nid: two\n---\n', { id: 'three' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'TASK_DOCUMENT_INVALID'
  );
});

test('parseTypedTaskFrontmatter rejects nested frontmatter values', () => {
  assert.throws(
    () => parseTypedTaskFrontmatter('---\nlabels: [one, two]\n---\n'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'TASK_DOCUMENT_INVALID'
  );
});
