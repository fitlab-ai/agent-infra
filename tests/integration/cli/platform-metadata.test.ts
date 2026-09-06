import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function rootWithNoneProvider(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-metadata-cli-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ platform: { type: 'none' } }));
  return root;
}

function run(root: string, command: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', INTERNAL_CLI_PATH, 'platform-metadata', command, '--cwd', root, ...args], {
    cwd: root, encoding: 'utf8'
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
