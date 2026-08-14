import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostConfirmation, deriveReleasePhase } from '../../../lib/release/workflow.ts';
import type { PostReleaseFacts, ReleaseFacts } from '../../../lib/release/workflow.ts';

const postFacts = (overrides: Partial<PostReleaseFacts> = {}): PostReleaseFacts => ({
  commit: null,
  isHead: false,
  published: false,
  branch: 'main',
  upstream: 'origin/main',
  remoteHead: null,
  newVersion: null,
  changedPaths: [],
  demoInputSha256: null,
  worktree: [],
  staged: [],
  ...overrides
});

const facts = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  localTag: false,
  remoteBranch: false,
  remoteTag: false,
  githubRelease: false,
  npm: false,
  homebrew: false,
  smoke: null,
  post: postFacts(),
  ...overrides
});

test('release phase is derived only from observable facts', () => {
  assert.equal(deriveReleasePhase(facts()), 'unprepared');
  assert.equal(deriveReleasePhase(facts({ localTag: true })), 'prepared');
  assert.equal(deriveReleasePhase(facts({ localTagAncestor: true })), 'prepared');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true })), 'partially-published');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true, remoteTag: true })), 'published');
  assert.equal(deriveReleasePhase(facts({ localTagAncestor: true, remoteBranch: true, remoteTag: true })), 'published');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true, remoteTag: true, githubRelease: true, npm: true, homebrew: true })), 'post-pending');

  const prepared = postFacts({ commit: 'a'.repeat(40), isHead: true });
  assert.equal(deriveReleasePhase(facts({ localTagAncestor: true, post: prepared })), 'post-prepared');
  assert.equal(deriveReleasePhase(facts({ localTagAncestor: true, post: { ...prepared, published: true } })), 'complete');
});

test('post confirmation is deterministic and only available for a clean post HEAD', () => {
  const post = postFacts({
    commit: 'a'.repeat(40),
    isHead: true,
    remoteHead: 'b'.repeat(40),
    newVersion: '1.2.4-alpha.0',
    changedPaths: ['z.txt', 'a.txt'],
    demoInputSha256: 'c'.repeat(64)
  });

  const first = createPostConfirmation('1.2.3', post);
  const second = createPostConfirmation('1.2.3', { ...post, changedPaths: ['a.txt', 'z.txt'] });
  assert.ok(first);
  assert.deepEqual(second, first);
  assert.deepEqual(first.changedPaths, ['a.txt', 'z.txt']);
  assert.match(first.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(createPostConfirmation('1.2.3', { ...post, isHead: false }), null);
  assert.equal(createPostConfirmation('1.2.3', { ...post, worktree: ['dirty.txt'] }), null);
  assert.equal(createPostConfirmation('1.2.3', { ...post, staged: ['staged.txt'] }), null);
});

test('post confirmation digest changes when any authorized fact changes', () => {
  const post = postFacts({
    commit: 'a'.repeat(40),
    isHead: true,
    remoteHead: 'b'.repeat(40),
    newVersion: '1.2.4-alpha.0',
    changedPaths: ['package.json'],
    demoInputSha256: 'c'.repeat(64)
  });
  const baseline = createPostConfirmation('1.2.3', post)?.sha256;
  assert.ok(baseline);

  const variants: PostReleaseFacts[] = [
    { ...post, commit: 'd'.repeat(40) },
    { ...post, branch: 'release' },
    { ...post, upstream: 'fork/main' },
    { ...post, remoteHead: 'e'.repeat(40) },
    { ...post, newVersion: '1.2.5-alpha.0' },
    { ...post, changedPaths: ['package-lock.json'] },
    { ...post, demoInputSha256: 'f'.repeat(64) }
  ];
  for (const variant of variants) assert.notEqual(createPostConfirmation('1.2.3', variant)?.sha256, baseline);
  assert.notEqual(createPostConfirmation('1.2.4', post)?.sha256, baseline);
});
