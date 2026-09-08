import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SecureFileError,
  readStableFile,
  writeAtomicFile
} from '../../../lib/host-control/secure-fs.ts';

test('readStableFile binds digest and validation to one descriptor buffer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-secure-fs-'));
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(candidate, 'hello\n');
  const result = await readStableFile(candidate, { maxBytes: 1024 });
  assert.equal(result.bytes.toString('utf8'), 'hello\n');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.stat.isFile(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readStableFile rejects a symlink terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-secure-fs-link-'));
  const target = path.join(root, 'target.md');
  const candidate = path.join(root, 'code.md');
  fs.writeFileSync(target, 'hello\n');
  fs.symlinkSync(target, candidate);
  await assert.rejects(readStableFile(candidate, { maxBytes: 1024 }), (error: unknown) =>
    error instanceof SecureFileError && error.code === 'TASK_ARTIFACT_WRITE_CONFLICT'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeAtomicFile uses an exclusive temporary file and preserves exact bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-secure-fs-write-'));
  const target = path.join(root, 'artifact.md');
  await writeAtomicFile(target, Buffer.from('safe\n'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'safe\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});
