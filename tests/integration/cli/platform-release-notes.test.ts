import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { INTERNAL_CLI_PATH } from '../../helpers.ts';

function run(args: string[], cwd = process.cwd()) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', INTERNAL_CLI_PATH, 'platform-release-notes', ...args],
    { cwd, encoding: 'utf8' }
  );
}

function runWithInput(args: string[], cwd: string, input: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', INTERNAL_CLI_PATH, 'platform-release-notes', ...args],
    { cwd, encoding: 'utf8', input, env }
  );
}

test('platform-release-notes rejects invalid context input with JSON and exit 1', () => {
  const result = run(['context']);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'failed');
  assert.equal(output.error.code, 'RELEASE_NOTES_INPUT_INVALID');
});

test('platform-release-notes accepts every documented context value flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-context-'));
  try {
    const result = run([
      'context',
      '--cwd', root,
      '--from-tag', 'v0.9.0',
      '--to-tag', 'v0.9.1',
      '--branch', 'main',
      '--history-limit', '3'
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'no-op');
    assert.equal(output.error.code, 'PLATFORM_RELEASE_NOTES_UNSUPPORTED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-release-notes rejects publish without notes input', () => {
  const result = run(['publish', '--tag', 'v1.0.0']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_NOTES_INPUT_INVALID');
});

test('platform-release-notes stages an external file and returns structured digest facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-cli-'));
  const worktree = path.join(root, 'worktree');
  const notesFile = path.join(root, 'notes.md');
  fs.mkdirSync(worktree);
  fs.writeFileSync(notesFile, 'Notes\r\n\r\n');
  try {
    const result = run(['stage', '--notes-file', notesFile], worktree);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'applied');
    assert.equal(output.notesFile, fs.realpathSync(notesFile));
    assert.match(output.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(output.byteLength, 6);
    assert.equal(fs.readFileSync(notesFile, 'utf8'), 'Notes\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform-release-notes strictly rejects invalid stage and publish flags', () => {
  for (const args of [
    ['stage', '--unknown', 'x'],
    ['stage', '--notes-file'],
    ['stage', '--notes-file', 'a', '--notes-file', 'b'],
    ['publish', '--notes-file', 'a', '--expected-sha256'],
    ['publish', '--notes-file', 'a', '--unknown', 'x']
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).error.code, 'RELEASE_NOTES_INPUT_INVALID');
  }
});

test('platform-release-notes removes stdin-backed publish files on every result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-stdin-'));
  const worktree = path.join(root, 'worktree');
  const temporary = path.join(root, 'temporary');
  const input = 'Notes\n';
  fs.mkdirSync(worktree);
  fs.mkdirSync(temporary);
  try {
    const result = runWithInput([
      'publish',
      '--tag', 'v1.0.0',
      '--title', 'v1.0.0',
      '--notes-file', '-',
      '--expected-sha256', `sha256:${createHash('sha256').update(input).digest('hex')}`
    ], worktree, input, { ...process.env, TMPDIR: temporary });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(temporary), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
