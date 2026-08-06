import {
  AGENT_CLIENT_IDS,
  isAgentClientId
} from './types.ts';
import type {
  AgentClientConfig,
  AgentClientId,
  AgentClientsConfig,
  AgentClientState,
  OrchestrationModelPolicy
} from './types.ts';

type AgentClientConfigInput = Readonly<{
  agentClients?: unknown;
  tuis?: unknown;
  sandbox?: unknown;
  customTUIs?: unknown;
}>;

type AgentClientDiagnosticCode =
  | 'INVALID_AGENT_CLIENTS'
  | 'DUPLICATE_AGENT_CLIENT'
  | 'MISSING_AGENT_CLIENT'
  | 'UNKNOWN_AGENT_CLIENT'
  | 'LEGACY_CONFLICT'
  | 'LEGACY_VALUE_IGNORED';

type AgentClientDiagnostic = Readonly<{
  code: AgentClientDiagnosticCode;
  path: string;
}>;

type NormalizeAgentClientsResult = Readonly<{
  source: 'canonical' | 'legacy';
  state: AgentClientState;
  canonical: AgentClientsConfig;
  remainingSandboxTools: readonly string[] | undefined;
  removeLegacyTuis: boolean;
  changed: boolean;
  diagnostics: readonly AgentClientDiagnostic[];
}>;

class AgentClientConfigError extends Error {
  readonly code: AgentClientDiagnosticCode;
  readonly path: string;
  readonly diagnostics: readonly AgentClientDiagnostic[];

  constructor(diagnostic: AgentClientDiagnostic) {
    super(`${diagnostic.code} at ${diagnostic.path}`);
    this.name = 'AgentClientConfigError';
    this.code = diagnostic.code;
    this.path = diagnostic.path;
    this.diagnostics = [diagnostic];
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: AgentClientDiagnosticCode, path: string): never {
  throw new AgentClientConfigError({ code, path });
}

function parseExactText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('INVALID_AGENT_CLIENTS', path);
  }
  return value;
}

function parseOrchestrationPolicy(value: unknown, path: string): OrchestrationModelPolicy {
  if (!isRecord(value)) fail('INVALID_AGENT_CLIENTS', path);
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !hasOwn(value, 'executor')
    || !hasOwn(value, 'reviewer')
  ) {
    fail('INVALID_AGENT_CLIENTS', path);
  }
  const parseRole = (candidate: unknown, rolePath: string) => {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).length !== 2
      || !hasOwn(candidate, 'model')
      || !hasOwn(candidate, 'reasoningEffort')
    ) {
      fail('INVALID_AGENT_CLIENTS', rolePath);
    }
    return Object.freeze({
      model: parseExactText(candidate.model, `${rolePath}.model`),
      reasoningEffort: parseExactText(candidate.reasoningEffort, `${rolePath}.reasoningEffort`)
    });
  };
  const executor = parseRole(value.executor, `${path}.executor`);
  const reviewer = parseRole(value.reviewer, `${path}.reviewer`);
  return Object.freeze({ executor, reviewer });
}

function parseCanonical(value: unknown): AgentClientState {
  if (!Array.isArray(value)) fail('INVALID_AGENT_CLIENTS', 'agentClients');

  const entries = new Map<AgentClientId, Readonly<{
    enabled: boolean;
    installInSandbox: boolean;
    orchestration?: OrchestrationModelPolicy;
  }>>();

  for (const [index, candidate] of value.entries()) {
    const path = `agentClients[${index}]`;
    if (!isRecord(candidate)) fail('INVALID_AGENT_CLIENTS', path);

    const keys = Object.keys(candidate);
    if (
      (keys.length !== 3 && keys.length !== 4)
      || !hasOwn(candidate, 'id')
      || !hasOwn(candidate, 'enabled')
      || !hasOwn(candidate, 'installInSandbox')
      || (keys.length === 4 && !hasOwn(candidate, 'orchestration'))
    ) {
      fail('INVALID_AGENT_CLIENTS', path);
    }
    if (!isAgentClientId(candidate.id)) {
      fail('UNKNOWN_AGENT_CLIENT', `${path}.id`);
    }
    if (entries.has(candidate.id)) {
      fail('DUPLICATE_AGENT_CLIENT', `${path}.id`);
    }
    if (
      typeof candidate.enabled !== 'boolean'
      || typeof candidate.installInSandbox !== 'boolean'
    ) {
      fail('INVALID_AGENT_CLIENTS', path);
    }
    entries.set(candidate.id, {
      enabled: candidate.enabled,
      installInSandbox: candidate.installInSandbox,
      ...(hasOwn(candidate, 'orchestration')
        ? { orchestration: parseOrchestrationPolicy(candidate.orchestration, `${path}.orchestration`) }
        : {})
    });
  }

  for (const id of AGENT_CLIENT_IDS) {
    if (!entries.has(id)) fail('MISSING_AGENT_CLIENT', 'agentClients');
  }

  return Object.fromEntries(
    AGENT_CLIENT_IDS.map((id) => [id, entries.get(id)!])
  ) as AgentClientState;
}

