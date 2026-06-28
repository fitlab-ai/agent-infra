import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAdapters, unloadAdapters } from '../../../lib/server/plugin-loader.ts';
import type { ImportAdapter } from '../../../lib/server/plugin-loader.ts';
import type { ServerConfig, ServerAdapterConfig } from '../../../lib/server/config.ts';
import type { Adapter, AdapterCtx } from '../../../lib/server/adapters/_contract.ts';

function makeConfig(adapters: Record<string, ServerAdapterConfig>): ServerConfig {
  return {
    repoRoot: '/tmp/none',
    pidFile: '/tmp/none/.agent-infra/run/none/server.pid',
    log: { path: '/tmp/none/.agent-infra/logs/none/server.log', rotateAtBytes: 1024 },
    heartbeatMs: 30_000,
    adapters
  };
}

function makeCtx(): { ctx: AdapterCtx; errors: string[] } {
  const errors: string[] = [];
  const ctx: AdapterCtx = {
    config: makeConfig({}),
    logger: {
      info: () => {},
      ok: () => {},
      err: (message: string) => errors.push(message),
      close: () => {}
    },
    dispatch: async () => {},
    signal: new AbortController().signal
  };
  return { ctx, errors };
}

// A fake adapter whose lifecycle calls are recorded, returned as a module
// with a default factory — exactly what the production importer would yield,
// but resolved entirely in memory (never written under lib/server/adapters/).
function fakeAdapterModule(name: string, calls: string[]): { default: () => Adapter } {
  return {
    default: () => ({
      name,
      start: async () => {
        calls.push(`start:${name}`);
      },
      stop: async () => {
        calls.push(`stop:${name}`);
      },
      sendMessage: async () => {}
    })
  };
}

test('enabled adapter is loaded and started with the daemon ctx', async () => {
  const calls: string[] = [];
  const { ctx } = makeCtx();
  const importAdapter: ImportAdapter = async (name) => fakeAdapterModule(name, calls);

  const loaded = await loadAdapters(makeConfig({ dev: { enabled: true } }), ctx, { importAdapter });

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.name, 'dev');
  assert.deepEqual(calls, ['start:dev']);
});

test('disabled adapter is never imported', async () => {
  const imported: string[] = [];
  const { ctx } = makeCtx();
  const importAdapter: ImportAdapter = async (name) => {
    imported.push(name);
    return fakeAdapterModule(name, []);
  };

  const loaded = await loadAdapters(makeConfig({ dev: { enabled: false } }), ctx, { importAdapter });

  assert.deepEqual(loaded, []);
  assert.deepEqual(imported, [], 'importAdapter must not be called for disabled adapters');
});

test('an import failure is isolated and does not block other adapters', async () => {
  const calls: string[] = [];
  const { ctx, errors } = makeCtx();
  const importAdapter: ImportAdapter = async (name) => {
    if (name === 'broken') throw new Error('module blew up');
    return fakeAdapterModule(name, calls);
  };

  const loaded = await loadAdapters(
    makeConfig({ broken: { enabled: true }, dev: { enabled: true } }),
    ctx,
    { importAdapter }
  );

  assert.deepEqual(loaded.map((a) => a.name), ['dev']);
  assert.deepEqual(calls, ['start:dev']);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /failed to load adapter "broken": module blew up/);
});

test('a start() failure is isolated and does not block other adapters', async () => {
  const { ctx, errors } = makeCtx();
  const importAdapter: ImportAdapter = async (name) => {
    if (name === 'bad-start') {
      return {
        default: () => ({
          name,
          start: async () => {
            throw new Error('start refused');
          },
          stop: async () => {},
          sendMessage: async () => {}
        })
      };
    }
    return fakeAdapterModule(name, []);
  };

  const loaded = await loadAdapters(
    makeConfig({ 'bad-start': { enabled: true }, dev: { enabled: true } }),
    ctx,
    { importAdapter }
  );

  assert.deepEqual(loaded.map((a) => a.name), ['dev']);
  assert.match(errors[0] ?? '', /failed to load adapter "bad-start": start refused/);
});

test('a module without a default factory is rejected and isolated', async () => {
  const { ctx, errors } = makeCtx();
  const importAdapter: ImportAdapter = async () => ({ notDefault: true });

  const loaded = await loadAdapters(makeConfig({ dev: { enabled: true } }), ctx, { importAdapter });

  assert.deepEqual(loaded, []);
  assert.match(errors[0] ?? '', /adapter "dev" has no default export factory/);
});

test('unloadAdapters stops adapters in reverse load order', async () => {
  const calls: string[] = [];
  const { ctx } = makeCtx();
  const importAdapter: ImportAdapter = async (name) => fakeAdapterModule(name, calls);

  const loaded = await loadAdapters(
    makeConfig({ first: { enabled: true }, second: { enabled: true } }),
    ctx,
    { importAdapter }
  );
  await unloadAdapters(loaded);

  assert.deepEqual(calls, ['start:first', 'start:second', 'stop:second', 'stop:first']);
});
