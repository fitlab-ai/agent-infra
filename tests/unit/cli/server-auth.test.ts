import test from 'node:test';
import assert from 'node:assert/strict';

import { authorize } from '../../../lib/server/auth.ts';

test('authorize fail-closes unregistered users and enforces role hierarchy', () => {
  assert.deepEqual(authorize({ adapter: 'feishu', userId: 'u1' }, 'read', {}), {
    ok: false,
    message: 'requires read'
  });
  assert.deepEqual(authorize({ adapter: 'feishu', userId: 'u1' }, 'write', {}), {
    ok: false,
    message: 'requires write'
  });
  assert.deepEqual(
    authorize(
      { adapter: 'feishu', userId: 'u1' },
      'exec',
      { users: { 'feishu:u1': { role: 'write' } } }
    ),
    { ok: false, message: 'requires exec' }
  );
  assert.deepEqual(
    authorize(
      { adapter: 'feishu', userId: 'u1' },
      'exec',
      { users: { 'feishu:u1': { role: 'exec' } } }
    ),
    { ok: true }
  );
});
