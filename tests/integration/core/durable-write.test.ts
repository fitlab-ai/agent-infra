import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeDurableFile } from '../../../lib/fs/durable-write.ts';
import { onPlatforms } from '../../helpers.ts';

test('durable publication distinguishes replacement from immutable creation', onPlatforms('linux', 'darwin'), (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'record');
  writeDurableFile(target, 'first', { mode: 0o600, replace: false });
  assert.throws(() => writeDurableFile(target, 'conflicting', { mode: 0o600, replace: false }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  writeDurableFile(target, 'replacement', { mode: 0o400, replace: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
  assert.equal(fs.statSync(target).mode & 0o777, 0o400);
  assert.deepEqual(fs.readdirSync(root), ['record']);
});

test('durable publication preserves the target and cleans temporary files on sync failure', onPlatforms('linux', 'darwin'), (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-write-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'record');
  fs.writeFileSync(target, 'original');
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('SYNC_FAILED'); });
  assert.throws(() => writeDurableFile(target, 'candidate', { mode: 0o600, replace: true }), /SYNC_FAILED/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['record']);
});
