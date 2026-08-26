import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH, gitSafeEnv } from '../../helpers.ts';

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'git-workflow', ...args], { cwd: root, encoding: 'utf8', env: gitSafeEnv() });
}

test('git-workflow CLI commits explicit paths and verifies remote refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-cli-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-remote-'));
  try {
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
    const input = path.join(root, 'commit.json');
    fs.writeFileSync(input, JSON.stringify({ paths: ['tracked.txt'], message: 'fix: update tracked file' }));
    const committed = run(root, ['commit', '--input', input]);
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(JSON.parse(committed.stdout).status, 'applied');

    const pushInput = path.join(root, 'push.json');
    fs.writeFileSync(pushInput, JSON.stringify({ remote: 'origin', refs: ['main'] }));
    const pushed = run(root, ['push', '--input', pushInput]);
    assert.equal(pushed.status, 0, pushed.stderr);
    const inspectInput = path.join(root, 'inspect.json');
    fs.writeFileSync(inspectInput, JSON.stringify({ remote: 'origin', refs: ['main'] }));
    const inspected = run(root, ['inspect', '--input', inspectInput]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).snapshot.remoteRefs.main, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('git-workflow commit policy pushes ordinary branches, reports failure, and recovers push-only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-policy-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-policy-remote-'));
  const missingRemote = path.join(remote, 'missing.git');
  try {
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', missingRemote], { cwd: root });
    fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'feature'], { cwd: root });
    const input = path.join(root, 'push.json');
    fs.writeFileSync(input, JSON.stringify({
      remote: 'origin', refs: ['refs/heads/feature'], policy: { branch: 'feature', automatic: true }
    }));
    const failed = run(root, ['push', '--input', input]);
    assert.equal(failed.status, 0, failed.stderr);
    const failedPayload = JSON.parse(failed.stdout);
    assert.equal(failedPayload.outcome, 'committed_with_warnings');
    assert.equal(failedPayload.warnings[0].code, 'COMMIT_PUSH_FAILED');

    execFileSync('git', ['init', '-q', '--bare', missingRemote]);
    const pushOnlyInput = path.join(root, 'push-only.json');
    fs.writeFileSync(pushOnlyInput, JSON.stringify({ remote: 'origin', refs: ['refs/heads/feature'] }));
    const pushOnly = run(root, ['push', '--input', pushOnlyInput]);
    assert.equal(pushOnly.status, 0, pushOnly.stderr);
    assert.equal(JSON.parse(pushOnly.stdout).status, 'applied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('git-workflow commit policy rejects a branch/ref mismatch before pushing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-policy-mismatch-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-policy-mismatch-remote-'));
  try {
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    fs.writeFileSync(path.join(root, 'main.txt'), 'main\n');
    execFileSync('git', ['add', 'main.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'main'], { cwd: root });
    const input = path.join(root, 'mismatch.json');
    fs.writeFileSync(input, JSON.stringify({
      remote: 'origin', refs: ['refs/heads/main'], policy: { branch: 'feature', automatic: true }
    }));
    const rejected = run(root, ['push', '--input', input]);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).error.code, 'COMMIT_PUSH_POLICY_INVALID');
    assert.throws(() => execFileSync('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], { cwd: root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('git-workflow push-rebased ignores a retained REBASE_HEAD after a completed rewrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-rebase-cli-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'git-workflow-rebase-remote-'));
  try {
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: root });
    const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['switch', '-qc', 'feature'], { cwd: root });
    fs.writeFileSync(path.join(root, 'feature.txt'), 'one\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'feature one'], { cwd: root });
    execFileSync('git', ['push', '-q', 'origin', 'feature'], { cwd: root });
    const oldHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['commit', '--amend', '-qm', 'feature rewritten'], { cwd: root });
    const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(root, '.git', 'REBASE_HEAD'), `${oldHead}\n`);
    const input = path.join(remote, 'push-rebased.json');
    fs.writeFileSync(input, JSON.stringify({ remote: 'origin', branch: 'feature', expectedOldHead: oldHead, newHead, baseBranch: 'main', expectedBaseHead: baseHead }));
    const pushed = run(root, ['push-rebased', '--input', input]);
    assert.equal(pushed.status, 0, `${pushed.stderr}\n${pushed.stdout}`);
    assert.equal(JSON.parse(pushed.stdout).status, 'applied');
    assert.equal(execFileSync('git', ['ls-remote', 'origin', 'refs/heads/feature'], { cwd: root, encoding: 'utf8' }).split(/\s/)[0], newHead);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});
