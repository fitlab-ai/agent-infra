import fs from 'node:fs';
import path from 'node:path';
import * as toml from 'smol-toml';

import type {
  AgentClientSandboxHook,
  AgentClientSandboxRecoveryCheck
} from '../../sandbox/tool-types.ts';

type JsonObject = Record<string, unknown>;

function isJsonObjectRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveHostCatalogPath(value: unknown, hostHomeDir: string): string | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  let resolved: string;
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    resolved = path.join(hostHomeDir, value.slice(1).replace(/^[/\\]+/, ''));
  } else if (path.isAbsolute(value)) {
    resolved = value;
  } else {
    resolved = path.join(hostHomeDir, '.codex', value);
  }
  try {
    if (!fs.statSync(resolved).isFile()) {
      return null;
    }
    fs.accessSync(resolved, fs.constants.R_OK);
    return resolved;
  } catch {
    return null;
  }
}

const CODEX_DISABLED_FEATURE_FLAGS = ['apps', 'enable_mcp_apps'] as const;
const SANDBOX_CODEX_HOOKS_PATH = '/workspace/.codex/hooks.json';
const CODEX_HOOK_TRUST_HASH = /^sha256:[a-f0-9]{64}$/;

function removeCodexMcpServers(sandboxParsed: JsonObject): boolean {
  if (!Object.hasOwn(sandboxParsed, 'mcp_servers')) {
    return false;
  }
  delete sandboxParsed.mcp_servers;
  return true;
}

function inheritDisabledCodexFeatureFlags(
  sandboxParsed: JsonObject,
  hostParsed: JsonObject
): boolean {
  if (!isJsonObjectRecord(hostParsed.features)) {
    return false;
  }
  if (Object.hasOwn(sandboxParsed, 'features') && !isJsonObjectRecord(sandboxParsed.features)) {
    return false;
  }

  let sandboxFeatures = sandboxParsed.features as JsonObject | undefined;
  let changed = false;
  for (const key of CODEX_DISABLED_FEATURE_FLAGS) {
    if (hostParsed.features[key] !== false) {
      continue;
    }
    if (!sandboxFeatures) {
      sandboxFeatures = {};
      sandboxParsed.features = sandboxFeatures;
    }
    if (sandboxFeatures[key] !== false) {
      sandboxFeatures[key] = false;
      changed = true;
    }
  }
  return changed;
}

function inheritCodexHookTrustState(
  sandboxParsed: JsonObject,
  hostParsed: JsonObject,
  hostProjectDir?: string
): boolean {
  if (!hostProjectDir) {
    return false;
  }

  if (Object.hasOwn(sandboxParsed, 'hooks') && !isJsonObjectRecord(sandboxParsed.hooks)) {
    return false;
  }
  const sandboxHooks = (sandboxParsed.hooks as JsonObject | undefined) ?? {};
  if (Object.hasOwn(sandboxHooks, 'state') && !isJsonObjectRecord(sandboxHooks.state)) {
    return false;
  }

  const sandboxState = (sandboxHooks.state as JsonObject | undefined) ?? {};
  const sandboxPrefix = `${SANDBOX_CODEX_HOOKS_PATH}:`;
  const nextState = Object.fromEntries(
    Object.entries(sandboxState).filter(([key]) => !key.startsWith(sandboxPrefix))
  );

  const hostState = isJsonObjectRecord(hostParsed.hooks)
    && isJsonObjectRecord(hostParsed.hooks.state)
    ? hostParsed.hooks.state
    : {};
  const hostPrefix = `${path.join(hostProjectDir, '.codex', 'hooks.json')}:`;
  for (const [key, value] of Object.entries(hostState)) {
    if (!key.startsWith(hostPrefix) || !isJsonObjectRecord(value)) {
      continue;
    }
    const trustedHash = value.trusted_hash;
    if (typeof trustedHash !== 'string' || !CODEX_HOOK_TRUST_HASH.test(trustedHash)) {
      continue;
    }
    nextState[`${sandboxPrefix}${key.slice(hostPrefix.length)}`] = {
      trusted_hash: trustedHash,
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {})
    };
  }

  if (JSON.stringify(sandboxState) === JSON.stringify(nextState)) {
    return false;
  }
  if (Object.keys(nextState).length > 0) {
    sandboxHooks.state = nextState;
    sandboxParsed.hooks = sandboxHooks;
  } else {
    delete sandboxHooks.state;
    if (Object.keys(sandboxHooks).length > 0) {
      sandboxParsed.hooks = sandboxHooks;
    } else {
      delete sandboxParsed.hooks;
    }
  }
  return true;
}

