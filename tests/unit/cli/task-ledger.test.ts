import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLedger, nextHdId } from '../../../lib/task/ledger.ts';

const HEADER = '| id | stage | round | severity | status | evidence |';
const SEP = '|----|-------|-------|----------|--------|----------|';

function ledger(rows: string[], heading = '## 审查分歧账本'): string {
  return `---\nid: TASK-20260101-000001\n---\n# 任务\n\n${heading}\n\n${HEADER}\n${SEP}\n${rows.join('\n')}\n\n## 下一段\n\nx\n`;
}

test('parseLedger reads all six columns and skips header/separator', () => {
  const rows = parseLedger(
    ledger([
      '| AN-1 | analysis | 2 | blocker | closed | review-analysis-r2.md#AN-1 |',
      '| HD-1 | analysis | - | decision | human-decided | task.md#人工裁决 |'
    ])
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'AN-1',
    stage: 'analysis',
    round: '2',
    severity: 'blocker',
    status: 'closed',
    evidence: 'review-analysis-r2.md#AN-1'
  });
  assert.equal(rows[1]!.id, 'HD-1');
  assert.equal(rows[1]!.status, 'human-decided');
});

test('parseLedger locates an English ledger heading', () => {
  const rows = parseLedger(
    ledger(['| CD-1 | code | 1 | blocker | open | review-code.md#1 |'], '## Review Disagreement Ledger')
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.stage, 'code');
});

test('parseLedger returns [] when no ledger section exists', () => {
  assert.deepEqual(parseLedger('---\nid: x\n---\n# 任务\n\n## 描述\n\nno ledger\n'), []);
});

test('parseLedger stops at the next H2 and ignores malformed rows', () => {
  const rows = parseLedger(
    ledger([
      '| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |',
      '| too | few | cols |'
    ])
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'HD-1');
});

test('nextHdId returns HD-1 for an empty ledger', () => {
  assert.equal(nextHdId([]), 'HD-1');
});

test('nextHdId allocates globally across stages as max+1', () => {
  const rows = parseLedger(
    ledger([
      '| HD-1 | analysis | - | decision | human-decided | task.md#人工裁决 |',
      '| HD-2 | analysis | - | decision | human-decided | task.md#人工裁决 |',
      '| PL-1 | plan | 2 | blocker | closed | review-plan-r2.md#PL-1 |'
    ])
  );
  assert.equal(nextHdId(rows), 'HD-3');
});

test('nextHdId ignores non-HD ids and out-of-order numbers', () => {
  const rows = parseLedger(
    ledger([
      '| HD-5 | plan | - | decision | needs-human-decision | plan.md#HD-5 |',
      '| HD-2 | analysis | - | decision | human-decided | task.md#人工裁决 |',
      '| AN-9 | analysis | 1 | major | closed | review.md#AN-9 |'
    ])
  );
  assert.equal(nextHdId(rows), 'HD-6');
});
