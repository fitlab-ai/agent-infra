import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  SecureFileError,
  readStableFileSync,
} from '../../../lib/task/secure-fs.ts';
import { createTempDir, onPlatforms } from '../../helpers.ts';

test('readStableFileSync binds digest and validation to one descriptor buffer', () => {
  const root = createTempDir('host-control-secure-fs-');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(candidate, 'hello\n');
  const result = readStableFileSync(candidate, { maxBytes: 1024 });
  assert.equal(result.bytes.toString('utf8'), 'hello\n');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.stat.isFile(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bounded readers reject oversized files and mismatched digests', async () => {
  const root = createTempDir('host-control-secure-fs-bounds-');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(candidate, 'hello\n');
  try {
    for (const options of [{ maxBytes: 5 }, { maxBytes: 6, expectedSha256: '0'.repeat(64) }]) {
      assert.throws(() => readStableFileSync(candidate, options), { code: 'TASK_ARTIFACT_WRITE_CONFLICT' });
    }
    assert.equal(readStableFileSync(candidate, { maxBytes: 6 }).bytes.toString('utf8'), 'hello\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('readStableFileSync rejects a symlink terminal', onPlatforms('linux', 'darwin'), () => {
  const root = createTempDir('host-control-secure-fs-link-');
  const target = path.join(root, 'target.md');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(target, 'hello\n');
  fs.symlinkSync(target, candidate);
  assert.throws(() => readStableFileSync(candidate, { maxBytes: 1024 }), (error: unknown) =>
    error instanceof SecureFileError && error.code === 'TASK_ARTIFACT_WRITE_CONFLICT'
  );
  fs.rmSync(root, { recursive: true, force: true });
});
