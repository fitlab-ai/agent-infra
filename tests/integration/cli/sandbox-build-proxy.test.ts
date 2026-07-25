import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareBuildProxy } from '../../../lib/sandbox/build-proxy.ts';
import { buildSandboxImageArgs } from '../../../lib/sandbox/image-build.ts';

test('sandbox image build argv contains proxy names but never proxy values', () => {
  const canary = 'http://user:canary-password@proxy.invalid:8080';
  const proxy = prepareBuildProxy(true, { HTTP_PROXY: canary }, 'native');
  const args = buildSandboxImageArgs({
    project: 'demo',
    imageName: 'demo-sandbox',
    repoRoot: '/repo',
    engine: 'native'
  }, [], '/tmp/Dockerfile', 'signature', {
    engine: 'native',
    runFn: () => '1000',
    runSafeFn: () => '',
    buildProxyArgs: proxy.args
  });

  assert.deepEqual(args.slice(args.indexOf('--secret', 10), args.indexOf('-f')), [
    '--secret', 'id=HTTP_PROXY,env=HTTP_PROXY'
  ]);
  assert.ok(!args.join('\0').includes(canary));
  assert.equal(proxy.env.HTTP_PROXY, canary);
});
