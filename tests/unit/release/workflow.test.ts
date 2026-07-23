import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveReleasePhase, runReleaseAction } from '../../../lib/release/workflow.ts';
import type { ReleaseFacts } from '../../../lib/release/workflow.ts';

const facts = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({ localTag: false, remoteBranch: false, remoteTag: false, githubRelease: false, npm: false, homebrew: false, smoke: null, postCommit: false, ...overrides });

test('release phase is derived only from observable facts', () => {
  assert.equal(deriveReleasePhase(facts()), 'unprepared');
  assert.equal(deriveReleasePhase(facts({ localTag: true })), 'prepared');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true })), 'partially-published');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true, remoteTag: true })), 'published');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true, remoteTag: true, githubRelease: true, npm: true, homebrew: true })), 'post-pending');
  assert.equal(deriveReleasePhase(facts({ localTag: true, remoteBranch: true, remoteTag: true, githubRelease: true, npm: true, homebrew: true, smoke: 'success', postCommit: true })), 'complete');
});

test('publish is independently authorized and replayable after partial progress', async () => {
  let current = facts({ localTag: true, remoteBranch: true });
  const result = await runReleaseAction({ version: '1.2.3', action: 'publish', inspect: async () => current, publish: async () => { current = facts({ localTag: true, remoteBranch: true, remoteTag: true }); } });
  assert.equal(result.status, 'applied');
  assert.equal(result.before.phase, 'partially-published');
  assert.equal(result.snapshot.phase, 'published');
});

test('prepare never performs publish and invalid phase fails closed', async () => {
  let publishCalls = 0;
  const result = await runReleaseAction({ version: '1.2.3', action: 'prepare', inspect: async () => facts({ localTag: true }), publish: async () => { publishCalls += 1; } });
  assert.equal(result.status, 'failed');
  assert.equal(publishCalls, 0);
});
