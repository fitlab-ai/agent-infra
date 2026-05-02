import { colimaAdapter } from './colima.js';
import { dockerDesktopAdapter } from './docker-desktop.js';
import { nativeAdapter } from './native.js';
import { orbstackAdapter } from './orbstack.js';
import { wsl2Adapter } from './wsl2.js';

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
