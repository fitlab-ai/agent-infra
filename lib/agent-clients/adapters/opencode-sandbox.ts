import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentClientSandboxHook,
  AgentClientSandboxRecoveryCheck
} from '../../sandbox/tool-types.ts';

type JsonObject = Record<string, unknown>;

function readJsonObject(filePath: string): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

function resolveXdgRoot(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value !== '' && path.isAbsolute(value)
    ? value
    : fallback;
}

function ensureOpenCodeSandboxState(
  toolDir: string,
  hostHome: string,
  hostEnv: Readonly<NodeJS.ProcessEnv> = {}
): void {
  const canonicalConfigDir = path.join(toolDir, '.xdg', 'config', 'opencode');
  const canonicalStateDir = path.join(toolDir, '.xdg', 'state', 'opencode');
  const canonicalConfigPath = path.join(canonicalConfigDir, 'opencode.json');
  const legacyConfigPath = path.join(toolDir, 'opencode.json');
  fs.mkdirSync(canonicalConfigDir, { recursive: true });
  fs.mkdirSync(canonicalStateDir, { recursive: true });

  if (!fs.existsSync(canonicalConfigPath) && fs.existsSync(legacyConfigPath)) {
    fs.copyFileSync(legacyConfigPath, canonicalConfigPath, fs.constants.COPYFILE_EXCL);
  }

  const hostConfigRoot = resolveXdgRoot(
    hostEnv.XDG_CONFIG_HOME,
    path.join(hostHome, '.config')
  );
  const hostConfig = readJsonObject(
    path.join(hostConfigRoot, 'opencode', 'opencode.json')
  );
  if (!hostConfig) {
    return;
  }

  let sandboxConfig: JsonObject = {};
  if (fs.existsSync(canonicalConfigPath)) {
    const existing = readJsonObject(canonicalConfigPath);
    if (!existing) {
      return;
    }
    sandboxConfig = existing;
  }

  let changed = false;
  for (const key of ['model', 'small_model']) {
    if (Object.hasOwn(sandboxConfig, key)) {
      continue;
    }
    const value = hostConfig[key];
    if (typeof value === 'string' && value !== '') {
      sandboxConfig[key] = value;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(canonicalConfigPath, JSON.stringify(sandboxConfig, null, 2), 'utf8');
  }
}

const opencodeBeforeContainerCreateHook: AgentClientSandboxHook = {
  id: 'opencode-before-container-create',
  phase: 'before-container-create',
  async run(context) {
    const create = context.create;
    const entry = create?.resolvedTools.find(({ tool }) => tool.id === 'opencode');
    if (!create || !entry) {
      return {
        status: 'fatal',
        message: 'OpenCode sandbox hook requires its resolved tool state.'
      };
    }
    ensureOpenCodeSandboxState(entry.dir, create.hostHome, create.hostEnv);
    return { status: 'ready' };
  }
};

const opencodeRecoveryChecks: readonly AgentClientSandboxRecoveryCheck[] = [
  {
    id: 'command-available',
    probe: { script: 'command -v "$1"', args: ['opencode'] },
    finding: {
      repairKind: 'hard-failure',
      message: 'OpenCode is not available on PATH inside the sandbox.'
    }
  },
  {
    id: 'config-writable',
    probe: {
      script: 'probe="$1/.agent-infra-opencode-config-$$"; trap \'rm -f -- "$probe"\' EXIT; : > "$probe"',
      args: ['/home/devuser/.local/share/opencode/.xdg/config/opencode']
    },
    finding: {
      repairKind: 'permissions',
      message: 'OpenCode config directory is not writable by devuser.',
      path: '/home/devuser/.local/share/opencode/.xdg/config/opencode'
    }
  },
  {
    id: 'state-writable',
    probe: {
      script: 'probe="$1/.agent-infra-opencode-state-$$"; trap \'rm -f -- "$probe"\' EXIT; : > "$probe"',
      args: ['/home/devuser/.local/share/opencode/.xdg/state/opencode']
    },
    finding: {
      repairKind: 'permissions',
      message: 'OpenCode state directory is not writable by devuser.',
      path: '/home/devuser/.local/share/opencode/.xdg/state/opencode'
    }
  }
];

export {
  ensureOpenCodeSandboxState,
  opencodeBeforeContainerCreateHook,
  opencodeRecoveryChecks
};
