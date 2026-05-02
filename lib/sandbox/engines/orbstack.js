export const orbstackAdapter = {
  id: 'orbstack',
  displayName: 'OrbStack',
  dockerContext: 'orbstack',
  managed: true,
  canApplyResources: 'hot',

  defaultResources() {
    return null;
  },

  async ensure(_config, onMessage, { runOk, runVerbose }) {
    let started = false;

    if (!runOk('which', ['orb'])) {
      onMessage?.('Installing OrbStack via Homebrew...');
      runVerbose('brew', ['install', '--cask', 'orbstack']);
    }

    if (!runOk('docker', ['info'])) {
      onMessage?.('Starting OrbStack...');
      runVerbose('orb', ['start']);
      started = true;
    }

    if (!runOk('docker', ['info'])) {
      throw new Error('Docker daemon is not available after starting OrbStack');
    }

    return started;
  },

  startVm(_config, _onMessage, { runOk, runVerbose }) {
    if (runOk('orb', ['status'])) {
      return 'already-running';
    }

    runVerbose('orb', ['start']);
    return 'started';
  },

  stopVm(_config, _onMessage, { run }) {
    run('orb', ['stop']);
    return 'stopped';
  },

  syncResources(config, onMessage, { runVerbose }) {
    const vm = config?.vm ?? {};

    if (vm.cpu != null) {
      try {
        runVerbose('orb', ['config', 'set', 'cpu', String(vm.cpu)]);
      } catch {
        onMessage?.(`Warning: failed to apply OrbStack cpu=${vm.cpu}; resource limit may not take effect.`);
      }
    }

    if (vm.memory != null) {
      try {
        runVerbose('orb', ['config', 'set', 'memory_mib', String(vm.memory * 1024)]);
      } catch {
        onMessage?.(`Warning: failed to apply OrbStack memory=${vm.memory}GiB; resource limit may not take effect.`);
      }
    }

    if (vm.disk != null) {
      onMessage?.(
        `Warning: OrbStack does not expose a fixed disk size; sandbox.vm.disk=${vm.disk} is ignored. `
        + 'Manage storage via OrbStack settings GUI.'
      );
    }
  }
};

export default orbstackAdapter;
