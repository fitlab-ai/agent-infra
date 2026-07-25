import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('platform-release-notes rejects invalid context input with JSON and exit 1', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'bin/internal-cli.ts', 'platform-release-notes', 'context'],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'failed');
  assert.equal(output.error.code, 'RELEASE_NOTES_INPUT_INVALID');
});

test('platform-release-notes rejects publish without notes input', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'bin/internal-cli.ts', 'platform-release-notes', 'publish', '--tag', 'v1.0.0'],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_NOTES_INPUT_INVALID');
});
