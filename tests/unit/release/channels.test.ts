import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectHomebrewChannel, inspectNpmChannel } from '../../../lib/release/channels.ts';

test('npm inspector distinguishes published, missing, and blocked', async () => {
  assert.equal((await inspectNpmChannel('pkg', '1.0.0', async () => ({ ok: true, status: 200, json: async () => ({ version: '1.0.0' }), text: async () => '' }))).published, true);
  assert.equal((await inspectNpmChannel('pkg', '1.0.0', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }))).published, false);
  assert.equal((await inspectNpmChannel('pkg', '1.0.0', async () => { throw new Error('offline'); })).status, 'blocked');
});

test('Homebrew inspector matches version facts and blocks unknown network state', async () => {
  const present = await inspectHomebrewChannel('https://example/formula.rb', '1.2.3', async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => 'version "1.2.3"' }));
  assert.equal(present.published, true);
  assert.equal((await inspectHomebrewChannel('x', '1.2.3', async () => { throw new Error('offline'); })).published, null);
});
