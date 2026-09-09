import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SecureFileError,
  readStableFile,
  readStableFileSync,
  writeAtomicFile
} from '../../../lib/host-control/secure-fs.ts';
import { onPlatforms } from '../../helpers.ts';

function testRoot(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('readStableFile binds digest and validation to one descriptor buffer', async () => {
  const root = testRoot('host-control-secure-fs-');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(candidate, 'hello\n');
  const result = await readStableFile(candidate, { maxBytes: 1024 });
  assert.equal(result.bytes.toString('utf8'), 'hello\n');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.stat.isFile(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bounded readers reject oversized files and mismatched digests', async () => {
  const root = testRoot('host-control-secure-fs-bounds-');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(candidate, 'hello\n');
  try {
    for (const options of [{ maxBytes: 5 }, { maxBytes: 6, expectedSha256: '0'.repeat(64) }]) {
      assert.throws(() => readStableFileSync(candidate, options), { code: 'TASK_ARTIFACT_WRITE_CONFLICT' });
      await assert.rejects(readStableFile(candidate, options), { code: 'TASK_ARTIFACT_WRITE_CONFLICT' });
    }
    assert.equal(readStableFileSync(candidate, { maxBytes: 6 }).bytes.toString('utf8'), 'hello\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('readStableFile rejects a symlink terminal', onPlatforms('linux', 'darwin'), async () => {
  const root = testRoot('host-control-secure-fs-link-');
  const target = path.join(root, 'target.md');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(target, 'hello\n');
  fs.symlinkSync(target, candidate);
  await assert.rejects(readStableFile(candidate, { maxBytes: 1024 }), (error: unknown) =>
    error instanceof SecureFileError && error.code === 'TASK_ARTIFACT_WRITE_CONFLICT'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeAtomicFile uses an exclusive temporary file and preserves exact bytes', onPlatforms('linux', 'darwin'), async () => {
  const root = testRoot('host-control-secure-fs-write-');
  const target = path.join(root, 'artifact.md');
  await writeAtomicFile(target, Buffer.from('safe\n'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'safe\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});
