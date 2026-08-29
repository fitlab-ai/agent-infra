import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeObjects, normalizeResources } from '../../../lib/process-data/normalize.ts';
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

test('normalization canonicalizes activity actors through the current token rules', () => {
  const actors = ['human', 'claude', 'traecli', 'claude-code', 'antigravity-cli', 'devuser', 'gemini', 'gemini-cli'];
  const task: CapturedObject = {
    sourceKind: 'local-file',
    sourceIdentity: '.agents/workspace/active/TASK-20260101-000002/task.md',
    sha256: 'e'.repeat(64),
    bytes: 400,
    content: [
      '---',
      'id: TASK-20260101-000002',
      '---',
      '',
      '## 活动日志',
      ...actors.map((actor, index) => `- 2026-01-01 00:00:0${index}+00:00 — **Step ${index}** by ${actor} — actor test`),
      ''
    ].join('\n')
  };

  const lifecycle = normalizeObjects([task])
    .filter((record) => record.kind === 'lifecycle-event')
    .sort((left, right) => {
      const leftTime = (left.data as { timestamp: string }).timestamp;
      const rightTime = (right.data as { timestamp: string }).timestamp;
      return leftTime.localeCompare(rightTime);
    });
  assert.deepEqual(
    lifecycle.map((record) => (record.data as { actorCanonical: string | null }).actorCanonical),
    ['human', 'claude', 'traecli', 'claude', 'antigravity', null, null, null]
  );
});

test('resource normalization uses stable resource identity instead of page identity', () => {
  const records = normalizeResources([{
    sourceKind: 'github-rest',
    sourceIdentity: 'issue:7',
    resourceIdentity: 'issue:7',
    role: 'resource',
    sha256: 'a'.repeat(64),
    bytes: 2,
    eventTime: '2026-08-20T00:00:00.000Z',
    pageSha256: 'b'.repeat(64),
    content: '{"number":7}'
  }]);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.sourceIdentity, 'issue:7');
  assert.equal(records[0]!.recordId, normalizeResources([{
    sourceKind: 'github-rest', sourceIdentity: 'issue:7#page=2', resourceIdentity: 'issue:7', role: 'resource', sha256: 'a'.repeat(64), bytes: 2, content: '{"number":7}'
  }])[0]!.recordId);
  assert.deepEqual(records[0]!.evidence, [{ resourceIdentity: 'issue:7', resourceSha256: 'a'.repeat(64), pageSha256: 'b'.repeat(64) }]);
});
