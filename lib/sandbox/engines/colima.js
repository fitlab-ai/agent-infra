function colimaArgs(config, runSafeFn) {
  const arch = runSafeFn('uname', ['-m']);
  const vm = config.vm ?? {};
  const args = ['start', '--cpu', String(vm.cpu), '--memory', String(vm.memory), '--disk', String(vm.disk)];

  if (arch === 'arm64') {
    args.push('--arch', 'aarch64', '--vm-type=vz', '--mount-type=virtiofs');
  } else {
    args.push('--arch', 'x86_64');
  }

  return args;
}

export const colimaAdapter = {
  id: 'colima',
  displayName: 'Colima',
  dockerContext: 'colima',
  managed: true,
  canApplyResources: 'on-start',

  defaultResources(getHost) {
    const host = getHost();
    return {
      cpu: host.cpu,
      memory: host.memory,
      disk: 60
    };
  },

  async ensure(config, onMessage, { runOk, runSafe, runVerbose }) {
    let started = false;

    if (!runOk('which', ['colima'])) {
      onMessage?.('Installing colima + docker via Homebrew...');
      runVerbose('brew', ['install', 'colima', 'docker']);
    }

    if (!runOk('colima', ['status'])) {
      onMessage?.('Starting Colima VM...');
      runVerbose('colima', colimaArgs(config, runSafe));
      started = true;
    }

    if (!runOk('docker', ['info'])) {
      throw new Error('Docker daemon is not available after starting Colima');
    }

    return started;
  },

  startVm(config, _onMessage, { runOk, runSafe, runVerbose }) {
    if (runOk('colima', ['status'])) {
      return 'already-running';
    }

    runVerbose('colima', colimaArgs(config, runSafe));
    return 'started';
  },

  stopVm(_config, _onMessage, { run }) {
    run('colima', ['stop']);
    return 'stopped';
  },

  syncResources(config, onMessage, _runFns, { vmJustStarted } = {}) {
    if (vmJustStarted || !config.hasUserVmConfig?.(config.userVm)) {
      return;
    }

    onMessage?.(
      'Warning: Colima VM is already running; restart with '
      + '`ai sandbox vm stop && ai sandbox vm start` to apply new sandbox.vm.* values.'
    );
  }
};

export default colimaAdapter;
