import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';

test('top-level and data help expose the process-data command family', () => {
  const top = spawnSync('node', [CLI_PATH, 'help'], { encoding: 'utf8' });
  assert.equal(top.status, 0);
  assert.match(top.stdout, /^  data\s/m);

  const data = spawnSync('node', [CLI_PATH, 'data', '--help'], { encoding: 'utf8' });
  assert.equal(data.status, 0);
  for (const command of ['capture', 'verify', 'audit', 'repair', 'export']) {
    assert.match(data.stdout, new RegExp(`^  ${command}\\b`, 'm'));
  }
});
