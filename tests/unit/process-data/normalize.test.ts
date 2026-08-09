import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeObjects } from '../../../lib/process-data/normalize.ts';
import { reconcileRecords } from '../../../lib/process-data/reconcile.ts';
import type { CapturedObject } from '../../../lib/process-data/types.ts';

test('normalization classifies tasks, activity telemetry, receipts and operational reports deterministically', () => {
  const objects: CapturedObject[] = [
    {
      sourceKind: 'local-file',
      sourceIdentity: '.agents/workspace/active/TASK-20260101-000001/task.md',
      sha256: 'a'.repeat(64),
      bytes: 100,
      content: [
        '---',
        'id: TASK-20260101-000001',
        '---',
        '',
        '## 审查分歧账本',
        '| id | stage | round | severity | status | evidence |',
        '|----|-------|-------|----------|--------|----------|',
        '| CD-1 | code | 1 | major | open | review-code.md#CD-1 |',
        '',
        '## 人工裁决',
        '### HDR-1',
        '- **裁决结果**：keep raw evidence',
        '',
        '## 活动日志',
        '- 2026-01-01 00:00:00+00:00 — **Plan Task** by codex — done',
        ''
      ].join('\n')
    },
    {
      sourceKind: 'operational-report',
      sourceIdentity: '.agents/workspace/logs/entropy-check/report.md',
      sha256: 'b'.repeat(64),
      bytes: 20,
      content: '# Entropy report\n'
    },
    {
      sourceKind: 'structured-telemetry',
      sourceIdentity: '.agents/workspace/logs/orchestration/receipt.json',
      sha256: 'c'.repeat(64),
      bytes: 20,
      content: '{"client":"codex","model":"gpt-5"}'
    }
  ];
  const records = normalizeObjects(objects);
  assert.deepEqual(
    [...new Set(records.map((record) => record.kind))].sort(),
    ['conflict', 'human-ruling', 'lifecycle-event', 'operational-report', 'review-finding', 'task', 'telemetry']
  );
  assert.equal(records.find((record) => record.kind === 'review-finding')?.sourceIdentity.endsWith('#finding=CD-1'), true);
  assert.equal(records.find((record) => record.kind === 'human-ruling')?.sourceIdentity.endsWith('#ruling=HDR-1'), true);
  assert.equal(records.every((record, index, all) => index === 0 || all[index - 1]!.recordId < record.recordId), true);
});

test('normalization preserves repeated historical rows with unique deterministic record identities', () => {
  const repeatedActivity = '- 2026-01-01 00:00:00+00:00 — **Commit** by codex — same event';
  const repeatedFinding = '| CD-1 | code | 1 | major | closed | review-code.md#CD-1 |';
  const task: CapturedObject = {
    sourceKind: 'local-file',
    sourceIdentity: '.agents/workspace/archive/2026/01/01/TASK-20260101-000001/task.md',
    sha256: 'd'.repeat(64),
    bytes: 200,
    content: [
      '---',
      'id: TASK-20260101-000001',
      '---',
      '',
      '## 审查分歧账本',
      '| id | stage | round | severity | status | evidence |',
      '|----|-------|-------|----------|--------|----------|',
      repeatedFinding,
      repeatedFinding,
      '',
      '## 活动日志',
      repeatedActivity,
      repeatedActivity,
      ''
    ].join('\n')
  };

  const first = normalizeObjects([task]);
  const second = normalizeObjects([task]);
  const lifecycle = first.filter((record) => record.kind === 'lifecycle-event');
  const findings = first.filter((record) => record.kind === 'review-finding');
  assert.equal(lifecycle.length, 2);
  assert.equal(findings.length, 2);
  assert.equal(new Set(lifecycle.map((record) => record.recordId)).size, 2);
  assert.equal(new Set(findings.map((record) => record.recordId)).size, 2);
  assert.equal(new Set(lifecycle.map((record) => record.sourceIdentity)).size, 1);
  assert.equal(new Set(findings.map((record) => record.sourceIdentity)).size, 1);
  assert.deepEqual(second, first);
  const quality = reconcileRecords(first, 'local').findings;
  assert.equal(quality.filter((finding) => finding.category === 'duplicate-identity').length, 2);
});
