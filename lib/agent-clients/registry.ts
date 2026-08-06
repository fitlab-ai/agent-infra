import { BUILTIN_AGENT_CLIENT_ADAPTERS } from './adapters/index.ts';
import { AGENT_CLIENT_IDS, isAgentClientId } from './types.ts';
import type {
  AgentClientAdapter,
  AgentClientManifestEntry,
  AgentClientRegistry
} from './adapter.ts';
import type {
  AgentClientCapabilityId,
  AgentClientCapabilitySupport,
  AgentClientState,
  AgentClientSupportLevel
} from './types.ts';

function buildRegistry(): Readonly<{
  registry: AgentClientRegistry;
  adapters: readonly AgentClientAdapter[];
}> {
  if (BUILTIN_AGENT_CLIENT_ADAPTERS.length !== AGENT_CLIENT_IDS.length) {
    throw new Error('Agent Client Registry is incomplete');
  }

  const byId = new Map(
    BUILTIN_AGENT_CLIENT_ADAPTERS.map((adapter) => [adapter.id, adapter])
  );
  if (byId.size !== BUILTIN_AGENT_CLIENT_ADAPTERS.length) {
    throw new Error('Agent Client Registry contains duplicate IDs');
  }

  const adapters = Object.freeze(
    AGENT_CLIENT_IDS.map((id) => {
      const adapter = byId.get(id);
      if (!adapter || adapter.id !== id) {
        throw new Error(`Agent Client Registry is missing '${id}'`);
      }
      return adapter;
    })
  );

  const ownedPaths = adapters.flatMap((adapter) =>
    adapter.project.ownedPathPrefixes.map((prefix) => ({
      id: adapter.id,
      prefix
    }))
  );
  for (const [index, current] of ownedPaths.entries()) {
    for (const other of ownedPaths.slice(index + 1)) {
      if (
        current.id !== other.id
        && (
          current.prefix.startsWith(other.prefix)
          || other.prefix.startsWith(current.prefix)
        )
      ) {
        throw new Error(
          `Agent Client owned paths overlap: '${current.prefix}' and '${other.prefix}'`
        );
      }
    }
  }

  const registry = Object.freeze(
    Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter]))
  ) as AgentClientRegistry;

  return Object.freeze({ registry, adapters });
}

const built = buildRegistry();
const AGENT_CLIENT_REGISTRY = built.registry;
const AGENT_CLIENT_ADAPTERS = built.adapters;

function listAgentClientAdapters(): readonly AgentClientAdapter[] {
  return AGENT_CLIENT_ADAPTERS;
}

function getAgentClientAdapter(id: unknown): AgentClientAdapter {
  if (!isAgentClientId(id)) {
    throw new Error(`No Agent Client adapter registered for '${String(id)}'`);
  }
  return AGENT_CLIENT_REGISTRY[id];
}

function listEnabledAgentClientAdapters(
  state: AgentClientState
): readonly AgentClientAdapter[] {
  return Object.freeze(
    AGENT_CLIENT_ADAPTERS.filter((adapter) => state[adapter.id].enabled)
  );
}

function listInstalledAgentClientAdapters(
  state: AgentClientState
): readonly AgentClientAdapter[] {
  return Object.freeze(
    AGENT_CLIENT_ADAPTERS.filter((adapter) => state[adapter.id].installInSandbox)
  );
}

function getAgentClientCapability(
  id: unknown,
  capability: AgentClientCapabilityId
): AgentClientCapabilitySupport {
  return getAgentClientAdapter(id).capabilities[capability];
}

function getAgentClientModelSelection(id: unknown) {
  return getAgentClientAdapter(id).modelSelection;
}

function getAgentClientDelegationEvidence(id: unknown) {
  return getAgentClientAdapter(id).delegationEvidence;
}

function listEnabledAgentClientAdaptersByCapability(
  state: AgentClientState,
  capability: AgentClientCapabilityId,
  acceptedLevels: readonly AgentClientSupportLevel[]
): readonly AgentClientAdapter[] {
  const accepted = new Set(acceptedLevels);
  return Object.freeze(
    AGENT_CLIENT_ADAPTERS.filter((adapter) =>
      state[adapter.id].enabled
      && accepted.has(adapter.capabilities[capability].level)
    )
  );
}

function createAgentClientManifest(): readonly AgentClientManifestEntry[] {
  return Object.freeze(
    AGENT_CLIENT_ADAPTERS.map((adapter) => Object.freeze({
      id: adapter.id,
      displayName: adapter.displayName,
      invocation: adapter.invocation,
      ownedPathPrefixes: Object.freeze([...adapter.project.ownedPathPrefixes]),
      managed: Object.freeze([...adapter.project.managed]),
      merged: Object.freeze([...adapter.project.merged]),
      ejected: Object.freeze([...adapter.project.ejected])
    }))
  );
}

export {
  AGENT_CLIENT_REGISTRY,
  createAgentClientManifest,
  getAgentClientAdapter,
  getAgentClientCapability,
  getAgentClientDelegationEvidence,
  getAgentClientModelSelection,
  listAgentClientAdapters,
  listEnabledAgentClientAdapters,
  listEnabledAgentClientAdaptersByCapability,
  listInstalledAgentClientAdapters
};
