import type { OnMessage, RunFns, SandboxAdapter } from './index.ts';

function ensureWslAvailable(runOk: RunFns['runOk']): void {
  if (runOk('wsl.exe', ['--status']) || runOk('wsl.exe', ['--', 'true'])) {
    return;
  }

  throw new Error([
    'WSL2 is required for Windows sandbox support.',
    'Install WSL2, configure a default Linux distribution, and re-run "ai sandbox create".'
  ].join('\n'));
}

function ensureDockerAvailable(runOk: RunFns['runOk']): void {
  if (runOk('wsl.exe', ['--', 'docker', 'info'])) {
    return;
  }

  throw new Error([
    'Docker is not available inside WSL2.',
    'Start Docker Desktop and enable WSL integration for your default distribution.'
  ].join('\n'));
}

function wsl2BackendCheck(runOk: RunFns['runOk'], onMessage: OnMessage): void {
  ensureWslAvailable(runOk);
  onMessage?.('Checking Docker Desktop from WSL2...');
  ensureDockerAvailable(runOk);
}

export const wsl2Adapter: SandboxAdapter = {
  id: 'wsl2',
  displayName: 'WSL2',
  supportedPlatforms: ['win32'],
  dockerContext: null,
  managed: true,
  canApplyResources: 'never',

  defaultResources() {
    return null;
  },

  async ensure(config, onMessage: OnMessage, { runOk }) {
    wsl2BackendCheck(runOk, onMessage);
    void config;
    return false;
  },

  startVm(config, onMessage: OnMessage, { runOk }) {
    wsl2BackendCheck(runOk, onMessage);
    void config;
    return 'already-running';
  },

  stopVm() {
    throw new Error(
      'Windows uses Docker Desktop with WSL2. Stop it from Docker Desktop or run "wsl --shutdown" manually.'
    );
  },

  syncResources(config, onMessage: OnMessage) {
    if (!config.hasUserVmConfig?.(config.userVm)) {
      return;
    }

    onMessage?.(
      'Warning: Docker Desktop manages CPU/memory/disk via Settings -> Resources. '
      + 'sandbox.vm.* values and --cpu/--memory flags are not applied for this engine. '
      + 'Please configure resources in Docker Desktop GUI to match.'
    );
  }
};

export default wsl2Adapter;
