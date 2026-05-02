export const dockerDesktopAdapter = {
  id: 'docker-desktop',
  displayName: 'Docker Desktop',
  dockerContext: 'desktop-linux',
  managed: false,
  canApplyResources: 'never',

  defaultResources() {
    return null;
  },

  async ensure(_config, _onMessage, { runOk }) {
    if (!runOk('docker', ['info'])) {
      throw new Error('Docker Desktop is not running. Please start Docker Desktop manually.');
    }

    return false;
  },

  syncResources(config, onMessage) {
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

export default dockerDesktopAdapter;
