import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDecisionItem,
  listDecisionItems,
  selectDecisionItem
} from '../../../lib/task/decision-items.ts';
import type { LedgerRow } from '../../../lib/task/ledger.ts';

function row(id: string, stage: string, status = 'needs-human-decision', sourceLine = 0): LedgerRow {
  return { id, stage, round: '1', severity: 'minor', status, evidence: `${id}.md#${id}`, sourceLine };
}

test('decision items enforce the four legal id families across three review stages', () => {
  for (const item of [row('AN-1', 'analysis'), row('PL-1', 'plan'), row('CD-1', 'code'), row('HD-1', 'analysis'), row('HD-2', 'plan'), row('HD-3', 'code')]) {
    assert.equal(isDecisionItem(item), true, `${item.id}/${item.stage}`);
  }
  for (const item of [row('AN-1', 'plan'), row('PL-1', 'code'), row('CD-1', 'analysis'), row('PRC-1', 'code'), row('HD-X', 'plan'), row('HD-1', 'post-review-commit')]) {
    assert.equal(isDecisionItem(item), false, `${item.id}/${item.stage}`);
  }
});

test('listDecisionItems preserves ledger order and filters status and stage', () => {
  const rows = [row('HD-1', 'analysis', 'human-decided'), row('PL-1', 'plan'), row('CD-1', 'code')];
  assert.deepEqual(listDecisionItems(rows).map((item) => item.id), ['PL-1', 'CD-1']);
  assert.deepEqual(listDecisionItems(rows, { includeDecided: true }).map((item) => item.id), ['HD-1', 'PL-1', 'CD-1']);
  assert.deepEqual(listDecisionItems(rows, { stage: 'code' }).map((item) => item.id), ['CD-1']);
});

test('selectDecisionItem supports ordinals and case-insensitive ids without hiding ambiguity', () => {
  const rows = [row('AN-1', 'analysis', 'needs-human-decision', 2), row('HD-1', 'plan', 'needs-human-decision', 3), row('HD-1', 'code', 'needs-human-decision', 4)];
  assert.deepEqual(selectDecisionItem(rows, '1'), { ok: true, row: rows[0] });
  assert.deepEqual(selectDecisionItem(rows, 'an-1'), { ok: true, row: rows[0] });
  assert.equal(selectDecisionItem(rows, 'HD-1').ok, false);
  assert.equal(selectDecisionItem(rows, '0').ok, false);
  assert.equal(selectDecisionItem(rows, '9').ok, false);
});
