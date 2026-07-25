import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBuildProxyCompatibility,
  prepareBuildProxy,
  redactBuildProxyValues
} from '../../../lib/sandbox/build-proxy.ts';

test('prepareBuildProxy passes names in argv and values only in the child environment', () => {
  const plan = prepareBuildProxy(true, {
    HTTP_PROXY: 'http://user:secret@proxy.test:8080',
    HTTPS_PROXY: 'https://proxy.test:8443',
    NO_PROXY: 'localhost',
    WSLENV: 'PATH/l:HTTP_PROXY'
  }, 'wsl2');

  assert.deepEqual(plan.args, [
    '--secret', 'id=HTTP_PROXY,env=HTTP_PROXY',
    '--secret', 'id=HTTPS_PROXY,env=HTTPS_PROXY',
    '--secret', 'id=NO_PROXY,env=NO_PROXY'
  ]);
  assert.equal(plan.env.HTTP_PROXY, 'http://user:secret@proxy.test:8080');
  assert.equal(plan.env.WSLENV, 'PATH/l:HTTP_PROXY:HTTPS_PROXY:NO_PROXY');
  assert.ok(!plan.args.join(' ').includes('canary-password'));
});

test('prepareBuildProxy is inert when disabled and rejects an empty enabled input', () => {
  const hostEnv = { HTTP_PROXY: 'secret' };
  const disabled = prepareBuildProxy(false, hostEnv, 'native');
  assert.deepEqual(disabled.args, []);
  assert.deepEqual(disabled.redactionValues, []);
  assert.notEqual(disabled.env, hostEnv);
  assert.throws(
    () => prepareBuildProxy(true, {}, 'native'),
    /No non-empty build proxy variables/
  );
});

test('assertBuildProxyCompatibility accepts boundary versions and rejects any old builder node', () => {
  const calls: string[][] = [];
  assert.doesNotThrow(() => assertBuildProxyCompatibility('native', (_engine, _cmd, args) => {
    calls.push(args);
    return args[0] === 'version'
      ? '20.10.0'
      : 'Name: node0\nBuildKit: v0.9.0\nName: node1\nBuildKit: v0.12.5';
  }));
  assert.deepEqual(calls, [
    ['version', '--format', '{{.Server.Version}}'],
    ['buildx', 'inspect', '--bootstrap']
  ]);

  assert.throws(
    () => assertBuildProxyCompatibility('native', (_engine, _cmd, args) =>
      args[0] === 'version' ? '26.1.0' : 'BuildKit: v0.8.3'
    ),
    /BuildKit 0\.8\.3.*0\.9\.0/s
  );
});

test('assertBuildProxyCompatibility accepts OrbStack BuildKit version output', () => {
  assert.doesNotThrow(() => assertBuildProxyCompatibility('orbstack', (_engine, _cmd, args) =>
    args[0] === 'version' ? '26.1.0' : 'BuildKit version: v0.29.0'
  ));
});

test('redactBuildProxyValues replaces longer secrets first', () => {
  assert.equal(
    redactBuildProxyValues('https://user:secret@proxy.test secret', ['secret', 'https://user:secret@proxy.test']),
    '[REDACTED_BUILD_PROXY] [REDACTED_BUILD_PROXY]'
  );
});
