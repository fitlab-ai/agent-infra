import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';

const antigravityCliAdapter = defineAgentClientAdapter({
  id: 'antigravity-cli',
  displayName: 'Antigravity CLI',
  invocation: '/${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'integrated' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    subagents: { level: 'unsupported' },
    orchestration: { level: 'unsupported' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  project: {
    ownedPathPrefixes: [],
    managed: [],
    merged: [],
    ejected: [],
    seedCommands: []
  },
  sandbox: {
    createTool: ({ home }) => ({
      id: 'antigravity-cli',
      name: 'Antigravity CLI',
      install: {
        type: 'shell',
        cmd: 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /home/devuser/.npm-global/bin'
      },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'antigravity-cli'),
      containerMount: '/home/devuser/.gemini',
      versionCmd: 'agy --version',
      setupHint: 'Run agy inside the container to finish authentication.',
      hostPreSeedFiles: [
        {
          hostPath: hostJoin(home, '.gemini', 'antigravity-cli', 'settings.json'),
          sandboxName: 'antigravity-cli/settings.json'
        },
        {
          hostPath: hostJoin(home, '.gemini', 'antigravity-cli', 'keybindings.json'),
          sandboxName: 'antigravity-cli/keybindings.json'
        },
        {
          hostPath: hostJoin(home, '.gemini', 'config', 'mcp_config.json'),
          sandboxName: 'config/mcp_config.json'
        }
      ]
    }),
    aliases: [
      { name: 'antigravity-yolo', command: 'agy --dangerously-skip-permissions; tput ed' },
      { name: 'agy-yolo', command: 'agy --dangerously-skip-permissions; tput ed' }
    ],
    hooks: []
  }
});

export { antigravityCliAdapter };
