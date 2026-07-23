import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

test('internal task-verify resolves task identity and invokes the typed engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-integration-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const id = 'TASK-20260101-000001';
    const dir = path.join(root, '.agents', 'workspace', 'active', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\n---\n`);
    fs.writeFileSync(path.join(dir, 'code.md'), '# Code\n');
    writeJson(path.join(root, '.agents/skills/code-task/config/verify.json'), { skill: 'code-task', checks: {} });
    writeJson(path.join(root, '.agents/skills/complete-task/config/verify.json'), {
      skill: 'complete-task', checks: {
        'review-ledger': null, 'post-review-commit': null,
        'required-checks': null, 'platform-sync-preflight': null
      }
    });

    const pass = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'code.completed', '--artifact', 'code.md', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /Verification: pass \| Skill: code-task/);

    const preflight = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'complete-task.preflight', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal((preflight.stdout.match(/^Check: pass/gm) ?? []).length, 4);

    const duplicate = spawnSync(process.execPath, [INTERNAL_CLI_PATH, 'task-verify', id, 'commit.completed', '--format', 'json', '--format', 'text'], { cwd: root, encoding: 'utf8' });
    assert.equal(duplicate.status, 1);
    assert.equal(JSON.parse(duplicate.stdout).error.code, 'VERIFY_PAYLOAD_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
