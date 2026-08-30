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

type AgentClientConfigInput = Readonly<Record<string, unknown>>;

type AgentClientDiagnosticCode =
  | 'INVALID_AGENT_CLIENTS'
  | 'DUPLICATE_AGENT_CLIENT'
  | 'MISSING_AGENT_CLIENT'
  | 'UNKNOWN_AGENT_CLIENT';

type AgentClientDiagnostic = Readonly<{
  code: AgentClientDiagnosticCode;
  path: string;
}>;

type NormalizeAgentClientsResult = Readonly<{
  state: AgentClientState;
  canonical: AgentClientsConfig;
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

function normalizeAgentClients(
  input: AgentClientConfigInput
): NormalizeAgentClientsResult {
  if (!hasOwn(input, 'agentClients')) fail('MISSING_AGENT_CLIENT', 'agentClients');
  const state = parseCanonical(input.agentClients);
  for (const [index, id] of AGENT_CLIENT_IDS.entries()) {
    const entry = Array.isArray(input.agentClients) ? input.agentClients[index] : undefined;
    if (!isRecord(entry) || entry.id !== id) {
      fail('INVALID_AGENT_CLIENTS', `agentClients[${index}].id`);
    }
  }
  if (hasOwn(input, 'tuis')) fail('INVALID_AGENT_CLIENTS', 'tuis');
  const sandbox = isRecord(input.sandbox) ? input.sandbox : undefined;
  if (Array.isArray(sandbox?.tools)) {
    for (const [index, tool] of sandbox.tools.entries()) {
      if (isAgentClientId(tool)) {
        fail('INVALID_AGENT_CLIENTS', `sandbox.tools[${index}]`);
      }
    }
  }
  return {
    state,
    canonical: serializeAgentClients(state)
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
