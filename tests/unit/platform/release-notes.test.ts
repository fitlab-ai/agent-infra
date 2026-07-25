import test from 'node:test';
import assert from 'node:assert/strict';

import { releaseNoteContext, publishReleaseNotes } from '../../../lib/platform/release-notes.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

const unavailable: GitHubClient = {
  version() { throw new Error('GitHub client must not be probed'); },
  json() { throw new Error('GitHub client must not be probed'); },
  text() { throw new Error('GitHub client must not be probed'); }
};

test('unsupported platforms return a stable no-op without probing GitHub', () => {
  const context = releaseNoteContext(
    { fromTag: 'v0.9.0', toTag: 'v0.9.1', branch: 'main' },
    { platformType: 'none', client: unavailable }
  );
  assert.equal(context.status, 'no-op');
  assert.equal(context.error?.code, 'PLATFORM_RELEASE_NOTES_UNSUPPORTED');
  assert.deepEqual(context.pullRequests, []);

  const publish = publishReleaseNotes(
    { tag: 'v0.9.1', title: 'v0.9.1', notesFile: '/tmp/notes' },
    { platformType: 'custom', client: unavailable }
  );
  assert.equal(publish.status, 'no-op');
});

test('context validates its range before platform access', () => {
  const result = releaseNoteContext(
    { fromTag: '', toTag: 'v0.9.1', branch: 'main' },
    { platformType: 'github', client: unavailable }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RELEASE_NOTES_INPUT_INVALID');
});
