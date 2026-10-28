import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeResources } from '../../../lib/process-data/normalize.ts';

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
