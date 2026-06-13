import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadFreshEsm } from '../../helpers.ts';
import { lookupShortIdByBranch } from '../../../lib/task/short-id.ts';

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ls-shortid-'));
  const activeDir = path.join(repoRoot, '.agents', 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir };
}

function writeTaskWithBranch(activeDir: string, taskId: string, branch: string): void {
  fs.mkdirSync(path.join(activeDir, taskId), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, taskId, 'task.md'),
    `---\nid: ${taskId}\nbranch: ${branch}\n---\n# body\n`
  );
}

function writeRegistry(activeDir: string, ids: Record<string, string>): void {
  fs.writeFileSync(
    path.join(activeDir, '.short-ids.json'),
    JSON.stringify({ version: 1, ids }, null, 2)
  );
}

test('lookupShortIdByBranch returns #NN for a branch bound to an active task', () => {
  const { repoRoot, activeDir } = mkFixture();
  writeTaskWithBranch(activeDir, 'TASK-20260101-000001', 'feature-bound');
  writeRegistry(activeDir, { '07': 'TASK-20260101-000001' });
  assert.equal(lookupShortIdByBranch('feature-bound', repoRoot), '#07');
});

test("lookupShortIdByBranch returns null for branches without an active task", () => {
  const { repoRoot, activeDir } = mkFixture();
  writeTaskWithBranch(activeDir, 'TASK-20260101-000001', 'feature-bound');
  writeRegistry(activeDir, { '07': 'TASK-20260101-000001' });
  assert.equal(lookupShortIdByBranch('main', repoRoot), null);
});

test('formatContainerTable now uses short id / "-" instead of running-index', async () => {
  const { formatContainerTable } = await loadFreshEsm<typeof import('../../../lib/sandbox/commands/ls.ts')>(
    'lib/sandbox/commands/ls.js'
  );
  const rows = [
    { index: '#11', name: 'sb-feature-eleven', status: 'Up 1 min', branch: 'feature-eleven' },
    { index: '-', name: 'sb-feature-orphan', status: 'Up 2 hours', branch: 'orphan-branch' }
  ];
  const lines = formatContainerTable(rows);
  const namesColumn = lines[0]!.indexOf('NAMES');
  assert.equal(lines[1]!.slice(0, namesColumn).trim(), '#11');
  assert.equal(lines[2]!.slice(0, namesColumn).trim(), '-');
});
