import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileRecords } from '../../../lib/process-data/reconcile.ts';

test('reconciliation proposes only unique deterministic links and keeps conflicts manual', () => {
  const result = reconcileRecords([
    { recordId: 'local-1', kind: 'task', sourceIdentity: 'TASK-1', sourceSha256: 'a'.repeat(64), binding: 'issue:1' },
    { recordId: 'remote-1', kind: 'platform-resource', sourceIdentity: 'issue:1', sourceSha256: 'a'.repeat(64), binding: 'TASK-1' },
    { recordId: 'remote-2', kind: 'platform-resource', sourceIdentity: 'issue:2', sourceSha256: 'b'.repeat(64), binding: 'TASK-2' },
    { recordId: 'remote-3', kind: 'platform-resource', sourceIdentity: 'issue:2', sourceSha256: 'c'.repeat(64), binding: 'TASK-2' }
  ], 'all');
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0]!.operation, 'link');
  assert.equal(result.findings.some((finding) => finding.category === 'duplicate-identity' && !finding.repairable), true);
});

test('reconciliation reports cross-source, schema and mutable-remote quality gaps', () => {
  const result = reconcileRecords([
    {
      recordId: 'task-1',
      kind: 'task',
      sourceIdentity: 'TASK-1',
      sourceSha256: 'a'.repeat(64),
      binding: 'issue:1',
      data: { agentInfraVersion: { state: 'unknown', reason: 'legacy task' } }
    },
    { recordId: 'task-2', kind: 'task', sourceIdentity: 'TASK-2', sourceSha256: 'b'.repeat(64), binding: 'issue:2' },
    { recordId: 'remote-1', kind: 'platform-resource', sourceIdentity: 'issue:2', sourceSha256: 'c'.repeat(64), binding: 'TASK-1' },
    { recordId: 'remote-2', kind: 'platform-resource', sourceIdentity: 'issue:3', sourceSha256: 'd'.repeat(64), binding: 'TASK-3' },
    { recordId: 'remote-3a', kind: 'platform-resource', sourceIdentity: 'issue:4', sourceSha256: 'e'.repeat(64) },
    { recordId: 'remote-3b', kind: 'platform-resource', sourceIdentity: 'issue:4', sourceSha256: 'f'.repeat(64) }
  ], 'all');
  const categories = new Set(result.findings.map((finding) => finding.category));
  for (const category of [
    'missing-local',
    'missing-remote',
    'binding-conflict',
    'content-mismatch',
    'schema-difference',
    'mutable-remote'
  ]) {
    assert.equal(categories.has(category as never), true, category);
  }
});

test('reconciliation treats task references in comments as healthy non-authoritative relations', () => {
  const result = reconcileRecords([
    {
      recordId: 'task',
      kind: 'task',
      sourceIdentity: 'TASK-1',
      sourceSha256: 'a'.repeat(64),
      binding: 'issue:800',
      data: { agentInfraVersion: { state: 'known', value: 'v1.0.0' } }
    },
    { recordId: 'issue', kind: 'platform-resource', sourceIdentity: 'issue:800', sourceSha256: 'b'.repeat(64), binding: 'TASK-1' },
    { recordId: 'comment-1', kind: 'platform-resource', sourceIdentity: 'issue-comment:1', sourceSha256: 'c'.repeat(64), binding: 'TASK-1' },
    { recordId: 'comment-2', kind: 'platform-resource', sourceIdentity: 'issue-comment:2', sourceSha256: 'd'.repeat(64), binding: 'TASK-1' }
  ], 'all');
  assert.equal(result.findings.some((finding) => finding.category === 'binding-conflict'), false);
  assert.equal(result.findings.some((finding) => finding.category === 'content-mismatch'), false);
  assert.equal(result.repairs.length, 1);
});

test('reconciliation treats a task reference in its pull request as a healthy non-authoritative relation', () => {
  const result = reconcileRecords([
    {
      recordId: 'task',
      kind: 'task',
      sourceIdentity: 'TASK-1',
      sourceSha256: 'a'.repeat(64),
      binding: 'issue:800',
      data: { agentInfraVersion: { state: 'known', value: 'v1.0.0' } }
    },
    { recordId: 'issue', kind: 'platform-resource', sourceIdentity: 'issue:800', sourceSha256: 'b'.repeat(64), binding: 'TASK-1' },
    { recordId: 'pull-request-as-issue', kind: 'platform-resource', sourceIdentity: 'issue:900', sourceSha256: 'c'.repeat(64), binding: 'TASK-1' },
    { recordId: 'pull-request', kind: 'platform-resource', sourceIdentity: 'pr:900', sourceSha256: 'd'.repeat(64), binding: 'TASK-1' }
  ], 'all');
  assert.equal(result.findings.some((finding) => finding.category === 'binding-conflict'), false);
  assert.equal(result.findings.some((finding) => finding.category === 'content-mismatch'), false);
  assert.equal(result.repairs.length, 1);
});

test('reconciliation does not report cross-source gaps for partial snapshots', () => {
  const local = reconcileRecords([
    {
      recordId: 'task',
      kind: 'task',
      sourceIdentity: 'TASK-1',
      sourceSha256: 'a'.repeat(64),
      binding: 'issue:800',
      data: { agentInfraVersion: { state: 'known', value: 'v1.0.0' } }
    }
  ], 'local');
  assert.equal(local.findings.some((finding) => finding.category === 'missing-remote'), false);

  const github = reconcileRecords([
    { recordId: 'issue', kind: 'platform-resource', sourceIdentity: 'issue:800', sourceSha256: 'b'.repeat(64), binding: 'TASK-1' }
  ], 'github');
  assert.equal(github.findings.some((finding) => finding.category === 'missing-local'), false);
});
