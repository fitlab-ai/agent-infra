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

test('receipt target identity includes the exact input artifact and reads completed legacy rows', () => {
  const source = {
    sourceFamily: 'analysis', sourceArtifact: 'analysis-r2.md', sourceRound: 2,
    sourceSha256: 'b'.repeat(64), createdAt: '2026-01-01 00:00:00+00:00',
    updatedAt: '2026-01-01 00:00:00+00:00'
  };
  const operation = createInvalidationOperation(source);
  const receipt = {
    targetKind: 'receipt' as const, targetFamily: 'plan', targetArtifact: 'plan.md', targetRound: 1,
    targetInput: 'analysis.md', targetSha256: 'a'.repeat(64), status: 'pending' as const,
    reasonCode: 'upstream-replaced', updatedAt: '2026-01-01 00:00:00+00:00', operationId: operation.operationId
  };
  const otherInput = { ...receipt, targetInput: 'review-analysis.md' };
  assert.notEqual(targetIdFor(operation.operationId, receipt), targetIdFor(operation.operationId, otherInput));
  const target = { ...receipt, targetId: targetIdFor(operation.operationId, receipt) };
  const fullOperation = createInvalidationOperation(source, [target]);
  const current = renderInvalidation({ operations: [fullOperation], targets: [target] });
  const parsed = parseInvalidationDocument(`## Artifact Invalidation\n\n${current}\n`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.document.targets[0]?.targetInput, 'analysis.md');

  const legacyShape = { ...receipt, targetInput: undefined };
  const legacyTarget = { ...legacyShape, targetId: targetIdFor(operation.operationId, legacyShape), status: 'completed' as const };
  const legacyOperation = { ...fullOperation, status: 'completed' as const, processed: 1, total: 1, completedAt: '2026-01-01 00:01:00+00:00' };
  const legacyRow = `| ${legacyTarget.targetId} | ${legacyTarget.operationId} | receipt | plan | plan.md | 1 | ${legacyTarget.targetSha256} | completed | upstream-replaced | ${legacyTarget.updatedAt} |`;
  const legacyText = `## Artifact Invalidation\n\n### Operations\n\n| operation_id | source_family | source_artifact | source_round | source_sha256 | status | processed | total | created_at | updated_at | completed_at | error |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| ${legacyOperation.operationId} | analysis | analysis-r2.md | 2 | ${legacyOperation.sourceSha256} | completed | 1 | 1 | ${legacyOperation.createdAt} | ${legacyOperation.updatedAt} | ${legacyOperation.completedAt} |  |\n\n### Targets\n\n| target_id | operation_id | target_kind | target_family | target_artifact | target_round | target_sha256 | status | reason_code | updated_at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${legacyRow}\n`;
  const legacyParsed = parseInvalidationDocument(legacyText);
  assert.equal(legacyParsed.ok, true);
  if (!legacyParsed.ok) return;
  assert.equal(legacyParsed.document.targets[0]?.targetInput, undefined);
  const normalizedLegacy = renderInvalidation(legacyParsed.document);
  assert.match(normalizedLegacy, /\| target_input \|/);
  const roundTrippedLegacy = parseInvalidationDocument(`## Artifact Invalidation\n\n${normalizedLegacy}\n`);
  assert.equal(roundTrippedLegacy.ok, true);
  if (!roundTrippedLegacy.ok) return;
  assert.equal(roundTrippedLegacy.document.targets[0]?.targetInput, undefined);

  const pendingLegacy = legacyText
    .replace('| completed | 1 | 1 |', '| pending | 0 | 1 |')
    .replace(`${legacyTarget.targetId} | ${legacyTarget.operationId} | receipt | plan | plan.md | 1 | ${legacyTarget.targetSha256} | completed |`, `${legacyTarget.targetId} | ${legacyTarget.operationId} | receipt | plan | plan.md | 1 | ${legacyTarget.targetSha256} | pending |`);
  assert.equal(parseInvalidationDocument(pendingLegacy).ok, false);
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
