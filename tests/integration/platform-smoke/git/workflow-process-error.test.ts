import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs } from '../../../../lib/git/workflow.ts';

test('process errors override a zero status and a failed push is not replayed', () => {
  let pushes = 0;
  let failHead = true;
  mock.method(childProcess, 'spawnSync', ((_file: unknown, args: string[]) => {
    if (args[0] === 'push') {
      pushes += 1;
      return { status: 0, stdout: '', stderr: '', error: new Error('unknown push result') };
    }
    if (failHead && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { status: 0, stdout: 'head\n', stderr: '', error: new Error('process error') };
    }
    const output = args[0] === 'rev-parse' ? 'head\n' : args[0] === 'branch' ? 'feature\n' : '';
    return { status: 0, stdout: output, stderr: '' };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    assert.equal(inspectGitWorkflow('/unused').error?.code, 'GIT_INSPECT_FAILED');
    failHead = false;
    const pushed = pushGitRefs({ cwd: '/unused', remote: 'origin', refs: ['feature'] });
    assert.equal(pushed.status, 'failed');
    assert.equal(pushed.error?.code, 'GIT_PUSH_PARTIAL');
    assert.equal(pushes, 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('only a staged diff status of 1 without a process error proceeds to commit', () => {
  let probe: { status: number | null; error?: Error } = { status: 0 };
  let commits = 0;
  mock.method(childProcess, 'spawnSync', ((_file: unknown, args: string[]) => {
    if (args[0] === 'diff') return { ...probe, stdout: '', stderr: '' };
    if (args[0] === 'commit') commits += 1;
    const stdout = args[0] === 'rev-parse' ? 'head\n' : args[0] === 'branch' ? 'feature\n' : args[0] === 'ls-files' || args[0] === 'ls-tree' ? 'tracked.txt\0' : '';
    return { status: 0, stdout, stderr: '' };
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    for (const [status, error, expected] of [
      [0, undefined, 'no-op'], [1, undefined, 'applied'], [null, undefined, 'failed'],
      [128, undefined, 'failed'], [0, new Error('diff failed'), 'failed'], [1, new Error('diff failed'), 'failed']
    ] as const) {
      probe = { status, ...(error ? { error } : {}) };
      commits = 0;
      const result = commitExplicitPaths({ cwd: '/unused', paths: ['tracked.txt'], message: 'fix: test' });
      assert.equal(result.status, expected);
      assert.equal(commits, expected === 'applied' ? 1 : 0);
      if (expected === 'failed') assert.equal(result.error?.code, 'GIT_STAGE_FAILED');
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