function serializeAgentClients(state: AgentClientState): AgentClientsConfig {
  return AGENT_CLIENT_IDS.map((id): AgentClientConfig => ({
    id,
    enabled: state[id].enabled,
    installInSandbox: state[id].installInSandbox,
    ...(state[id].orchestration
      ? { orchestration: structuredClone(state[id].orchestration) }
      : {})
  }));
}

function projectLegacyTuis(
  value: unknown,
  diagnostics: AgentClientDiagnostic[]
): Readonly<Record<AgentClientId, boolean>> {
  if (!Array.isArray(value)) {
    return Object.fromEntries(
      AGENT_CLIENT_IDS.map((id) => [id, true])
    ) as Readonly<Record<AgentClientId, boolean>>;
  }

  const enabled = new Set<AgentClientId>();
  for (const [index, candidate] of value.entries()) {
    if (isAgentClientId(candidate)) {
      enabled.add(candidate);
    } else {
      diagnostics.push({
        code: 'LEGACY_VALUE_IGNORED',
        path: `tuis[${index}]`
      });
    }
  }
  return Object.fromEntries(
    AGENT_CLIENT_IDS.map((id) => [id, enabled.has(id)])
  ) as Readonly<Record<AgentClientId, boolean>>;
}

type SandboxProjection = Readonly<{
  installed: Readonly<Record<AgentClientId, boolean>>;
  clientSignals: ReadonlySet<AgentClientId>;
  remainingTools: readonly string[] | undefined;
}>;

function projectLegacySandbox(
  value: unknown,
  diagnostics: AgentClientDiagnostic[]
): SandboxProjection {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      installed: Object.fromEntries(
        AGENT_CLIENT_IDS.map((id) => [id, true])
      ) as Readonly<Record<AgentClientId, boolean>>,
      clientSignals: new Set<AgentClientId>(),
      remainingTools: Array.isArray(value) ? [] : undefined
    };
  }

  const installed = new Set<AgentClientId>();
  const remainingTools: string[] = [];
  for (const [index, candidate] of value.entries()) {
    if (isAgentClientId(candidate)) {
      installed.add(candidate);
    } else if (typeof candidate === 'string') {
      remainingTools.push(candidate);
    } else {
      diagnostics.push({
        code: 'LEGACY_VALUE_IGNORED',
        path: `sandbox.tools[${index}]`
      });
    }
  }
  return {
    installed: Object.fromEntries(
      AGENT_CLIENT_IDS.map((id) => [id, installed.has(id)])
    ) as Readonly<Record<AgentClientId, boolean>>,
    clientSignals: installed,
    remainingTools
  };
}

function stateFromLegacy(
  enabled: Readonly<Record<AgentClientId, boolean>>,
  installed: Readonly<Record<AgentClientId, boolean>>
): AgentClientState {
  return Object.fromEntries(
    AGENT_CLIENT_IDS.map((id) => [
      id,
      {
        enabled: enabled[id],
        installInSandbox: installed[id]
      }
    ])
  ) as AgentClientState;
}

function sameCanonicalOrder(value: unknown): boolean {
  return Array.isArray(value)
    && value.every((entry, index) => isRecord(entry) && entry.id === AGENT_CLIENT_IDS[index]);
}

function normalizeAgentClients(
  input: AgentClientConfigInput
): NormalizeAgentClientsResult {
  const diagnostics: AgentClientDiagnostic[] = [];
  const hasCanonical = hasOwn(input, 'agentClients');
  const hasLegacyTuis = hasOwn(input, 'tuis');
  const sandbox = isRecord(input.sandbox) ? input.sandbox : undefined;
  const hasLegacySandboxTools = sandbox !== undefined && hasOwn(sandbox, 'tools');
  const tuiProjection = projectLegacyTuis(input.tuis, diagnostics);
  const sandboxProjection = projectLegacySandbox(sandbox?.tools, diagnostics);

  if (!hasCanonical) {
    const state = stateFromLegacy(tuiProjection, sandboxProjection.installed);
    return {
      source: 'legacy',
      state,
      canonical: serializeAgentClients(state),
      remainingSandboxTools: sandboxProjection.remainingTools,
      removeLegacyTuis: hasLegacyTuis,
      changed: true,
      diagnostics
    };
  }

  const state = parseCanonical(input.agentClients);
  if (hasLegacyTuis) {
    for (const id of AGENT_CLIENT_IDS) {
      if (state[id].enabled !== tuiProjection[id]) {
        fail('LEGACY_CONFLICT', 'tuis');
      }
    }
  }
  if (hasLegacySandboxTools) {
    for (const id of sandboxProjection.clientSignals) {
      if (!state[id].installInSandbox) {
        fail('LEGACY_CONFLICT', 'sandbox.tools');
      }
    }
  }

  return {
    source: 'canonical',
    state,
    canonical: serializeAgentClients(state),
    remainingSandboxTools: hasLegacySandboxTools
      ? sandboxProjection.remainingTools
      : undefined,
    removeLegacyTuis: hasLegacyTuis,
    changed: hasLegacyTuis
      || sandboxProjection.clientSignals.size > 0
      || !sameCanonicalOrder(input.agentClients),
    diagnostics
  };
}

export {
  AgentClientConfigError,
  normalizeAgentClients,
  serializeAgentClients
};
export type {
  AgentClientConfigInput,
  AgentClientDiagnostic,
  AgentClientDiagnosticCode,
  NormalizeAgentClientsResult
};
