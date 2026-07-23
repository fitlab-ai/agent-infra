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
