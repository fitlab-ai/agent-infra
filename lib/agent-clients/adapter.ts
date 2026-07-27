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
}>;

type AgentClientAdapter = Readonly<{
  id: AgentClientId;
  displayName: string;
  capabilities: AgentClientCapabilities;
  project: AgentClientProjectDescriptor;
}>;

type AgentClientRegistry = Readonly<
  Record<AgentClientId, AgentClientAdapter>
>;

type AgentClientManifestEntry = Readonly<{
  id: AgentClientId;
  displayName: string;
  ownedPathPrefixes: readonly string[];
}>;

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
      || prefix.length === 0
      || prefix.includes('\\')
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

  return Object.freeze({
    id: candidate.id,
    displayName: candidate.displayName,
    capabilities: Object.freeze(capabilities),
    project: Object.freeze({
      ownedPathPrefixes: Object.freeze(paths)
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
