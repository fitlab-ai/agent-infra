import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeOperationWarnings, retryHintForWarning } from '../../../lib/task/operation-outcome.ts';

const warning = (message: string) => ({
  code: 'SYNC_FAILED', message, retryable: true, step: 'summary', target: 'pr', severity: 'ACTION_REQUIRED' as const
});

test('operation warnings use six fields and merge by step/code/target', () => {
  const merged = mergeOperationWarnings([warning('old')], [warning('new')]);
  assert.deepEqual(merged, [warning('new')]);
  assert.equal(Object.hasOwn(merged[0]!, 'action'), false);
});

test('retry hints are presentation-only and remain stable for unknown codes', () => {
  assert.match(retryHintForWarning({ code: 'SYNC_FAILED', step: 'summary' }), /Retry/);
  assert.match(retryHintForWarning({ code: 'COMMIT_PUSH_FAILED', step: 'push' }), /push-only/);
});
