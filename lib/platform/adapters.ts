import type { PlatformResult } from './types.ts';

type PlatformAdapterContext = {
  cwd: string;
  gitRemote?: (cwd: string) => string | null;
  client?: unknown;
};

type PlatformAdapter = {
  type: string;
  resolveContext(context: PlatformAdapterContext): PlatformResult;
};

const adapters = new Map<string, PlatformAdapter>();

function registerPlatformAdapter(adapter: PlatformAdapter): void {
  if (!adapter.type.trim()) throw new Error('Platform adapter type is required');
  adapters.set(adapter.type, adapter);
}

function getPlatformAdapter(type: string | null): PlatformAdapter | null {
  return type ? adapters.get(type) ?? null : null;
}

function listPlatformAdapters(): string[] {
  return [...adapters.keys()].sort();
}

export { getPlatformAdapter, listPlatformAdapters, registerPlatformAdapter };
export type { PlatformAdapter, PlatformAdapterContext };
