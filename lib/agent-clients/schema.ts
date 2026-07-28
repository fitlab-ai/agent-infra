import {
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_IDS,
  AGENT_CLIENT_SUPPORT_LEVELS
} from './types.ts';

const AGENT_CLIENTS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['agentClients'],
  properties: {
    agentClients: {
      type: 'array',
      minItems: AGENT_CLIENT_IDS.length,
      maxItems: AGENT_CLIENT_IDS.length,
      uniqueItems: true,
      description: 'Canonical Agent Client configuration. Object ID completeness and uniqueness are enforced by the runtime normalizer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'enabled', 'installInSandbox'],
        properties: {
          id: {
            type: 'string',
            enum: [...AGENT_CLIENT_IDS]
          },
          enabled: {
            type: 'boolean'
          },
          installInSandbox: {
            type: 'boolean'
          }
        }
      }
    },
    customTUIs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name', 'dir', 'invoke'],
        properties: {
          name: { type: 'string' },
          dir: { type: 'string' },
          invoke: { type: 'string' }
        }
      }
    }
  },
  definitions: {
    agentClientCapabilityId: {
      type: 'string',
      enum: [...AGENT_CLIENT_CAPABILITY_IDS]
    },
    agentClientSupportLevel: {
      type: 'string',
      enum: [...AGENT_CLIENT_SUPPORT_LEVELS]
    }
  }
} as const;

export { AGENT_CLIENTS_SCHEMA };
