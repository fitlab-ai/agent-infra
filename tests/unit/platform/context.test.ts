import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listPlatformAdapters, registerPlatformAdapter } from '../../../lib/platform/adapters.ts';
import { parseGitHubRemote, resolvePlatformContext } from '../../../lib/platform/context.ts';
import { platformResult } from '../../../lib/platform/types.ts';

test('GitHub remote parser accepts HTTPS and SCP-like remotes', () => {
  assert.equal(parseGitHubRemote('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(parseGitHubRemote('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(parseGitHubRemote('ssh://git@github.com/acme/widgets'), 'acme/widgets');
  assert.equal(parseGitHubRemote('https://gitlab.com/acme/widgets.git'), null);
});

test('platform context resolves fork parent and separated capabilities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-context-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  const requested: string[] = [];
  const result = resolvePlatformContext({
    cwd: root,
    gitRemote: () => 'git@github.com:contributor/widgets.git',
    client: {
      version() { return { ok: true, value: '2.16.0' }; },
      json(args) {
        requested.push(args.join(' '));
        if (args[1] === 'graphql') {
          return { ok: true, value: { data: { viewer: { login: 'contributor' } } } };
        }
        if (args.at(-1) === 'repos/contributor/widgets') {
          return { ok: true, value: { fork: true, parent: { full_name: 'acme/widgets' } } };
        }
        return { ok: true, value: { permissions: { pull: true, triage: true, push: false, admin: false } } };
      }
    }
  });
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.platform, {
    type: 'github', repository: 'acme/widgets', currentUser: 'contributor'
  });
  assert.deepEqual(result.capabilities, {
    authenticated: true, comment: true, triage: true, push: false, admin: false
  });
  assert.ok(requested.some((entry) => entry.endsWith('repos/acme/widgets')));
  assert.ok(requested.some((entry) => entry.startsWith('api graphql ')));
});

test('platform context reports a fully resolved read-only probe as no-op', () => {
  const result = resolvePlatformContext({
    cwd: process.cwd(),
    platformType: 'github',
    gitRemote: () => 'https://github.com/acme/widgets.git',
    client: {
      version() { return { ok: true, value: '2.16.0' }; },
      json(args) {
        if (args[1] === 'graphql') {
          return { ok: true, value: { data: { viewer: { login: 'maintainer' } } } };
        }
        if (args.at(-1) === 'repos/acme/widgets') {
          return { ok: true, value: {
            full_name: 'acme/widgets', permissions: { triage: true, push: true, admin: true }
          } };
        }
        throw new Error(`unexpected request: ${args.join(' ')}`);
      }
    }
  });
  assert.equal(result.status, 'no-op');
  assert.equal(result.changed, false);
  assert.equal(result.error, null);
});

test('GitHub platform rejects unsupported gh versions before API access', () => {
  let apiCalls = 0;
  const result = resolvePlatformContext({
    cwd: process.cwd(),
    platformType: 'github',
    gitRemote: () => 'https://github.com/acme/widgets.git',
    client: {
      version() { return { ok: true, value: '2.15.0' }; },
      json() {
        apiCalls += 1;
        return { ok: true, value: null };
      }
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'GH_CLI_VERSION_UNSUPPORTED');
  assert.equal(apiCalls, 0);
});

test('non-GitHub platform does not probe gh', () => {
  let versionCalls = 0;
  const result = resolvePlatformContext({
    cwd: process.cwd(),
    platformType: 'custom',
    client: {
      version() {
        versionCalls += 1;
        return { ok: true, value: '2.16.0' };
      },
      json() { throw new Error('GitHub API must not be called'); }
    }
  });
  assert.equal(result.error?.code, 'PLATFORM_UNSUPPORTED');
  assert.equal(versionCalls, 0);
});

test('platform context returns observable no-op for unsupported platform and missing remote', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-context-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"custom"}}');
  assert.equal(resolvePlatformContext({ cwd: root }).error?.code, 'PLATFORM_UNSUPPORTED');

  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  const missing = resolvePlatformContext({ cwd: root, gitRemote: () => null });
  assert.equal(missing.status, 'no-op');
  assert.equal(missing.error?.code, 'REMOTE_MISSING');
});

test('platform context dispatches registered typed adapters without probing GitHub', () => {
  registerPlatformAdapter({
    type: 'gitlab-test',
    resolveContext({ cwd }) {
      return platformResult('no-op', {
        platform: { type: 'gitlab-test', repository: `acme/${path.basename(cwd)}`, currentUser: 'tester' }
      });
    }
  });
  const result = resolvePlatformContext({ cwd: '/tmp/widgets', platformType: 'gitlab-test' });
  assert.equal(result.platform.type, 'gitlab-test');
  assert.equal(result.platform.repository, 'acme/widgets');
  assert.ok(listPlatformAdapters().includes('github'));
  assert.ok(listPlatformAdapters().includes('gitlab-test'));
});

test('none platform resolves through the built-in no-op strategy without probing GitHub', () => {
  const result = resolvePlatformContext({
    cwd: '/tmp/widgets',
    platformType: 'none',
    client: {
      version() {
        throw new Error('GitHub client must not be probed');
      },
      json() {
        throw new Error('GitHub client must not be probed');
      }
    }
  });
  assert.equal(result.status, 'no-op');
  assert.equal(result.platform.type, 'none');
  assert.equal(result.platform.repository, null);
  assert.deepEqual(result.operations, [{
    name: 'resolve', status: 'no-op', reasonCode: 'PLATFORM_DISABLED'
  }]);
});
