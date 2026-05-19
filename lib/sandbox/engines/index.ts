// @ts-nocheck
import { colimaAdapter } from './colima.ts';
import { dockerDesktopAdapter } from './docker-desktop.ts';
import { nativeAdapter } from './native.ts';
import { orbstackAdapter } from './orbstack.ts';
import { wsl2Adapter } from './wsl2.ts';

export const ADAPTERS = Object.freeze({
  colima: colimaAdapter,
  orbstack: orbstackAdapter,
  'docker-desktop': dockerDesktopAdapter,
  native: nativeAdapter,
  wsl2: wsl2Adapter
});

export function getAdapter(engineId) {
  const adapter = ADAPTERS[engineId];
  if (!adapter) {
    throw new Error(`No adapter registered for engine '${engineId}'`);
  }
  return adapter;
}

export function enginesForPlatform(platformName) {
  return Object.values(ADAPTERS)
    .filter((adapter) => adapter.supportedPlatforms.includes(platformName))
    .map((adapter) => adapter.id);
}
