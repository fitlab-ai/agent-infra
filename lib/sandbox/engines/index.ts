import { colimaAdapter } from './colima.ts';
import { dockerDesktopAdapter } from './docker-desktop.ts';
import { nativeAdapter } from './native.ts';
import { orbstackAdapter } from './orbstack.ts';
import { wsl2Adapter } from './wsl2.ts';

type SandboxAdapter = {
  id: string;
  displayName: string;
  supportedPlatforms: string[];
  dockerContext: string | null;
  managed: boolean;
  canApplyResources: string;
};

export const ADAPTERS = Object.freeze({
  colima: colimaAdapter,
  orbstack: orbstackAdapter,
  'docker-desktop': dockerDesktopAdapter,
  native: nativeAdapter,
  wsl2: wsl2Adapter
});

type SandboxEngineId = keyof typeof ADAPTERS;

export function getAdapter(engineId: string): SandboxAdapter {
  const adapter = ADAPTERS[engineId as SandboxEngineId];
  if (!adapter) {
    throw new Error(`No adapter registered for engine '${engineId}'`);
  }
  return adapter;
}

export function enginesForPlatform(platformName: string): string[] {
  return Object.values(ADAPTERS)
    .filter((adapter) => adapter.supportedPlatforms.includes(platformName))
    .map((adapter) => adapter.id);
}
