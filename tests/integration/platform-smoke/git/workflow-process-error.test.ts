import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { commitExplicitPaths, pushGitRefs } from '../../../../lib/git/workflow.ts';

test('process errors override a zero status and a failed push is not replayed', () => {
  mock.method(childProcess, 'spawnSync', ((_file: unknown, args: string[]) => {
    if (args[0] === 'push') {
      return { status: 0, stdout: '', stderr: '', error: new Error('unknown push result') };
    }
    const output = args[0] === 'rev-parse' ? 'head\n' : args[0] === 'branch' ? 'feature\n' : '';
    return { status: 0, stdout: output, stderr: '' };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    const pushed = pushGitRefs({ cwd: '/unused', remote: 'origin', refs: ['feature'] });
    assert.equal(pushed.status, 'failed');
    assert.equal(pushed.error?.code, 'GIT_PUSH_PARTIAL');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a staged diff process error cannot proceed to commit', () => {
  let commits = 0;
  mock.method(childProcess, 'spawnSync', ((_file: unknown, args: string[]) => {
    if (args[0] === 'diff') return { status: 1, error: new Error('diff failed'), stdout: '', stderr: '' };
    if (args[0] === 'commit') commits += 1;
    const stdout = args[0] === 'rev-parse' ? 'head\n' : args[0] === 'branch' ? 'feature\n' : args[0] === 'ls-files' || args[0] === 'ls-tree' ? 'tracked.txt\0' : '';
    return { status: 0, stdout, stderr: '' };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    const result = commitExplicitPaths({ cwd: '/unused', paths: ['tracked.txt'], message: 'fix: test' });
    assert.equal(result.error?.code, 'GIT_STAGE_FAILED');
    assert.equal(commits, 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
