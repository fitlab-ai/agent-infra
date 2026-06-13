import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskFrontmatter, extractTitle } from '../../../lib/task/frontmatter.ts';

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
