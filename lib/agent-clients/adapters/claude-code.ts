import { defineAgentClientAdapter } from '../adapter.ts';

const claudeCodeAdapter = defineAgentClientAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'integrated' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: ['.claude/'],
    managed: ['.claude/commands/'],
    merged: ['.claude/settings.json'],
    ejected: []
  }
});

export { claudeCodeAdapter };
