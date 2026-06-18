import test from 'node:test';
import assert from 'node:assert/strict';

import { parseActivityLog } from '../../../lib/task/commands/log.ts';

// Separator in real entries is an em-dash (U+2014), not an ASCII hyphen.
const ZH = '## 活动日志';
const EN = '## Activity Log';

function md(heading: string, body: string): string {
  return `---\nid: TASK-20260101-000001\n---\n# 任务\n\n${heading}\n\n${body}\n`;
}

test('parses a Chinese activity log section with multiple entries', () => {
  const content = md(
    ZH,
    [
      '- 2026-06-16 15:06:43+08:00 — **Create Task** by claude — Task created from description',
      '- 2026-06-18 13:00:31+08:00 — **Analyze Task (Round 1)** by codex — Analysis done'
    ].join('\n')
  );
  const { sectionFound, entries } = parseActivityLog(content);
  assert.equal(sectionFound, true);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    time: '2026-06-16 15:06:43+08:00',
    step: 'Create Task',
    agent: 'claude',
    note: 'Task created from description'
  });
  assert.equal(entries[1]!.agent, 'codex');
});

test('locates the section language-agnostically (English heading)', () => {
  const content = md(EN, '- 2026-06-16 15:06:43+08:00 — **Create Task** by claude — body');
  const { sectionFound, entries } = parseActivityLog(content);
  assert.equal(sectionFound, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.step, 'Create Task');
});

test('keeps a note that itself contains the arrow and the em-dash separator', () => {
  const content = md(
    ZH,
    [
      '- 2026-06-18 13:00:31+08:00 — **Analyze Task (Round 1)** by claude — Analysis completed → analysis.md',
      '- 2026-06-10 00:38:44+08:00 — **Task Restored** by claude — Restored from Issue #419 — 5 artifacts'
    ].join('\n')
  );
  const { entries } = parseActivityLog(content);
  // Sorted ascending: Restored (Jun 10) before Analyze (Jun 18).
  const restored = entries.find((e) => e.step === 'Task Restored')!;
  const analyze = entries.find((e) => e.step === 'Analyze Task (Round 1)')!;
  assert.equal(analyze.agent, 'claude');
  assert.equal(analyze.note, 'Analysis completed → analysis.md');
  // The ' — ' inside the note must NOT be mis-split into STEP/AGENT.
  assert.equal(restored.agent, 'claude');
  assert.equal(restored.note, 'Restored from Issue #419 — 5 artifacts');
});

test('sorts entries ascending by timestamp regardless of file order', () => {
  const content = md(
    ZH,
    [
      '- 2026-06-18 14:00:00+08:00 — **Third** by claude — c',
      '- 2026-06-16 09:00:00+08:00 — **First** by claude — a',
      '- 2026-06-17 12:00:00+08:00 — **Second** by claude — b'
    ].join('\n')
  );
  const { entries } = parseActivityLog(content);
  assert.deepEqual(
    entries.map((e) => e.step),
    ['First', 'Second', 'Third']
  );
});

test('is a stable sort for equal timestamps (preserves original order)', () => {
  const content = md(
    ZH,
    [
      '- 2026-06-16 09:00:00+08:00 — **A1** by claude — first',
      '- 2026-06-16 09:00:00+08:00 — **A2** by claude — second'
    ].join('\n')
  );
  const { entries } = parseActivityLog(content);
  assert.deepEqual(
    entries.map((e) => e.step),
    ['A1', 'A2']
  );
});

test('skips blank, prose and malformed lines inside the section', () => {
  const content = md(
    ZH,
    [
      '- 2026-06-16 09:00:00+08:00 — **Valid** by claude — ok',
      '',
      'Some prose line that is not an entry.',
      '- 2026-06-16 — **NoTime** by claude — missing time component',
      '- missing the whole structure'
    ].join('\n')
  );
  const { sectionFound, entries } = parseActivityLog(content);
  assert.equal(sectionFound, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.step, 'Valid');
});

test('does not read entries past the next H2 boundary', () => {
  const content =
    `---\nid: x\n---\n# 任务\n\n${ZH}\n\n` +
    '- 2026-06-16 09:00:00+08:00 — **InLog** by claude — yes\n\n' +
    '## 完成检查清单\n\n' +
    '- 2026-06-17 09:00:00+08:00 — **AfterLog** by claude — must be excluded\n';
  const { entries } = parseActivityLog(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.step, 'InLog');
});

test('reports sectionFound=false when no activity log heading exists', () => {
  const content = `---\nid: x\n---\n# 任务\n\n## 描述\n\nno log here\n`;
  const { sectionFound, entries } = parseActivityLog(content);
  assert.equal(sectionFound, false);
  assert.equal(entries.length, 0);
});

test('distinguishes a present-but-empty section (no valid entries)', () => {
  const content = `---\nid: x\n---\n# 任务\n\n${ZH}\n\n## 完成检查清单\n\n- [ ] item\n`;
  const { sectionFound, entries } = parseActivityLog(content);
  assert.equal(sectionFound, true);
  assert.equal(entries.length, 0);
});
