import test from 'node:test';
import assert from 'node:assert/strict';

import { parseActivityLog, pairEntries, isHumanAgent } from '../../../lib/task/commands/log.ts';

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

// --- isHumanAgent: classify the executor token of a step ---

test('isHumanAgent treats every known AI token as non-human', () => {
  // The full AI token set: workflow recommended_agents + the opencode TUI.
  for (const ai of ['claude', 'codex', 'gemini', 'opencode', 'cursor']) {
    assert.equal(isHumanAgent(ai), false, ai);
  }
});

test('isHumanAgent treats human executors (incl. CJK names and annotations) as human', () => {
  for (const human of ['张三', '张三 (executed on host)', 'Alice', 'human']) {
    assert.equal(isHumanAgent(human), true, human);
  }
});

// --- pairEntries: collapse started/done markers into per-step rows ---

type Entry = { time: string; step: string; agent: string; note: string };
function entry(time: string, step: string, agent = 'claude', note = 'n'): Entry {
  return { time, step, agent, note };
}

test('pairEntries renders legacy done-only entries as standalone rows', () => {
  const rows = pairEntries([
    entry('2026-06-16 09:00:00+08:00', 'Create Task', 'claude', 'created'),
    entry('2026-06-16 10:00:00+08:00', 'Analyze Task (Round 1)', 'codex', 'done')
  ]);
  assert.equal(rows.length, 2);
  // started column empty, done column carries the timestamp.
  assert.deepEqual(rows[0], {
    step: 'Create Task',
    agent: 'claude',
    started: '',
    done: '2026-06-16 09:00:00+08:00',
    note: 'created'
  });
  assert.equal(rows[1]!.started, '');
  assert.equal(rows[1]!.done, '2026-06-16 10:00:00+08:00');
});

test('pairEntries keeps a started-only step in flight (no done timestamp)', () => {
  const rows = pairEntries([
    entry('2026-06-16 09:00:00+08:00', 'Code Task (Round 1) [started]', 'claude', 'started')
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, 'Code Task (Round 1)'); // suffix stripped to the base
  assert.equal(rows[0]!.started, '2026-06-16 09:00:00+08:00');
  assert.equal(rows[0]!.done, '');
  assert.equal(rows[0]!.note, 'started');
});

test('pairEntries folds a started+done pair onto one row', () => {
  const rows = pairEntries([
    entry('2026-06-16 09:00:00+08:00', 'Plan Task (Round 1) [started]', 'claude', 'started'),
    entry('2026-06-16 09:30:00+08:00', 'Plan Task (Round 1)', 'claude', 'Plan completed → plan.md')
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    step: 'Plan Task (Round 1)',
    agent: 'claude',
    started: '2026-06-16 09:00:00+08:00',
    done: '2026-06-16 09:30:00+08:00',
    note: 'Plan completed → plan.md' // done note wins over the started placeholder
  });
});

test('pairEntries pairs each Round independently', () => {
  const rows = pairEntries([
    entry('2026-06-16 09:00:00+08:00', 'Analyze Task (Round 1) [started]'),
    entry('2026-06-16 09:10:00+08:00', 'Analyze Task (Round 1)'),
    entry('2026-06-16 10:00:00+08:00', 'Analyze Task (Round 2) [started]'),
    entry('2026-06-16 10:10:00+08:00', 'Analyze Task (Round 2)')
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.step, 'Analyze Task (Round 1)');
  assert.equal(rows[1]!.step, 'Analyze Task (Round 2)');
  assert.ok(rows.every((r) => r.started && r.done));
});

test('pairEntries pairs repeated same-base steps FIFO', () => {
  const rows = pairEntries([
    entry('2026-06-16 09:00:00+08:00', 'Commit [started]'),
    entry('2026-06-16 09:05:00+08:00', 'Commit', 'claude', 'first'),
    entry('2026-06-16 10:00:00+08:00', 'Commit [started]'),
    entry('2026-06-16 10:05:00+08:00', 'Commit', 'claude', 'second')
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.started, r.done, r.note]),
    [
      ['2026-06-16 09:00:00+08:00', '2026-06-16 09:05:00+08:00', 'first'],
      ['2026-06-16 10:00:00+08:00', '2026-06-16 10:05:00+08:00', 'second']
    ]
  );
});

test('pairEntries renders an unpaired done (no open started) as a done-only row', () => {
  const rows = pairEntries([
    entry('2026-06-16 09:00:00+08:00', 'Review Code (Round 1) [started]'),
    entry('2026-06-16 09:30:00+08:00', 'Code Task (Round 1)', 'claude', 'orphan done')
  ]);
  assert.equal(rows.length, 2);
  const review = rows.find((r) => r.step === 'Review Code (Round 1)')!;
  const code = rows.find((r) => r.step === 'Code Task (Round 1)')!;
  assert.equal(review.done, ''); // still in flight
  assert.equal(code.started, ''); // no matching start marker
  assert.equal(code.done, '2026-06-16 09:30:00+08:00');
});
