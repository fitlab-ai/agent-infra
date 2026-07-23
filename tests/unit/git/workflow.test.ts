import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs } from '../../../lib/git/workflow.ts';

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
