import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVALIDATION_HEADINGS,
  createInvalidationOperation,
  parseInvalidationDocument,
  reconcileInvalidation,
  renderInvalidation,
  targetIdFor,
  type InvalidationTarget
} from '../../../lib/task/invalidation.ts';

const emptyTask = `# Task\n\n## Activity Log\n`;

test('invalidation schema round-trips operations and targets', () => {
  const source = {
    sourceFamily: 'analysis', sourceArtifact: 'analysis-r2.md', sourceRound: 2,
    sourceSha256: 'b'.repeat(64), createdAt: '2026-01-01 00:00:00+00:00',
    updatedAt: '2026-01-01 00:00:00+00:00'
  };
  const operationId = createInvalidationOperation(source).operationId;
  const targetShape = {
    targetKind: 'artifact' as const, targetFamily: 'plan', targetArtifact: 'plan.md', targetRound: 1,
    targetSha256: 'a'.repeat(64)
  };
  const target: InvalidationTarget = {
    targetId: targetIdFor(operationId, targetShape), operationId, ...targetShape, status: 'pending', reasonCode: 'upstream-replaced',
    updatedAt: '2026-01-01 00:00:00+00:00'
  };
  const operation = createInvalidationOperation(source, [target]);
  const content = renderInvalidation({ operations: [operation], targets: [target] });
  const parsed = parseInvalidationDocument(`${emptyTask}\n## ${INVALIDATION_HEADINGS[0]}\n\n${content}\n`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.document.operations, [operation]);
  assert.deepEqual(parsed.document.targets, [target]);
});

test('reconcile is idempotent and completes each target before the operation', () => {
  const source = {
    sourceFamily: 'analysis', sourceArtifact: 'analysis-r2.md', sourceRound: 2,
    sourceSha256: 'b'.repeat(64), createdAt: '2026-01-01 00:00:00+00:00',
    updatedAt: '2026-01-01 00:00:00+00:00'
  };
  const operationId = createInvalidationOperation(source).operationId;
  const targetShape = {
    targetKind: 'artifact' as const, targetFamily: 'code', targetArtifact: 'code.md', targetRound: 1,
    targetSha256: 'a'.repeat(64)
  };
  const target: InvalidationTarget = {
    targetId: targetIdFor(operationId, targetShape), operationId, ...targetShape, status: 'pending', reasonCode: 'upstream-replaced',
    updatedAt: '2026-01-01 00:00:00+00:00'
  };
  const operation = createInvalidationOperation(source, [target]);
  const first = reconcileInvalidation({ operations: [operation], targets: [target] }, '2026-01-01 00:01:00+00:00');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.document.targets[0]?.status, 'completed');
  assert.equal(first.document.operations[0]?.status, 'completed');
  const second = reconcileInvalidation(first.document, '2026-01-01 00:02:00+00:00');
  assert.deepEqual(second, { ok: true, changed: false, document: first.document });
});

test('malformed invalidation state fails closed', () => {
  const parsed = parseInvalidationDocument(`${emptyTask}\n## ${INVALIDATION_HEADINGS[0]}\n\n### Operations\n\n| wrong | table |\n|---|---|\n`);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, 'TASK_INVALIDATION_INVALID');
});
