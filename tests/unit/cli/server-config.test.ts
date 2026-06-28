import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadServerConfig,
  validateServerConfig,
  DEFAULT_SERVER_CONFIG
} from '../../../lib/server/config.ts';

function makeRepo(serverJson?: unknown, localJson?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-config-'));
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  if (serverJson !== undefined) {
    fs.writeFileSync(path.join(dir, '.agents', 'server.json'), JSON.stringify(serverJson));
  }
  if (localJson !== undefined) {
    fs.writeFileSync(path.join(dir, '.agents', 'server.local.json'), JSON.stringify(localJson));
  }
  return dir;
}

test('loadServerConfig returns defaults when no server.json exists', () => {
  const dir = makeRepo();
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.repoRoot, dir);
    assert.equal(config.heartbeatMs, DEFAULT_SERVER_CONFIG.heartbeatMs);
    assert.equal(config.log.rotateAtBytes, DEFAULT_SERVER_CONFIG.log.rotateAtBytes);
    assert.deepEqual(config.adapters, {});
    // default log path is resolved to an absolute path under the repo root
    assert.equal(config.log.path, path.join(dir, '.agents', 'server.log'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server.json deep-merges over defaults without dropping sibling defaults', () => {
  const dir = makeRepo({ log: { rotateAtBytes: 1024 }, adapters: { dev: { enabled: false } } });
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.log.rotateAtBytes, 1024);
    // log.path is untouched by server.json → default preserved (deep merge, not replace)
    assert.equal(config.log.path, path.join(dir, '.agents', 'server.log'));
    assert.deepEqual(config.adapters, { dev: { enabled: false } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server.local.json overrides server.json by deep merge', () => {
  const dir = makeRepo(
    { adapters: { dev: { enabled: false, appId: 'cli_xxx' } } },
    { adapters: { dev: { enabled: true } } }
  );
  try {
    const config = loadServerConfig({ rootDir: dir });
    // local flips enabled but keeps appId from server.json (deep merge)
    assert.deepEqual(config.adapters.dev, { enabled: true, appId: 'cli_xxx' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('environment variables take highest precedence over both files', () => {
  const dir = makeRepo({ heartbeatMs: 5000 });
  const key = 'AGENT_INFRA_SERVER_heartbeatMs';
  const previous = process.env[key];
  process.env[key] = '777';
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.heartbeatMs, 777);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nested env override builds the path and coerces booleans', () => {
  const dir = makeRepo({ adapters: { dev: { enabled: true } } });
  const key = 'AGENT_INFRA_SERVER_adapters__dev__enabled';
  const previous = process.env[key];
  process.env[key] = 'false';
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.adapters.dev?.enabled, false);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('committed secret in server.json is rejected at load time', () => {
  const dir = makeRepo({ adapters: { feishu: { enabled: true, appSecret: 'leaked-xxx' } } });
  try {
    assert.throws(
      () => loadServerConfig({ rootDir: dir }),
      /secret-like field\(s\) found in committed .agents\/server\.json: adapters\.feishu\.appSecret/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateServerConfig reports the offending secret field paths', () => {
  const result = validateServerConfig({
    adapters: { feishu: { enabled: true, appSecret: 'x' } },
    token: 'y'
  });
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.deepEqual(result.fields.sort(), ['adapters.feishu.appSecret', 'token']);
  }
});

test('secrets in server.local.json are allowed (not scanned)', () => {
  const dir = makeRepo(
    { adapters: { feishu: { enabled: true } } },
    { adapters: { feishu: { appSecret: 'kept-secret' } } }
  );
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.adapters.feishu?.appSecret, 'kept-secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty secret-like fields in server.json do not trigger rejection', () => {
  const result = validateServerConfig({ adapters: { feishu: { enabled: true, appSecret: '' } } });
  assert.equal(result.ok, true);
});
