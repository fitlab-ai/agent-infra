import { defineAgentClientAdapter } from '../adapter.ts';

const codexAdapter = defineAgentClientAdapter({
  id: 'codex',
  displayName: 'Codex',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'integrated' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: ['.codex/'],
    managed: ['.codex/hooks.json'],
    merged: [],
    ejected: []
  }
});

export { codexAdapter };
