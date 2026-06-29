import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerConfig } from './config.ts';
import type { Adapter, AdapterCtx } from './adapters/_contract.ts';

export type ImportAdapter = (name: string) => Promise<unknown>;

export type LoadAdaptersOptions = {
  // Test seam: override how an adapter module is resolved so enabled-adapter
  // loading can be exercised without writing a fake adapter into the source
  // tree. Production resolves `./adapters/<name>/index.ts`.
  importAdapter?: ImportAdapter;
};

const defaultImportAdapter: ImportAdapter = (name) => {
  // Test-only seam: when AGENT_INFRA_SERVER_TEST_ADAPTERS_DIR is set (never in
  // production), resolve the named adapter as a plain ESM `.js` from that
  // fixtures dir. This lets a built daemon (`node dist/bin/cli.js`) load a test
  // injection adapter on any node>=22 without depending on type stripping.
  const testDir = process.env.AGENT_INFRA_SERVER_TEST_ADAPTERS_DIR;
  if (testDir) {
    return import(pathToFileURL(path.join(testDir, name, 'index.js')).href);
  }
  return import(`./adapters/${name}/index.ts`);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdapter(value: unknown): value is Adapter {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.start === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.sendMessage === 'function'
  );
}

// Load every adapter whose config has `enabled === true`. Each adapter is
// loaded, instantiated and started in isolation: a failure in one adapter is
// logged and skipped so it never blocks the others.
export async function loadAdapters(
  config: ServerConfig,
  ctx: AdapterCtx,
  options: LoadAdaptersOptions = {}
): Promise<Adapter[]> {
  const importAdapter = options.importAdapter ?? defaultImportAdapter;
  const loaded: Adapter[] = [];

  for (const [name, adapterConfig] of Object.entries(config.adapters)) {
    if (adapterConfig?.enabled !== true) continue;
    try {
      const mod = (await importAdapter(name)) as { default?: unknown };
      const factory = mod?.default;
      if (typeof factory !== 'function') {
        throw new Error(`adapter "${name}" has no default export factory`);
      }
      const instance: unknown = factory(adapterConfig);
      if (!isAdapter(instance)) {
        throw new Error(`adapter "${name}" does not satisfy the Adapter contract`);
      }
      await instance.start(ctx);
      loaded.push(instance);
    } catch (error) {
      ctx.logger.err(`failed to load adapter "${name}": ${errorMessage(error)}`);
    }
  }

  return loaded;
}

// Stop adapters in reverse load order, isolating per-adapter stop failures.
export async function unloadAdapters(adapters: Adapter[]): Promise<void> {
  for (const adapter of [...adapters].reverse()) {
    try {
      await adapter.stop();
    } catch {
      // A failing stop must not block the rest of shutdown.
    }
  }
}
