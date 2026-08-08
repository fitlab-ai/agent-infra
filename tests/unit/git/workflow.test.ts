import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs, pushRebasedBranch } from '../../../lib/git/workflow.ts';

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('commitExplicitPaths commits only explicitly selected paths', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'leave me\n');
  const result = commitExplicitPaths({ cwd: root, paths: ['tracked.txt'], message: 'fix: update tracked file' });
  assert.equal(result.status, 'applied');
  assert.deepEqual(execFileSync('git', ['show', '--pretty=', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), 'tracked.txt');
  assert.match(execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }), /unrelated\.txt/);
});

test('commitExplicitPaths rejects escaping and sensitive paths', () => {
  const root = fixture();
  assert.equal(commitExplicitPaths({ cwd: root, paths: ['../outside'], message: 'x' }).status, 'failed');
  assert.equal(commitExplicitPaths({ cwd: root, paths: ['.env'], message: 'x' }).status, 'failed');
});

test('commitExplicitPaths refuses to include unrelated pre-staged changes', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'other.txt'), 'other\n');
  execFileSync('git', ['add', 'other.txt'], { cwd: root });
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const result = commitExplicitPaths({ cwd: root, paths: ['tracked.txt'], message: 'fix: selected only' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'GIT_STAGED_SCOPE_MISMATCH');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), before);
});

test('inspect and push expose recoverable per-ref outcomes', () => {
  const root = fixture();
  assert.equal(inspectGitWorkflow(root).status, 'no-op');
  const calls: string[][] = [];
  const result = pushGitRefs({ cwd: root, remote: 'origin', refs: ['main', 'bad ref'] }, (args) => {
    calls.push([...args]);
    if (args[0] === 'push' || args[0] === 'ls-remote') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: 'abc\n', stderr: '' };
    if (args[0] === 'branch') return { status: 0, stdout: 'main\n', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.operations.length, 2);
  assert.deepEqual(calls.filter((call) => call[0] === 'push'), [['push', 'origin', 'main']]);
  assert.deepEqual(calls.filter((call) => call[0] === 'ls-remote'), [['ls-remote', '--exit-code', 'origin', 'refs/heads/main']]);
});

test('pushRebasedBranch uses an exact lease after validating local and remote identities', () => {
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const baseHead = 'c'.repeat(40);
  const calls: string[][] = [];
  let remoteHead = oldHead;
  const result = pushRebasedBranch({
    cwd: '/repo', remote: 'origin', branch: 'feature', expectedOldHead: oldHead,
    newHead, baseBranch: 'main', expectedBaseHead: baseHead
  }, (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${newHead}\n`, stderr: '' };
    if (args[0] === 'branch') return { status: 0, stdout: 'feature\n', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return { status: 0, stdout: '/repo/.git/rebase-merge\n', stderr: '' };
    if (args[0] === 'ls-remote') {
      const sha = args.at(-1) === 'refs/heads/main' ? baseHead : remoteHead;
      return { status: 0, stdout: `${sha}\t${args.at(-1)}\n`, stderr: '' };
    }
    if (args[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'push') { remoteHead = newHead; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(calls.find((call) => call[0] === 'push'), [
    'push', `--force-with-lease=refs/heads/feature:${oldHead}`, 'origin', `${newHead}:refs/heads/feature`
  ]);
});

test('pushRebasedBranch rejects stale remote facts without pushing', () => {
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const baseHead = 'c'.repeat(40);
  const calls: string[][] = [];
  const result = pushRebasedBranch({
    cwd: '/repo', remote: 'origin', branch: 'feature', expectedOldHead: oldHead,
    newHead, baseBranch: 'main', expectedBaseHead: baseHead
  }, (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${newHead}\n`, stderr: '' };
    if (args[0] === 'branch') return { status: 0, stdout: 'feature\n', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return { status: 0, stdout: '/repo/.git/rebase-merge\n', stderr: '' };
    if (args[0] === 'ls-remote') return { status: 0, stdout: `${'d'.repeat(40)}\t${args.at(-1)}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });
  assert.equal(result.error?.code, 'GIT_REMOTE_HEAD_MISMATCH');
  assert.equal(calls.some((call) => call[0] === 'push'), false);
});

test('pushRebasedBranch fails closed at every local, base, ancestry, push, and verification boundary', () => {
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const baseHead = 'c'.repeat(40);
  const input = { cwd: '/repo', remote: 'origin', branch: 'feature', expectedOldHead: oldHead, newHead, baseBranch: 'main', expectedBaseHead: baseHead };
  assert.equal(pushRebasedBranch({ ...input, newHead: 'short' }).error?.code, 'GIT_REBASED_INPUT_INVALID');

  const runCase = (stage: 'dirty' | 'identity' | 'base' | 'ancestor' | 'push' | 'verify') => {
    return pushRebasedBranch(input, (args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${stage === 'identity' ? oldHead : newHead}\n`, stderr: '' };
    if (args[0] === 'branch') return { status: 0, stdout: 'feature\n', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: stage === 'dirty' ? '?? local.txt\n' : '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') {
      const isBase = args.at(-1) === 'refs/heads/main';
      const value = isBase ? stage === 'base' ? 'd'.repeat(40) : baseHead
        : oldHead;
      return { status: 0, stdout: `${value}\t${args.at(-1)}\n`, stderr: '' };
    }
    if (args[0] === 'merge-base') return { status: stage === 'ancestor' ? 1 : 0, stdout: '', stderr: '' };
    if (args[0] === 'push') return { status: stage === 'push' ? 1 : 0, stdout: '', stderr: stage === 'push' ? 'rejected' : '' };
    return { status: 1, stdout: '', stderr: '' };
    });
  };

  assert.equal(runCase('dirty').error?.code, 'GIT_LOCAL_STATE_UNSAFE');
  assert.equal(runCase('identity').error?.code, 'GIT_LOCAL_IDENTITY_MISMATCH');
  assert.equal(runCase('base').error?.code, 'GIT_REMOTE_BASE_MISMATCH');
  assert.equal(runCase('ancestor').error?.code, 'GIT_REBASED_ANCESTOR_MISMATCH');
  assert.equal(runCase('push').error?.code, 'GIT_REBASED_PUSH_REJECTED');
  assert.equal(runCase('verify').error?.code, 'GIT_REBASED_VERIFY_FAILED');
});
