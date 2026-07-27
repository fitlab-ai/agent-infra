const AGENT_CLIENT_IDS = [
  'claude-code',
  'codex',
  'gemini-cli',
  'opencode'
] as const;

type AgentClientId = (typeof AGENT_CLIENT_IDS)[number];

type AgentClientConfig = Readonly<{
  id: AgentClientId;
  enabled: boolean;
  installInSandbox: boolean;
}>;

type AgentClientsConfig = readonly AgentClientConfig[];

type AgentClientState = Readonly<
  Record<
    AgentClientId,
    Readonly<{
      enabled: boolean;
      installInSandbox: boolean;
    }>
  >
>;

const AGENT_CLIENT_CAPABILITY_IDS = [
  'instructions',
  'skills',
  'commands',
  'hooks',
  'sandbox',
  'verification'
] as const;

const AGENT_CLIENT_SUPPORT_LEVELS = [
  'compatible',
  'integrated',
  'verified',
  'experimental'
] as const;

type AgentClientCapabilityId = (typeof AGENT_CLIENT_CAPABILITY_IDS)[number];
type AgentClientSupportLevel = (typeof AGENT_CLIENT_SUPPORT_LEVELS)[number];

type AgentClientCapabilitySupport = Readonly<{
  level: AgentClientSupportLevel;
}>;

type AgentClientCapabilityMap = Readonly<
  Record<AgentClientCapabilityId, AgentClientCapabilitySupport>
>;

function isAgentClientId(value: unknown): value is AgentClientId {
  return typeof value === 'string'
    && (AGENT_CLIENT_IDS as readonly string[]).includes(value);
}

export {
  AGENT_CLIENT_IDS,
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_SUPPORT_LEVELS,
  isAgentClientId
};
export type {
  AgentClientId,
  AgentClientConfig,
  AgentClientsConfig,
  AgentClientState,
  AgentClientCapabilityId,
  AgentClientSupportLevel,
  AgentClientCapabilitySupport,
  AgentClientCapabilityMap
};
