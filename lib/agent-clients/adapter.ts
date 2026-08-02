import {
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_SUPPORT_LEVELS,
  isAgentClientId
} from './types.ts';
import type {
  AgentClientCapabilityMap,
  AgentClientId
} from './types.ts';
import {
  SANDBOX_HOOK_PHASES
} from '../sandbox/tool-types.ts';
import type {
  AgentClientSandboxDescriptor,
  SandboxAlias,
  SandboxTool,
  SandboxToolContext
} from '../sandbox/tool-types.ts';

type AgentClientCapabilities = AgentClientCapabilityMap;

type AgentClientSeedCommand = Readonly<{
  templates: Readonly<{
    en: string;
    'zh-CN': string;
  }>;
  target: string;
}>;

type AgentClientProjectDescriptor = Readonly<{
  ownedPathPrefixes: readonly string[];
  managed: readonly string[];
  merged: readonly string[];
  ejected: readonly string[];
  seedCommands: readonly AgentClientSeedCommand[];
}>;

type AgentClientAdapter = Readonly<{
  id: AgentClientId;
  displayName: string;
  invocation: string;
  capabilities: AgentClientCapabilities;
  project: AgentClientProjectDescriptor;
  sandbox: AgentClientSandboxDescriptor;
}>;

type AgentClientRegistry = Readonly<
  Record<AgentClientId, AgentClientAdapter>
>;

type AgentClientManifestEntry = Readonly<{
  id: AgentClientId;
  displayName: string;
  invocation: string;
  ownedPathPrefixes: readonly string[];
  managed: readonly string[];
  merged: readonly string[];
  ejected: readonly string[];
}>;

const PROJECT_ASSET_CATEGORIES = ['managed', 'merged', 'ejected'] as const;
const MAX_SANDBOX_HOOK_TIMEOUT_MS = 300_000;
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function freezeTool(tool: SandboxTool): SandboxTool {
  if (typeof tool.id !== 'string' || !TOOL_ID_PATTERN.test(tool.id)) {
    throw new Error(`Invalid sandbox tool id: ${String(tool.id)}`);
  }
  if (!tool.install?.cmd || !['npm', 'shell'].includes(tool.install.type)) {
    throw new Error(`Sandbox tool '${tool.id}' has invalid install`);
  }
  if (!tool.containerMount.startsWith('/')) {
    throw new Error(`Sandbox tool '${tool.id}' containerMount must be absolute`);
  }
  if (!tool.versionCmd) {
    throw new Error(`Sandbox tool '${tool.id}' requires versionCmd`);
  }
  return Object.freeze({
    ...tool,
    install: Object.freeze({ ...tool.install }),
    ...(tool.envVars ? { envVars: Object.freeze({ ...tool.envVars }) } : {}),
    ...(tool.hostPreSeedFiles ? {
      hostPreSeedFiles: Object.freeze(tool.hostPreSeedFiles.map((entry) => Object.freeze({ ...entry })))
    } : {}),
    ...(tool.hostPreSeedDirs ? {
      hostPreSeedDirs: Object.freeze(tool.hostPreSeedDirs.map((entry) => Object.freeze({ ...entry })))
    } : {}),
    ...(tool.pathRewriteFiles ? { pathRewriteFiles: Object.freeze([...tool.pathRewriteFiles]) } : {}),
    ...(tool.hostLiveMounts ? {
      hostLiveMounts: Object.freeze(tool.hostLiveMounts.map((entry) => Object.freeze({ ...entry })))
    } : {}),
    ...(tool.postSetupCmds ? { postSetupCmds: Object.freeze([...tool.postSetupCmds]) } : {}),
    ...(tool.tmpfs ? {
      tmpfs: Object.freeze({
        ...tool.tmpfs,
        ...(tool.tmpfs.seed ? { seed: Object.freeze([...tool.tmpfs.seed]) } : {})
      })
    } : {})
  }) as SandboxTool;
}

function freezeAliases(id: AgentClientId, aliases: readonly SandboxAlias[]): readonly SandboxAlias[] {
  const names = new Set<string>();
  return Object.freeze(aliases.map((alias) => {
    if (!alias.name || !alias.command || names.has(alias.name)) {
      throw new Error(`Agent Client '${id}' has invalid or duplicate sandbox alias '${alias.name}'`);
    }
    names.add(alias.name);
    return Object.freeze({ ...alias });
  }));
}

