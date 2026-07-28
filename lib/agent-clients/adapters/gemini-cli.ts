import { defineAgentClientAdapter } from '../adapter.ts';

const geminiCliAdapter = defineAgentClientAdapter({
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  invocation: '/${projectName}:${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: ['.gemini/'],
    managed: ['.gemini/commands/'],
    merged: ['.gemini/settings.json'],
    ejected: []
  }
});

export { geminiCliAdapter };
