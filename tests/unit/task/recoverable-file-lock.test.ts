import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireFileLock } from '../../../lib/fs/file-lock.ts';
import { withRecoverableFileLock } from '../../../lib/task/recoverable-file-lock.ts';

test('recoverable lock reclaims an owner that died before publishing lock contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverable-lock-dead-owner-'));
  const lock = path.join(root, 'writer.lock');
  try {
    fs.writeFileSync(lock, '');
    assert.equal(withRecoverableFileLock(lock, 'LOCK_CONFLICT', () => 'entered'), 'entered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recoverable lock does not enter while another writer holds the native lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverable-lock-unknown-owner-'));
  const lock = path.join(root, 'writer.lock');
  const held = acquireFileLock(lock);
  try {
    assert.throws(
      () => withRecoverableFileLock(lock, 'LOCK_CONFLICT', () => 'entered'),
      /LOCK_CONFLICT/u
    );
  } finally {
    held.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
