export const nativeAdapter = {
  id: 'native',
  displayName: 'native Docker',
  dockerContext: null,
  managed: false,
  canApplyResources: 'never',

  defaultResources() {
    return null;
  },

  async ensure(_config, _onMessage, { runOk, runSafe }) {
    if (!runOk('which', ['docker'])) {
      throw new Error([
        'Docker is not installed.',
        'Install Docker Engine for your distribution: https://docs.docker.com/engine/install/',
        'Then start the daemon with: sudo systemctl enable --now docker',
        'If you want to run Docker without sudo, add your user to the docker group: sudo usermod -aG docker $USER'
      ].join('\n'));
    }

    if (runOk('docker', ['info'])) {
      return false;
    }

    const serverVersion = runSafe('docker', ['version', '--format', '{{.Server.Version}}']);
    if (!serverVersion) {
      throw new Error([
        'Docker daemon is not running or is unreachable.',
        'Start it with: sudo systemctl start docker',
        'Enable it on boot with: sudo systemctl enable docker',
        'If you use rootless or remote Docker, verify DOCKER_HOST points at a reachable socket.',
        'Then retry: ai sandbox create <branch>'
      ].join('\n'));
    }

    throw new Error([
      'Docker is installed, but the current user may lack permission to use the daemon.',
      'Add your user to the docker group: sudo usermod -aG docker $USER',
      'Open a new login shell or run: newgrp docker',
      'For rootless Docker, make sure DOCKER_HOST points at the rootless daemon socket.'
    ].join('\n'));
  },

  syncResources(config, onMessage) {
    if (!config.hasUserVmConfig?.(config.userVm)) {
      return;
    }

    onMessage?.(
      'Warning: Linux native Docker has no managed VM; sandbox.vm.* is not applicable. '
      + 'Use docker run --cpus / --memory per container or host cgroups.'
    );
  }
};

export default nativeAdapter;
