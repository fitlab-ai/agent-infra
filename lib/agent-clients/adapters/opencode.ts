import { defineAgentClientAdapter } from '../adapter.ts';

const opencodeAdapter = defineAgentClientAdapter({
  id: 'opencode',
  displayName: 'OpenCode',
  invocation: '/${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: ['.opencode/'],
    managed: ['.opencode/commands/'],
    merged: [],
    ejected: []
  }
});

export { opencodeAdapter };
