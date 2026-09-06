import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { filePath, gitSafeEnv, withGitSafeProcessEnv } from '../../helpers.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitSafeEnv() }).trim();
}

test('platform-sync obtains computed in-label repository metadata from the selected provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-sync-provider-'));
  const taskId = 'TASK-20260906-000001';
  const calls = path.join(root, 'provider-calls.txt');
  try {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'complete-task', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
      platform: {
        type: 'trae',
        providers: { trae: { source: filePath('tests/fixtures/platform-providers/in-label-provider.mjs'), config: { callsPath: calls } } }
      },
      labels: { in: { core: ['lib/'] } }
    }));
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'complete-task', 'config', 'verify.json'), JSON.stringify({
      skill: 'complete-task', checks: { 'platform-sync': { verify_in_labels_computed: true } }
    }));
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
    const baseRef = git(root, ['rev-parse', 'HEAD']);
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', 'core.ts'), 'export const core = true;\n');
    git(root, ['add', 'lib/core.ts']);
    git(root, ['commit', '-qm', 'change']);
    const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'task.md'), [
      '---',
      `id: ${taskId}`,
      'type: refactor',
      'workflow: refactoring',
      'status: active',
      'created_at: 2026-09-06T00:00:00+00:00',
      'updated_at: 2026-09-06T00:00:00+00:00',
      'agent_infra_version: v0.9.13',
      'current_step: code-review',
      'issue_number: 7',
      `delivery_base_ref: ${baseRef}`,
      '---',
      '',
      '# Task',
      '',
      'Provider routing test.'
    ].join('\n'));

    const result = await withGitSafeProcessEnv(() => verifyInProcess({
      mode: 'gate', skillName: 'complete-task', taskDir, checks: [], repositoryRoot: root
    }), { AGENT_INFRA_GH_BIN: path.join(root, 'github-must-not-run') });
    assert.equal(result.gate, 'pass', JSON.stringify(result));
    assert.equal(result.checks[0].status, 'pass');
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
      'context.resolve',
      'verification.fetchRemoteFacts',
      'issues.listLabels'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