function ensureCodexModelInheritance(
  toolDir: string,
  hostHomeDir?: string,
  containerCodexDir: string = '/home/devuser/.codex',
  hostProjectDir?: string
): void {
  if (!hostHomeDir) {
    return;
  }

  const sandboxConfigPath = path.join(toolDir, 'config.toml');
  // This rewrites sandbox-side TOML and drops comments; the host config stays untouched.
  let sandboxParsed: JsonObject = {};
  if (fs.existsSync(sandboxConfigPath)) {
    try {
      sandboxParsed = toml.parse(fs.readFileSync(sandboxConfigPath, 'utf8')) as JsonObject;
    } catch {
      return;
    }
  }

  const hostConfigPath = path.join(hostHomeDir, '.codex', 'config.toml');
  let hostParsed: JsonObject | null = null;
  if (fs.existsSync(hostConfigPath)) {
    try {
      hostParsed = toml.parse(fs.readFileSync(hostConfigPath, 'utf8')) as JsonObject;
    } catch {
      // An unavailable host trust source must not leave previously projected trust active.
    }
  }
  if (!hostParsed) {
    if (inheritCodexHookTrustState(sandboxParsed, {}, hostProjectDir)) {
      fs.writeFileSync(sandboxConfigPath, `${toml.stringify(sandboxParsed)}\n`, 'utf8');
    }
    return;
  }

  let changed = removeCodexMcpServers(sandboxParsed);
  changed = inheritDisabledCodexFeatureFlags(sandboxParsed, hostParsed) || changed;
  changed = inheritCodexHookTrustState(sandboxParsed, hostParsed, hostProjectDir) || changed;

  const inheritSpecs: Array<readonly [string, 'string' | 'number']> = [
    ['model', 'string'],
    ['model_reasoning_effort', 'string'],
    ['model_auto_compact_token_limit', 'number']
  ];

  for (const [key, type] of inheritSpecs) {
    if (Object.hasOwn(sandboxParsed, key)) {
      continue;
    }
    const value = hostParsed[key];
    if (type === 'string' && (typeof value !== 'string' || value === '')) {
      continue;
    }
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      continue;
    }
    sandboxParsed[key] = value;
    changed = true;
  }

  if (!Object.hasOwn(sandboxParsed, 'model_catalog_json')) {
    const hostCatalogPath = resolveHostCatalogPath(hostParsed['model_catalog_json'], hostHomeDir);
    if (hostCatalogPath) {
      try {
        const basename = path.basename(hostCatalogPath);
        const destDir = path.join(toolDir, 'model-catalogs');
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(hostCatalogPath, path.join(destDir, basename));
        sandboxParsed['model_catalog_json'] = path.posix.join(
          containerCodexDir,
          'model-catalogs',
          basename
        );
        changed = true;
      } catch {
        // Copy failed (e.g. permissions): skip catalog, keep scalar inheritance intact.
      }
    }
  }

  if (changed) {
    fs.writeFileSync(sandboxConfigPath, `${toml.stringify(sandboxParsed)}\n`, 'utf8');
  }
}

function ensureCodexWorkspaceTrust(toolDir: string): void {
  const configPath = path.join(toolDir, 'config.toml');
  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf8');
  }
  if (!content.includes('[projects."/workspace"]')) {
    const entry = '\n[projects."/workspace"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(configPath, content + entry, 'utf8');
  }
}

const codexBeforeContainerCreateHook: AgentClientSandboxHook = {
  id: 'codex-before-container-create',
  phase: 'before-container-create',
  async run(context) {
    const create = context.create;
    const entry = create?.resolvedTools.find(({ tool }) => tool.id === 'codex');
    if (!create || !entry) {
      return {
        status: 'fatal',
        message: 'Codex sandbox hook requires its resolved tool state.'
      };
    }
    const hostProjectDir = typeof context.config?.repoRoot === 'string'
      ? context.config.repoRoot
      : undefined;
    ensureCodexModelInheritance(
      entry.dir,
      create.hostHome,
      entry.tool.containerMount,
      hostProjectDir
    );
    ensureCodexWorkspaceTrust(entry.dir);
    return { status: 'ready' };
  }
};

const codexRecoveryChecks: readonly AgentClientSandboxRecoveryCheck[] = [
  {
    id: 'command-available',
    probe: {
      script: 'command -v "$1"',
      args: ['codex']
    },
    finding: {
      repairKind: 'hard-failure',
      message: 'Codex is not available on PATH inside the sandbox.'
    }
  },
  {
    id: 'state-writable',
    probe: {
      script: 'probe="$1/.agent-infra-codex-state-$$"; trap \'rm -f -- "$probe"\' EXIT; : > "$probe"',
      args: ['/home/devuser/.codex']
    },
    finding: {
      repairKind: 'permissions',
      message: 'Codex state directory is not writable by devuser.',
      path: '/home/devuser/.codex'
    }
  },
  {
    id: 'prompts-link',
    when: {
      script: 'test -d "$1"',
      args: ['/workspace/.codex/commands']
    },
    probe: {
      script: 'test "$(readlink -- "$1")" = "$2"',
      args: ['/home/devuser/.codex/prompts', '/workspace/.codex/commands']
    },
    finding: {
      repairKind: 'builtin-link',
      message: 'Codex prompts link does not point to the workspace commands directory.',
      path: '/home/devuser/.codex/prompts'
    },
    repair: {
      user: 'devuser',
      command: 'ln',
      args: [
        '-sfn',
        '/workspace/.codex/commands',
        '/home/devuser/.codex/prompts'
      ]
    }
  }
];

export {
  codexBeforeContainerCreateHook,
  codexRecoveryChecks,
  ensureCodexModelInheritance,
  ensureCodexWorkspaceTrust
};
