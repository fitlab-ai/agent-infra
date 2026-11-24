import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { inspectGitWorkflow, pushGitRefs } from '../../../../lib/git/workflow.ts';

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
