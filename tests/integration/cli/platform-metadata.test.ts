import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTempDir, INTERNAL_CLI_PATH } from '../../helpers.ts';

function rootWithNoneProvider(): string {
  const root = createTempDir('platform-metadata-cli-');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ platform: { type: 'none' } }));
  return root;
}

function run(root: string, command: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', INTERNAL_CLI_PATH, 'platform-metadata', command, '--cwd', root, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });
}

test('platform-metadata exposes structured degraded labels and preserves milestone fallback output', () => {
  const root = rootWithNoneProvider();
  try {
    const labels = run(root, 'init-labels');
    assert.equal(labels.status, 0, labels.stderr);
    const labelResult = JSON.parse(labels.stdout);
    assert.equal(labelResult.status, 'degraded');
    assert.equal(labelResult.error.code, 'PLATFORM_CAPABILITY_UNSUPPORTED');

    const milestones = run(root, 'init-milestones', '--history');
    assert.equal(milestones.status, 0, milestones.stderr);
    assert.equal(milestones.stdout, '');
    assert.match(milestones.stderr, /Milestone initialization skipped/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-metadata preserves help and action-specific option errors', () => {
  const root = rootWithNoneProvider();
  const usage = 'Usage: agent-infra-internal platform-metadata init-labels [--cleanup-stale-in] [--cwd <path>]\n'
    + '       agent-infra-internal platform-metadata init-milestones [--history] [--cwd <path>]\n';
  try {
    const help = run(root, '--help');
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout, usage);
    assert.equal(help.stderr, '');

    for (const [action, option, message] of [
      ['init-labels', '--history', 'init-labels does not accept --history'],
      ['init-milestones', '--cleanup-stale-in', 'init-milestones does not accept --cleanup-stale-in']
    ] as const) {
      const invalid = run(root, action, option);
      assert.equal(invalid.status, 1);
      assert.deepEqual(JSON.parse(invalid.stdout), {
        status: 'failed',
        changed: false,
        error: { code: 'METADATA_INPUT_INVALID', message, retryable: false }
      });
      assert.equal(invalid.stderr, usage);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
