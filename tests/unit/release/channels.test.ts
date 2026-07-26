import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectHomebrewChannel, inspectNpmChannel } from '../../../lib/release/channels.ts';

test('npm inspector distinguishes published, missing, and blocked', async () => {
  assert.equal((await inspectNpmChannel('pkg', '1.0.0', async () => ({ ok: true, status: 200, json: async () => ({ version: '1.0.0' }), text: async () => '' }))).published, true);
  assert.equal((await inspectNpmChannel('pkg', '1.0.0', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }))).published, false);
  assert.equal((await inspectNpmChannel('pkg', '1.0.0', async () => { throw new Error('offline'); })).status, 'blocked');
});

test('Homebrew inspector requires the target npm tarball and a bottle block', async () => {
  const inspect = (formula: string) => inspectHomebrewChannel(
    'https://example/formula.rb',
    '1.2.3',
    async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => formula })
  );
  assert.equal((await inspect(`
    url "https://registry.npmjs.org/@acme/widgets/-/widgets-1.2.3.tgz"
    bottle do
    end
  `)).published, true);
  assert.equal((await inspect('version "1.2.3"')).published, false);
  assert.equal((await inspect(`
    url "https://registry.npmjs.org/@acme/widgets/-/widgets-1.2.2.tgz"
    bottle do
    end
  `)).published, false);
  assert.equal((await inspect(`
    url "https://registry.npmjs.org/@acme/widgets/-/widgets-1.2.3.tgz"
    # bottle do
  `)).published, false);
});

test('Homebrew inspector preserves missing and blocked channel states', async () => {
  assert.equal((await inspectHomebrewChannel('x', '1.2.3', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }))).published, false);
  assert.equal((await inspectHomebrewChannel('x', '1.2.3', async () => { throw new Error('offline'); })).published, null);
});
