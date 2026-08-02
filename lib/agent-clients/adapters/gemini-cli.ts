import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';

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
    ejected: [],
    seedCommands: [{
      templates: {
        en: '.gemini/commands/_project_/update-agent-infra.en.toml',
        'zh-CN': '.gemini/commands/_project_/update-agent-infra.zh-CN.toml'
      },
      target: '.gemini/commands/${projectName}/update-agent-infra.toml'
    }]
  },
  sandbox: {
    createTool: ({ home }) => ({
      id: 'gemini-cli',
      name: 'Gemini CLI',
      install: { type: 'npm', cmd: '@google/gemini-cli' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'gemini-cli'),
      containerMount: '/home/devuser/.gemini',
      versionCmd: 'gemini --version',
      setupHint: 'Run gemini inside the container to finish authentication.',
      hostLiveMounts: [
        {
          hostPath: hostJoin(home, '.gemini', 'oauth_creds.json'),
          containerSubpath: 'oauth_creds.json'
        }
      ],
      hostPreSeedFiles: [
        {
          hostPath: hostJoin(home, '.gemini', 'settings.json'),
          sandboxName: 'settings.json'
        },
        {
          hostPath: hostJoin(home, '.gemini', 'google_accounts.json'),
          sandboxName: 'google_accounts.json'
        }
      ]
    }),
    aliases: [
      { name: 'gemini-yolo', command: 'gemini --yolo; tput ed' },
      { name: 'gy', command: 'gemini --yolo; tput ed' }
    ],
    hooks: []
  }
});

export { geminiCliAdapter };
