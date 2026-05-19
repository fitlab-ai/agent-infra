import { colimaAdapter } from './colima.ts';
import { dockerDesktopAdapter } from './docker-desktop.ts';
import { nativeAdapter } from './native.ts';
import { orbstackAdapter } from './orbstack.ts';
import { wsl2Adapter } from './wsl2.ts';

export type SandboxVmConfig = {
  cpu?: number | null;
  memory?: number | null;
  disk?: number | null;
};

export type EffectiveSandboxConfig = {
  vm?: SandboxVmConfig;
  userVm?: SandboxVmConfig;
  hasUserVmConfig?: (vm?: SandboxVmConfig) => boolean;
};

export type HostResources = {
  cpu: number;
  memory: number;
};

export type RunFns = {
  run: (cmd: string, args: string[]) => string;
  runOk: (cmd: string, args: string[]) => boolean;
  runSafe: (cmd: string, args: string[]) => string;
  runVerbose: (cmd: string, args: string[]) => void;
};

export type OnMessage = ((message: string) => void) | undefined | null;

export type SandboxAdapter = {
  id: string;
  displayName: string;
  supportedPlatforms: string[];
  dockerContext: string | null;
  managed: boolean;
  canApplyResources: string;
  defaultResources: (getHost: () => HostResources) => SandboxVmConfig | null;
  ensure: (config: EffectiveSandboxConfig, onMessage: OnMessage, runFns: RunFns) => Promise<boolean>;
  startVm?: (config: EffectiveSandboxConfig, onMessage: OnMessage, runFns: RunFns) => 'already-running' | 'started';
  stopVm?: (config: EffectiveSandboxConfig, onMessage: OnMessage, runFns: Pick<RunFns, 'run'>) => 'stopped';
  syncResources: (
    config: EffectiveSandboxConfig,
    onMessage: OnMessage,
    runFns: RunFns,
    options?: { vmJustStarted?: boolean }
  ) => void;
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
