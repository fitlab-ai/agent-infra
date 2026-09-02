import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { releaseNoteContext, publishReleaseNotes, stageReleaseNotes } from '../../../lib/platform/release-notes.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

const unavailable: GitHubClient = {
  version() { throw new Error('GitHub client must not be probed'); },
  json() { throw new Error('GitHub client must not be probed'); },
  text() { throw new Error('GitHub client must not be probed'); }
};

function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && ['EPERM', 'EACCES', 'ENOTSUP', 'ENOENT'].includes(code)) {
      return false;
    }
    throw error;
  }
}

test('unsupported platforms return a stable no-op without probing GitHub', async () => {
  const context = await releaseNoteContext(
    { fromTag: 'v0.9.0', toTag: 'v0.9.1', branch: 'main' },
    { platformType: 'none', client: unavailable }
  );
  assert.equal(context.status, 'no-op');
  assert.equal(context.error?.code, 'PLATFORM_RELEASE_NOTES_UNSUPPORTED');
  assert.deepEqual(context.pullRequests, []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-unit-'));
  const notesFile = path.join(root, 'notes.md');
  fs.writeFileSync(notesFile, 'Notes\n');
  try {
    const publish = await publishReleaseNotes(
      {
        tag: 'v0.9.1',
        title: 'v0.9.1',
        notesFile,
        expectedSha256: `sha256:${createHash('sha256').update('Notes\n').digest('hex')}`
      },
      { cwd: path.join(root, 'worktree'), platformType: 'custom', client: unavailable }
    );
    assert.equal(publish.status, 'failed');
    assert.equal(publish.error?.code, 'PLATFORM_PROVIDER_SOURCE_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stage normalizes release notes and returns the digest of exact staged bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-stage-'));
  const worktree = path.join(root, 'worktree');
  const notesFile = path.join(root, 'notes.md');
  fs.mkdirSync(worktree);
  fs.writeFileSync(notesFile, 'One\r\nTwo\r\n\r\n');
  try {
    const staged = stageReleaseNotes({ notesFile }, { cwd: worktree });
    assert.equal(staged.status, 'applied');
    assert.equal(fs.readFileSync(notesFile, 'utf8'), 'One\nTwo\n');
    assert.equal(staged.byteLength, 8);
    assert.equal(staged.sha256, `sha256:${createHash('sha256').update('One\nTwo\n').digest('hex')}`);

    const unchanged = stageReleaseNotes({ notesFile }, { cwd: worktree });
    assert.equal(unchanged.status, 'no-op');
    assert.equal(unchanged.sha256, staged.sha256);
    assert.deepEqual(fs.readdirSync(root).sort(), ['notes.md', 'worktree']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stage rejects invalid UTF-8 without changing the source file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-utf8-'));
  const worktree = path.join(root, 'worktree');
  const notesFile = path.join(root, 'notes.md');
  const bytes = Buffer.from([0xc3, 0x28]);
  fs.mkdirSync(worktree);
  fs.writeFileSync(notesFile, bytes);
  try {
    const result = stageReleaseNotes({ notesFile }, { cwd: worktree });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RELEASE_NOTES_CONTENT_INVALID');
    assert.deepEqual(fs.readFileSync(notesFile), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stage rejects paths in the worktree, symlinks, and non-files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-boundary-'));
  const worktree = path.join(root, 'worktree');
  const inside = path.join(worktree, 'notes.md');
  const outside = path.join(root, 'outside.md');
  const link = path.join(root, 'link.md');
  fs.mkdirSync(worktree);
  fs.writeFileSync(inside, 'inside');
  fs.writeFileSync(outside, 'outside');
  try {
    const rejectedPaths = [inside, root];
    if (trySymlink(outside, link)) rejectedPaths.push(link);
    for (const notesFile of rejectedPaths) {
      const result = stageReleaseNotes({ notesFile }, { cwd: worktree });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'RELEASE_NOTES_PATH_INVALID');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publish rejects digest mismatches before platform access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-publish-'));
  const notesFile = path.join(root, 'notes.md');
  fs.writeFileSync(notesFile, 'Notes\n');
  try {
    const result = await publishReleaseNotes(
      { tag: 'v1.0.0', title: 'v1.0.0', notesFile, expectedSha256: `sha256:${'0'.repeat(64)}` },
      { cwd: path.join(root, 'worktree'), platformType: 'github', client: unavailable }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RELEASE_NOTES_DIGEST_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publish accepts a matching digest and rejects unreadable files before platform access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-match-'));
  const notesFile = path.join(root, 'notes.md');
  fs.writeFileSync(notesFile, 'Notes\n');
  const digest = `sha256:${createHash('sha256').update('Notes\n').digest('hex')}`;
  const writes: string[][] = [];
  const client: GitHubClient = {
    version: () => ({ ok: true, value: '2.72.0' }),
    json(args) {
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { ok: true, value: { data: { viewer: { login: 'tester' } } } } as never;
      }
      if (args[0] === 'api') {
        return {
          ok: true,
          value: { full_name: 'fitlab-ai/agent-infra', permissions: { admin: true } }
        } as never;
      }
      return { ok: true, value: { url: 'https://example/release' } } as never;
    },
    text(args) {
      writes.push(args);
      return { ok: true, value: 'https://example/release' };
    }
  };
  try {
    const published = await publishReleaseNotes(
      { tag: 'v1.0.0', title: 'v1.0.0', notesFile, expectedSha256: digest },
      { cwd: process.cwd(), platformType: 'github', client }
    );
    assert.equal(published.status, 'applied');
    assert.equal(writes.length, 1);

    const unreadable = await publishReleaseNotes(
      { tag: 'v1.0.0', title: 'v1.0.0', notesFile: path.join(root, 'missing.md'), expectedSha256: digest },
      { cwd: process.cwd(), platformType: 'github', client: unavailable }
    );
    assert.equal(unreadable.status, 'failed');
    assert.equal(unreadable.error?.code, 'RELEASE_NOTES_FILE_UNREADABLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context validates its range before platform access', async () => {
  const result = await releaseNoteContext(
    { fromTag: '', toTag: 'v0.9.1', branch: 'main' },
    { platformType: 'github', client: unavailable }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RELEASE_NOTES_INPUT_INVALID');
});
