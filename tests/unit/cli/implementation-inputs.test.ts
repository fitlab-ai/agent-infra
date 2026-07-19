import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createImplementationInput,
  consumeImplementationInput,
  parseImplementationInputs,
  renderImplementationInputs,
  selectPendingImplementationInput
} from '../../../lib/task/implementation-inputs.ts';

const HEADING = '## 实现输入';

function taskWithRows(rows: string[]): string {
  return `${HEADING}\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n${rows.join('\n')}\n\n## 活动日志\n`;
}

test('implementation inputs allocate monotonic ids and encode explicit intent', () => {
  const first = createImplementationInput([], {
    ledgerId: 'CD-1', decisionEvidence: 'task.md#HDR-1', needsImplementation: true,
    decidedAt: '2026-07-18 09:00:00+08:00'
  });
  const second = createImplementationInput([first], {
    ledgerId: 'HD-2', decisionEvidence: 'task.md#HDR-2', needsImplementation: false,
    decidedAt: '2026-07-18 09:01:00+08:00'
  });
  assert.deepEqual(first, {
    id: 'II-1', ledgerId: 'CD-1', decisionEvidence: 'task.md#HDR-1', stage: 'code',
    needsImplementation: true, decidedAt: '2026-07-18 09:00:00+08:00',
    status: 'pending', consumedBy: ''
  });
  assert.equal(second.id, 'II-2');
  assert.equal(second.status, 'not-required');
});

test('parser validates schema, ids, stage, and state combinations', () => {
  const valid = parseImplementationInputs(taskWithRows([
    '| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:00:00+08:00 | pending | |',
    '| II-2 | HD-2 | task.md#HDR-2 | code | false | 2026-07-18 09:01:00+08:00 | not-required | |',
    '| II-3 | CD-3 | task.md#HDR-3 | code | true | 2026-07-18 09:02:00+08:00 | consumed | code-r2.md |'
  ]));
  assert.equal(valid.sectionFound, true);
  assert.equal(valid.rows.length, 3);
  assert.equal(valid.rows[2]?.consumedBy, 'code-r2.md');

  const invalidRows = [
    '| II-1 | CD-1 | task.md#HDR-1 | plan | true | 2026-07-18 09:00:00+08:00 | pending | |',
    '| II-1 | CD-1 | task.md#HDR-1 | code | false | 2026-07-18 09:00:00+08:00 | pending | |',
    '| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:00:00+08:00 | consumed | |'
  ];
  for (const row of invalidRows) {
    assert.throws(() => parseImplementationInputs(taskWithRows([row])), /implementation input/i);
  }
  assert.throws(() => parseImplementationInputs(taskWithRows([
    invalidRows[0]!.replace('plan', 'code'),
    invalidRows[0]!.replace('plan', 'code')
  ])), /duplicate/i);
});

test('pending selection is stable and rejects stale unconsumed inputs', () => {
  const rows = parseImplementationInputs(taskWithRows([
    '| II-2 | CD-2 | task.md#HDR-2 | code | true | 2026-07-18 10:02:00+08:00 | pending | |',
    '| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 10:02:00+08:00 | pending | |',
    '| II-3 | CD-3 | task.md#HDR-3 | code | false | 2026-07-18 10:03:00+08:00 | not-required | |'
  ])).rows;
  assert.equal(selectPendingImplementationInput(rows, '2026-07-18 10:00:00+08:00')?.id, 'II-1');
  assert.throws(
    () => selectPendingImplementationInput(rows, '2026-07-18 10:02:00+08:00'),
    /not later than/i
  );
});

test('consumption returns a validated immutable replacement and renderer round-trips', () => {
  const pending = createImplementationInput([], {
    ledgerId: 'CD-1', decisionEvidence: 'task.md#HDR-1', needsImplementation: true,
    decidedAt: '2026-07-18 09:00:00+08:00'
  });
  const consumed = consumeImplementationInput([pending], 'II-1', 'code-r2.md');
  assert.equal(pending.status, 'pending');
  assert.equal(consumed[0]?.status, 'consumed');
  assert.equal(consumed[0]?.consumedBy, 'code-r2.md');
  assert.throws(() => consumeImplementationInput(consumed, 'II-1', 'code-r3.md'), /not pending/i);

  const content = `${HEADING}\n\n${renderImplementationInputs(consumed)}\n\n## 活动日志\n`;
  assert.deepEqual(parseImplementationInputs(content).rows, consumed);
});

test('implementation input renderer round-trips escaped identity cells', () => {
  const rows = parseImplementationInputs(`## Implementation Inputs\n\n${renderImplementationInputs([{
    id: 'II-1', ledgerId: String.raw`CD\\1|x`, decisionEvidence: String.raw`task.md#HDR\\1|x`,
    stage: 'code', needsImplementation: true, decidedAt: '2026-07-01 09:30:00+08:00',
    status: 'pending', consumedBy: ''
  }])}`).rows;
  assert.equal(rows[0]!.ledgerId, String.raw`CD\\1|x`);
  assert.equal(rows[0]!.decisionEvidence, String.raw`task.md#HDR\\1|x`);
});
