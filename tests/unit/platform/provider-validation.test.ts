import test from 'node:test';
import assert from 'node:assert/strict';

import { invokeProviderOperation } from '../../../lib/platform/provider-validation.ts';

test('provider invocation maps throws and malformed envelopes to stable failures', async () => {
  const thrown = await invokeProviderOperation('trae', 'issues.inspect', async () => { throw new Error('secret token'); }, (value) => value as never);
  assert.equal(thrown.ok, false);
  if (!thrown.ok) {
    assert.equal(thrown.error.code, 'PLATFORM_PROVIDER_OPERATION_FAILED');
    assert.equal(thrown.error.providerType, 'trae');
    assert.equal(thrown.error.phase, 'issues.inspect');
    assert.doesNotMatch(thrown.error.message, /secret token/);
  }

  const envelope = await invokeProviderOperation('trae', 'issues.inspect', async () => ({ ok: true, value: null }), () => { throw new Error('invalid snapshot'); });
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
});

test('provider invocation preserves structured provider errors and retryability', async () => {
  const result = await invokeProviderOperation('trae', 'issues.inspect', async () => ({ ok: false, error: { code: 'REMOTE_BUSY', message: 'try later', retryable: true } }), (value) => value as never);
  assert.deepEqual(result, { ok: false, error: { code: 'REMOTE_BUSY', message: 'try later', retryable: true, providerType: 'trae', phase: 'issues.inspect' } });
});
