import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTER_CONTRACT_VERSION } from '../../../lib/server/adapters/_contract.ts';

// Structural tripwire: bumping the contract version is a deliberate, breaking
// change for subtasks B/C, so it must be an intentional test update too.
test('adapter contract exposes a stable integer version constant', () => {
  assert.equal(typeof ADAPTER_CONTRACT_VERSION, 'number');
  assert.equal(Number.isInteger(ADAPTER_CONTRACT_VERSION), true);
  assert.equal(ADAPTER_CONTRACT_VERSION, 1);
});
