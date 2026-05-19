import type { OnMessage, SandboxAdapter } from './index.ts';

type NativeRunSafe = (cmd: string, args: string[]) => string;
type EngineRun = (engine: string, cmd: string, args: string[]) => string;
type EngineRunSafe = (engine: string, cmd: string, args: string[]) => string;

export function isRootlessDocker({
  env = process.env,
  runSafe
}: { env?: NodeJS.ProcessEnv; runSafe?: NativeRunSafe } = {}): boolean {
  const dockerHost = env.DOCKER_HOST ?? '';
  if (dockerHost.startsWith('unix:///run/user/')) {
    return true;
  }

  if (!runSafe) {
    return false;
  }

  try {
    const securityOptions = runSafe('docker', ['info', '--format', '{{.SecurityOptions}}']);
    return securityOptions.includes('rootless');
  } catch {
    return false;
  }
}

export function resolveBuildUid({
  engine,
  runFn,
  runSafeFn,
  env = process.env
}: {
  engine: string;
  runFn: EngineRun;
  runSafeFn?: EngineRunSafe;
  env?: NodeJS.ProcessEnv;
}) {
  const runSafe = runSafeFn
    ? (cmd: string, args: string[]) => runSafeFn(engine, cmd, args)
    : undefined;

  if (engine === 'native' && isRootlessDocker({ env, runSafe })) {
    return { uid: '0', gid: '0' };
  }

  return {
    uid: runFn(engine, 'id', ['-u']),
    gid: runFn(engine, 'id', ['-g'])
  };
}

export const nativeAdapter: SandboxAdapter = {
  id: 'native',
  displayName: 'native Docker',
  supportedPlatforms: ['linux', 'win32'],
  dockerContext: null,
  managed: false,
  canApplyResources: 'never',

  defaultResources() {
    return null;
  },

  async ensure(_config, _onMessage: OnMessage, { runOk, runSafe }) {
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
    const rootless = isRootlessDocker({ runSafe });
    if (!serverVersion) {
      if (rootless) {
        throw new Error([
          'Docker rootless daemon is not running or is unreachable.',
          'Start it with: systemctl --user start docker',
          'Enable it on login with: systemctl --user enable docker',
          'Verify DOCKER_HOST points at $XDG_RUNTIME_DIR/docker.sock.',
          'Then retry: ai sandbox create <branch>'
        ].join('\n'));
      }

      throw new Error([
        'Docker daemon is not running or is unreachable.',
        'Start it with: sudo systemctl start docker',
        'Enable it on boot with: sudo systemctl enable docker',
        'If you use rootless or remote Docker, verify DOCKER_HOST points at a reachable socket.',
        'For rootless Docker, export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock and run: systemctl --user start docker',
        'Then retry: ai sandbox create <branch>'
      ].join('\n'));
    }

    if (rootless) {
      throw new Error([
        'docker info failed even though the rootless daemon responded to version.',
        'This usually means DOCKER_HOST or XDG_RUNTIME_DIR is misconfigured.',
        'Verify DOCKER_HOST matches $XDG_RUNTIME_DIR/docker.sock.',
        'Check the daemon with: systemctl --user status docker',
        'Then retry: ai sandbox create <branch>'
      ].join('\n'));
    }

    throw new Error([
      'Docker is installed, but the current user may lack permission to use the daemon.',
      'Add your user to the docker group: sudo usermod -aG docker $USER',
      'Open a new login shell or run: newgrp docker'
    ].join('\n'));
  },

  syncResources(config, onMessage: OnMessage) {
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
