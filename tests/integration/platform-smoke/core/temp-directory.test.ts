import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { createTempDir, gitSafeEnv, onPlatforms } from '../../../helpers.ts';

test('temporary fixtures are unique canonical directories with the requested prefix', (t) => {
  const first = createTempDir('canonical-fixture-');
  const second = createTempDir('canonical-fixture-');
  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  assert.notEqual(first, second);
  assert.equal(fs.statSync(first).isDirectory(), true);
  assert.equal(path.basename(first).startsWith('canonical-fixture-'), true);
  assert.equal(first, fs.realpathSync.native(first));
  execFileSync('git', ['init', '-q'], { cwd: first, env: gitSafeEnv() });
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: first, env: gitSafeEnv(), encoding: 'utf8'
  }).trim();
  assert.equal(fs.realpathSync.native(gitRoot), first);
});

test('temporary fixtures resolve an aliased temp parent before returning the new path', onPlatforms('linux', 'darwin'), (t) => {
  const root = createTempDir('temp-parent-alias-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realParent = path.join(root, 'real parent');
  const alias = path.join(root, 'alias parent');
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, alias, 'dir');
  t.mock.method(os, 'tmpdir', () => alias);
  const created = createTempDir('child-');
  assert.equal(path.dirname(created), fs.realpathSync.native(realParent));
  assert.equal(created, fs.realpathSync.native(created));
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
});
