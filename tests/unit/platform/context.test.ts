import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseGitHubRemote, resolvePlatformContext } from '../../../lib/platform/context.ts';

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
      json(args) {
        requested.push(args.join(' '));
        if (args.at(-1) === 'repos/contributor/widgets') {
          return { ok: true, value: { fork: true, parent: { full_name: 'acme/widgets' } } };
        }
        if (args.at(-1) === 'user') return { ok: true, value: { login: 'contributor' } };
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
});

test('platform context reports a fully resolved read-only probe as no-op', () => {
  const result = resolvePlatformContext({
    cwd: process.cwd(),
    platformType: 'github',
    gitRemote: () => 'https://github.com/acme/widgets.git',
    client: {
      json(args) {
        if (args.at(-1) === 'user') return { ok: true, value: { login: 'maintainer' } };
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
