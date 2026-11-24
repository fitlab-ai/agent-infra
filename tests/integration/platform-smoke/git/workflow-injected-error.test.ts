import test from 'node:test';
import assert from 'node:assert/strict';
import { commitExplicitPaths } from '../../../../lib/git/workflow.ts';

test('injected runner errors prevent staged decisions and commits regardless of status', () => {
  for (const status of [0, 1]) {
    let commits = 0;
    const runner = (args: readonly string[]) => {
      if (args[0] === 'commit') commits++;
      if (args[0] === 'diff') return { status, stdout: '', stderr: '', error: new Error('diff failed') };
      const stdout = args[0] === 'rev-parse' ? 'head\n' : args[0] === 'branch' ? 'feature\n' : args[0] === 'ls-files' || args[0] === 'ls-tree' ? 'tracked.txt\0' : '';
      return { status: 0, stdout, stderr: '' };
    };
    const result = commitExplicitPaths({ cwd: '/unused', paths: ['tracked.txt'], message: 'fix: test' }, runner);
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'GIT_STAGE_FAILED');
    assert.equal(commits, 0);
  }
});
