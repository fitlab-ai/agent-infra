import { defineAgentClientAdapter } from '../adapter.ts';

const opencodeAdapter = defineAgentClientAdapter({
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: ['.opencode/']
  }
});

export { opencodeAdapter };
