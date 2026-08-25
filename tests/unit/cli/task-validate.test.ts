import test from 'node:test';
import assert from 'node:assert/strict';

import { parseValidateArgs } from '../../../lib/internal/task-validate.ts';

test('validate parser requires an explicit command boundary and bounded options', () => {
  assert.deepEqual(parseValidateArgs([
    'task', '--scope', 'snapshot', '--timeout', '25', '--format', 'json', '--', 'node', '-v'
  ]), {
    target: 'task', scope: 'snapshot', timeoutMs: 25, format: 'json', command: ['node', '-v'], help: false
  });
  assert.throws(() => parseValidateArgs(['task', 'node', '-v']), /literal --/);
  assert.throws(() => parseValidateArgs(['task', '--timeout', '0', '--', 'node']), /1\.\.3600000/);
});
