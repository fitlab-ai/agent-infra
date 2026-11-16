import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const INTERNAL_CLI = path.resolve('bin/internal-cli.ts');

function run(args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', INTERNAL_CLI, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8'
  });
}

test('platform-pr-review keeps its structured missing-PR error contract', () => {
  const result = run(['platform-pr-review', 'inspect']);

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'failed',
    changed: false,
    error: { code: 'PR_REVIEW_PAYLOAD_INVALID', message: 'inspect requires --pr <token>' }
  });
});

test('pr-review-grade keeps its structured missing-input error contract', () => {
  const result = run(['pr-review-grade', 'decide']);

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'failed',
    changed: false,
    error: { code: 'PR_REVIEW_GRADE_INVALID', message: 'decide requires --input-file' }
  });
});
