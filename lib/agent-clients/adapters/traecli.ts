import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';

const traecliAdapter = defineAgentClientAdapter({
  id: 'traecli',
  displayName: 'TraeCode CLI',
  invocation: '/${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    subagents: { level: 'experimental' },
    orchestration: { level: 'experimental' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  modelSelection: {
    kind: 'interactive-only',
    command: '/model',
    guidance: 'Use the host model picker for the complete model and reasoning-effort catalog.'
  },
  delegationEvidence: {
    actualModel: 'unavailable',
    actualReasoningEffort: 'unavailable'
  },
  project: {
    ownedPathPrefixes: ['.traecli/'],
    managed: ['.traecli/commands/'],
    merged: [],
    ejected: [],
    seedCommands: [{
      templates: {
        en: '.traecli/commands/update-agent-infra.en.md',
        'zh-CN': '.traecli/commands/update-agent-infra.zh-CN.md'
      },
      target: '.traecli/commands/update-agent-infra.md'
    }],
    customCommand: {
      target: '.traecli/commands/${skillName}.md',
      frontmatter: {},
      argumentsToken: '$ARGUMENTS'
    }
  },
  sandbox: {
    createTool: ({ home }) => ({
      id: 'traecli',
      name: 'TraeCode CLI',
      install: {
        type: 'shell',
        cmd: 'curl -fsSL https://trae.cn/trae-cli/install_v2.sh | bash'
      },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'traecli'),
      containerMount: '/home/devuser/.trae',
      versionCmd: 'traecli --version',
      setupHint: 'Run traecli login inside the container to authenticate.'
    }),
    aliases: [
      { name: 'traecli-yolo', command: 'traecli --dangerously-bypass-approvals-and-sandbox; tput ed' },
      { name: 'ty', command: 'traecli --dangerously-bypass-approvals-and-sandbox; tput ed' }
    ],
    hooks: []
  }
});

export { traecliAdapter };
