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
      additionalItems: false,
      items: AGENT_CLIENT_IDS.map((id) => ({
        type: 'object',
        additionalProperties: false,
        required: ['id', 'enabled', 'installInSandbox'],
        properties: {
          id: {
            const: id,
            type: 'string'
          },
          enabled: {
            type: 'boolean'
          },
          installInSandbox: {
            type: 'boolean'
          },
          orchestration: {
            type: 'object',
            additionalProperties: false,
            required: ['executor', 'reviewer'],
            properties: {
              executor: { $ref: '#/definitions/orchestrationRolePolicy' },
              reviewer: { $ref: '#/definitions/orchestrationRolePolicy' }
            }
          }
        }
      }))
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
    orchestrationRolePolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'reasoningEffort'],
      properties: {
        model: { type: 'string', minLength: 1 },
        reasoningEffort: { type: 'string', minLength: 1 }
      }
    },
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
