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

test('invalidation reads visible parent and child tables without borrowing from other sections', () => {
  const document = { operations: [], targets: [] };
  const body = renderInvalidation(document);
  const real = '## Artifact Invalidation\n\n' + body + '\n';
  for (const eol of ['\n', '\r\n']) {
    const content = ('~~~md\n' + real + '~~~\n\n' + real).replaceAll('\n', eol);
    assert.deepEqual(parseInvalidationDocument(content), { ok: true, present: true, document });
    assert.deepEqual(parseInvalidationDocument(('~~~md\n' + real + '~~~\n').replaceAll('\n', eol)), { ok: true, present: false, document });
  }
  assert.deepEqual(parseInvalidationDocument('## Artifact Invalidation\n\n```md\n' + body + '\n```\n' + body), { ok: true, present: true, document });
  assert.equal(parseInvalidationDocument(real.replace('### Targets', '## Other\n### Targets')).ok, false);
  assert.equal(parseInvalidationDocument(real + '\n### Targets\n' + body.split('### Targets')[1]).ok, false);
  assert.equal(parseInvalidationDocument(real + '\nnot a table row\n').ok, false);
});

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
  const operation = { ...createInvalidationOperation(source, [target]), error: 'retry | path \\ detail' };
  const content = renderInvalidation({ operations: [operation], targets: [target] });
  const parsed = parseInvalidationDocument(`${emptyTask}\n## ${INVALIDATION_HEADINGS[0]}\n\n${content}\n`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.document.operations, [operation]);
  assert.deepEqual(parsed.document.targets, [target]);
  assert.deepEqual(parseInvalidationDocument(`## Artifact Invalidation\n\n${content.replaceAll('\n|', '\n\n|')}\n`), parsed);
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
