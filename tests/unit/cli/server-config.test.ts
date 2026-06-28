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
    // default log + pid live OUTSIDE the repo, under
    // ~/.agent-infra/{logs,run}/<project>/<repo-hash>/. No .airc.json here → the
    // project key falls back to the repo directory name. The exact repo-hash
    // segment is implementation detail, so assert structurally.
    const logBase = path.join(os.homedir(), '.agent-infra', 'logs', path.basename(dir));
    const runBase = path.join(os.homedir(), '.agent-infra', 'run', path.basename(dir));
    assert.ok(config.log.path.startsWith(logBase + path.sep), config.log.path);
    assert.ok(config.log.path.endsWith(`${path.sep}server.log`), config.log.path);
    assert.ok(config.pidFile.startsWith(runBase + path.sep), config.pidFile);
    assert.ok(config.pidFile.endsWith(`${path.sep}server.pid`), config.pidFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server.json deep-merges rotateAtBytes while log.path keeps the home default', () => {
  const dir = makeRepo({ log: { rotateAtBytes: 1024 }, adapters: { dev: { enabled: false } } });
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.log.rotateAtBytes, 1024);
    // log.path not set in server.json → still defaults under the home dir (deep merge, not dropped)
    const logBase = path.join(os.homedir(), '.agent-infra', 'logs', path.basename(dir));
    assert.ok(config.log.path.startsWith(logBase + path.sep), config.log.path);
    assert.ok(config.log.path.endsWith(`${path.sep}server.log`), config.log.path);
    assert.deepEqual(config.adapters, { dev: { enabled: false } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default runtime directory is keyed by the .airc.json project', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.agents', '.airc.json'), JSON.stringify({ project: 'myproj' }));
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.ok(
      config.log.path.startsWith(path.join(os.homedir(), '.agent-infra', 'logs', 'myproj') + path.sep),
      config.log.path
    );
    assert.ok(
      config.pidFile.startsWith(path.join(os.homedir(), '.agent-infra', 'run', 'myproj') + path.sep),
      config.pidFile
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two checkouts sharing a project get isolated runtime paths (repo-hash)', () => {
  // CD-2: same .airc.json project, different repo roots → must NOT share PID/log.
  const a = makeRepo();
  const b = makeRepo();
  fs.writeFileSync(path.join(a, '.agents', '.airc.json'), JSON.stringify({ project: 'shared' }));
  fs.writeFileSync(path.join(b, '.agents', '.airc.json'), JSON.stringify({ project: 'shared' }));
  try {
    const ca = loadServerConfig({ rootDir: a });
    const cb = loadServerConfig({ rootDir: b });
    assert.notEqual(ca.pidFile, cb.pidFile, 'pid files must differ between checkouts');
    assert.notEqual(ca.log.path, cb.log.path, 'log paths must differ between checkouts');
    // both still grouped under the shared project directory
    const sharedRun = path.join(os.homedir(), '.agent-infra', 'run', 'shared') + path.sep;
    assert.ok(ca.pidFile.startsWith(sharedRun) && cb.pidFile.startsWith(sharedRun));
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('an explicit relative log.path resolves against the repo root', () => {
  const dir = makeRepo({ log: { path: '.agents/server.log' } });
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.log.path, path.join(dir, '.agents', 'server.log'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit absolute log.path is used as-is', () => {
  const abs = path.join(os.tmpdir(), 'server-abs-log', 'daemon.log');
  const dir = makeRepo({ log: { path: abs } });
  try {
    const config = loadServerConfig({ rootDir: dir });
    assert.equal(config.log.path, abs);
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
