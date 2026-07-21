import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeLedgerStage } from '../../../lib/task/ledger.ts';
import type { LedgerRow, ReviewStage } from '../../../lib/task/ledger.ts';

function row(id: string, stage: ReviewStage, severity: string, status: string): LedgerRow {
  return { id, stage, round: '1', severity, status, evidence: `${id}.md#evidence`, sourceLine: 0 };
}

test('stage status blocks every unresolved finding severity in every review stage', () => {
  const stages: ReviewStage[] = ['analysis', 'plan', 'code'];
  const severities = ['blocker', 'major', 'minor'];
  for (const stage of stages) {
    for (const severity of severities) {
      const status = summarizeLedgerStage([row(`${stage}-${severity}`, stage, severity, 'open')], stage);
      assert.equal(status.canAdvance, false);
      assert.equal(status.findingCounts[severity as keyof typeof status.findingCounts], 1);
      assert.equal(status.unresolvedFindingCounts[severity as keyof typeof status.unresolvedFindingCounts], 1);
      assert.equal(status.unresolved.length, 1);
    }
  }
});

test('stage status allows only existing terminal finding states', () => {
  const rows = ['confirmed', 'closed', 'human-decided'].map((status, index) =>
    row(`CD-${index + 1}`, 'code', ['blocker', 'major', 'minor'][index]!, status)
  );
  const result = summarizeLedgerStage(rows, 'code');
  assert.equal(result.canAdvance, true);
  assert.deepEqual(result.findingCounts, { blocker: 1, major: 1, minor: 1 });
  assert.deepEqual(result.unresolvedFindingCounts, { blocker: 0, major: 0, minor: 0 });
  assert.equal(result.terminal.length, 3);
});

test('stage status treats pending decisions as unresolved and ignores other stages', () => {
  const decision: LedgerRow = {
    id: 'HD-1', stage: 'plan', round: '-', severity: 'decision',
    status: 'needs-human-decision', evidence: 'plan.md#HD-1', sourceLine: 0
  };
  const result = summarizeLedgerStage([decision, row('AN-1', 'analysis', 'minor', 'open')], 'plan');
  assert.equal(result.canAdvance, false);
  assert.equal(result.pendingHumanDecisions, 1);
  assert.deepEqual(result.findingCounts, { blocker: 0, major: 0, minor: 0 });
  assert.equal(summarizeLedgerStage([], 'analysis').canAdvance, true);
});
