import {
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_SUPPORT_LEVELS,
  isAgentClientId
} from './types.ts';
import type {
  AgentClientCapabilityMap,
  AgentClientId
} from './types.ts';

type AgentClientCapabilities = AgentClientCapabilityMap;

type AgentClientProjectDescriptor = Readonly<{
  ownedPathPrefixes: readonly string[];
  managed: readonly string[];
  merged: readonly string[];
  ejected: readonly string[];
}>;

type AgentClientAdapter = Readonly<{
  id: AgentClientId;
  displayName: string;
  invocation: string;
  capabilities: AgentClientCapabilities;
  project: AgentClientProjectDescriptor;
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

  return Object.freeze({
    id: candidate.id,
    displayName: candidate.displayName,
    invocation: candidate.invocation,
    capabilities: Object.freeze(capabilities),
    project: Object.freeze({
      ownedPathPrefixes: Object.freeze(paths),
      ...projectAssets
    })
  });
}

export { defineAgentClientAdapter };
export type {
  AgentClientAdapter,
  AgentClientCapabilities,
  AgentClientManifestEntry,
  AgentClientProjectDescriptor,
  AgentClientRegistry
};
