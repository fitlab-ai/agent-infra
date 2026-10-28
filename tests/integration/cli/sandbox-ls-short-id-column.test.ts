import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFreshEsm } from '../../helpers.ts';

test('formatContainerTable now uses short id / "-" instead of running-index', async () => {
  const { formatContainerTable } = await loadFreshEsm<typeof import('../../../lib/sandbox/commands/ls.ts')>(
    'lib/sandbox/commands/ls.js'
  );
  const rows = [
    { row: '1', shortId: '#11', name: 'sb-feature-eleven', status: 'Up 1 min', workspace: 'task-bound', taskId: 'TASK-20260809-010203', branch: 'feature-eleven' },
    { row: '2', shortId: '-', name: 'sb-feature-orphan', status: 'Up 2 hours', workspace: 'branch-only', taskId: '-', branch: 'orphan-branch' }
  ];
  const lines = formatContainerTable(rows);
  const shortColumn = lines[0]!.indexOf('SHORT');
  const namesColumn = lines[0]!.indexOf('NAMES');
  // short id now lives in the 'SHORT' column (between '#' row number and 'NAMES')
  assert.equal(lines[1]!.slice(shortColumn, namesColumn).trim(), '#11');
  assert.equal(lines[2]!.slice(shortColumn, namesColumn).trim(), '-');
});
