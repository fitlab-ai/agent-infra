import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

test('platform-security validates input before resolving a provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-security-cli-'));
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', INTERNAL_CLI_PATH, 'platform-security', 'read',
      '--kind', 'dependabot', '--number', '0', '--cwd', root
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'SECURITY_INPUT_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