function isProjectRelativeLiteral(value: string): boolean {
  if (
    value.length === 0
    || value.startsWith('/')
    || /^[a-zA-Z]:/.test(value)
    || value.includes('\\')
    || /[*?[\]{}]/.test(value)
  ) {
    return false;
  }
  return !value.split('/').some((segment) => segment === '..');
}

function defineAgentClientAdapter(
  candidate: AgentClientAdapter
): AgentClientAdapter {
  if (!isAgentClientId(candidate.id)) {
    throw new Error(`Unknown Agent Client ID '${String(candidate.id)}'`);
  }
  if (typeof candidate.displayName !== 'string' || candidate.displayName.trim() === '') {
    throw new Error(`Agent Client '${candidate.id}' requires a display name`);
  }
  if (
    typeof candidate.invocation !== 'string'
    || candidate.invocation.trim() === ''
    || /[\r\n]/.test(candidate.invocation)
  ) {
    throw new Error(`Agent Client '${candidate.id}' requires a single-line invocation`);
  }
  const invocationPlaceholders = [
    ...candidate.invocation.matchAll(/\$\{([^}]+)\}/g)
  ].map((match) => match[1]);
  if (
    !invocationPlaceholders.includes('skillName')
    || invocationPlaceholders.some((placeholder) =>
      placeholder !== 'skillName' && placeholder !== 'projectName'
    )
    || candidate.invocation
      .replaceAll('${skillName}', '')
      .replaceAll('${projectName}', '')
      .includes('${')
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid invocation`);
  }

  if (
    typeof candidate.capabilities !== 'object'
    || candidate.capabilities === null
    || Array.isArray(candidate.capabilities)
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid capability map`);
  }
  const capabilityKeys = Object.keys(candidate.capabilities);
  if (
    capabilityKeys.length !== AGENT_CLIENT_CAPABILITY_IDS.length
    || AGENT_CLIENT_CAPABILITY_IDS.some((capability) =>
      !Object.prototype.hasOwnProperty.call(candidate.capabilities, capability)
    )
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid capability map`);
  }

  const capabilities = Object.fromEntries(
    AGENT_CLIENT_CAPABILITY_IDS.map((capability) => {
      const support = candidate.capabilities[capability];
      if (
        typeof support !== 'object'
        || support === null
        || !AGENT_CLIENT_SUPPORT_LEVELS.includes(support.level)
      ) {
        throw new Error(
          `Agent Client '${candidate.id}' has invalid support for '${capability}'`
        );
      }
      return [capability, Object.freeze({ level: support.level })];
    })
  ) as AgentClientCapabilities;

  if (
    typeof candidate.project !== 'object'
    || candidate.project === null
    || Array.isArray(candidate.project)
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid project descriptor`);
  }
  const ownedPathPrefixes = candidate.project.ownedPathPrefixes;
  if (!Array.isArray(ownedPathPrefixes) || ownedPathPrefixes.length === 0) {
    throw new Error(`Agent Client '${candidate.id}' requires owned path prefixes`);
  }

  const paths = ownedPathPrefixes.map((prefix) => {
    if (
      typeof prefix !== 'string'
      || !isProjectRelativeLiteral(prefix)
      || !prefix.endsWith('/')
    ) {
      throw new Error(
        `Agent Client '${candidate.id}' has invalid owned path prefix '${String(prefix)}'`
      );
    }
    return prefix;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error(`Agent Client '${candidate.id}' has duplicate owned path prefixes`);
  }

  const projectAssets = Object.fromEntries(
    PROJECT_ASSET_CATEGORIES.map((category) => {
      const values = candidate.project[category];
      if (!Array.isArray(values)) {
        throw new Error(
          `Agent Client '${candidate.id}' has invalid '${category}' project assets`
        );
      }
      const assets = values.map((asset) => {
        if (
          typeof asset !== 'string'
          || !isProjectRelativeLiteral(asset)
          || !paths.some((prefix) =>
            asset === prefix.slice(0, -1) || asset.startsWith(prefix)
          )
        ) {
          throw new Error(
            `Agent Client '${candidate.id}' has invalid '${category}' project asset '${String(asset)}'`
          );
        }
        return asset;
      });
      if (new Set(assets).size !== assets.length) {
        throw new Error(
          `Agent Client '${candidate.id}' has duplicate '${category}' project assets`
        );
      }
      return [category, Object.freeze(assets)];
    })
  ) as Pick<AgentClientProjectDescriptor, 'managed' | 'merged' | 'ejected'>;

  const categorizedAssets = PROJECT_ASSET_CATEGORIES.flatMap((category) =>
    projectAssets[category].map((asset) => ({ asset, category }))
  );
  const seenAssets = new Map<string, string>();
  for (const { asset, category } of categorizedAssets) {
    const previous = seenAssets.get(asset);
    if (previous) {
      throw new Error(
        `Agent Client '${candidate.id}' project asset '${asset}' overlaps '${previous}' and '${category}'`
      );
    }
    seenAssets.set(asset, category);
  }

  if (!Array.isArray(candidate.project.seedCommands)) {
    throw new Error(`Agent Client '${candidate.id}' has invalid seed commands`);
  }
  const seedTargets = new Set<string>();
  const seedCommands = candidate.project.seedCommands.map((seed) => {
    if (!seed || typeof seed !== 'object') {
      throw new Error(`Agent Client '${candidate.id}' has an invalid seed command`);
    }
    const placeholders = [
      ...seed.target.matchAll(/\$\{([^}]+)\}/g)
    ].map((match) => match[1]);
    const targetProbe = seed.target.replaceAll('${projectName}', 'project');
    if (
      placeholders.some((placeholder) => placeholder !== 'projectName')
      || targetProbe.includes('${')
      || !isProjectRelativeLiteral(targetProbe)
      || !paths.some((prefix) =>
        targetProbe === prefix.slice(0, -1) || targetProbe.startsWith(prefix)
      )
      || seedTargets.has(seed.target)
    ) {
      throw new Error(
        `Agent Client '${candidate.id}' has invalid seed target '${String(seed.target)}'`
      );
    }
    if (
      !seed.templates
      || typeof seed.templates.en !== 'string'
      || typeof seed.templates['zh-CN'] !== 'string'
      || !isProjectRelativeLiteral(seed.templates.en)
      || !isProjectRelativeLiteral(seed.templates['zh-CN'])
    ) {
      throw new Error(`Agent Client '${candidate.id}' has invalid seed templates`);
    }
    seedTargets.add(seed.target);
    return Object.freeze({
      templates: Object.freeze({ ...seed.templates }),
      target: seed.target
    });
  });

  if (!candidate.sandbox || typeof candidate.sandbox.createTool !== 'function') {
    throw new Error(`Agent Client '${candidate.id}' requires a sandbox descriptor`);
  }
  const hookIds = new Set<string>();
  const hooks = Object.freeze(candidate.sandbox.hooks.map((hook) => {
    if (
      !hook.id
      || hookIds.has(hook.id)
      || !SANDBOX_HOOK_PHASES.includes(hook.phase)
      || typeof hook.run !== 'function'
    ) {
      throw new Error(`Agent Client '${candidate.id}' has an invalid sandbox hook`);
    }
    if (
      hook.timeoutMs !== undefined
      && (
        !Number.isInteger(hook.timeoutMs)
        || hook.timeoutMs <= 0
        || hook.timeoutMs > MAX_SANDBOX_HOOK_TIMEOUT_MS
      )
    ) {
      throw new Error(`Agent Client '${candidate.id}' hook '${hook.id}' has invalid timeoutMs`);
    }
    hookIds.add(hook.id);
    return Object.freeze({ ...hook });
  }));
  const aliases = freezeAliases(candidate.id, candidate.sandbox.aliases);
  const createTool = (context: SandboxToolContext): SandboxTool => {
    const tool = freezeTool(candidate.sandbox.createTool(context));
    if (tool.id !== candidate.id) {
      throw new Error(
        `Agent Client '${candidate.id}' sandbox tool id must match the adapter id`
      );
    }
    return tool;
  };

  return Object.freeze({
    id: candidate.id,
    displayName: candidate.displayName,
    invocation: candidate.invocation,
    capabilities: Object.freeze(capabilities),
    project: Object.freeze({
      ownedPathPrefixes: Object.freeze(paths),
      ...projectAssets,
      seedCommands: Object.freeze(seedCommands)
    }),
    sandbox: Object.freeze({ createTool, aliases, hooks })
  });
}

export { defineAgentClientAdapter };
export type {
  AgentClientAdapter,
  AgentClientCapabilities,
  AgentClientManifestEntry,
  AgentClientProjectDescriptor,
  AgentClientSeedCommand,
  AgentClientRegistry
};
