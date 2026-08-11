import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';
import {
  opencodeBeforeContainerCreateHook,
  opencodeRecoveryChecks
} from './opencode-sandbox.ts';

const YOLO_PERMISSION = '{"*":"allow","read":"allow","bash":"allow","edit":"allow","webfetch":"allow","external_directory":"allow","doom_loop":"allow"}';

const opencodeAdapter = defineAgentClientAdapter({
  id: 'opencode',
  displayName: 'OpenCode',
  invocation: '/${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'compatible' },
    subagents: { level: 'unsupported' },
    orchestration: { level: 'unsupported' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  modelSelection: {
    kind: 'interactive-only',
    command: '/models',
    guidance: 'Use the host model picker for the complete model and reasoning-effort catalog.'
  },
  delegationEvidence: {
    actualModel: 'unavailable',
    actualReasoningEffort: 'unavailable'
  },
  project: {
    ownedPathPrefixes: ['.opencode/'],
    managed: ['.opencode/commands/'],
    merged: [],
    ejected: [],
    seedCommands: [{
      templates: {
        en: '.opencode/commands/update-agent-infra.en.md',
        'zh-CN': '.opencode/commands/update-agent-infra.zh-CN.md'
      },
      target: '.opencode/commands/update-agent-infra.md'
    }],
    customCommand: {
      target: '.opencode/commands/${skillName}.md',
      frontmatter: { agent: 'general', subtask: false },
      argumentsToken: '$ARGUMENTS'
    }
  },
  sandbox: {
    image: {
      dotfilesExclusions: ['.config/opencode']
    },
    createTool: ({ home }) => ({
      id: 'opencode',
      name: 'OpenCode',
      install: { type: 'npm', cmd: 'opencode-ai' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'opencode'),
      containerMount: '/home/devuser/.local/share/opencode',
      versionCmd: 'opencode --version',
      setupHint: 'Configure OpenCode credentials inside the container before first use.',
      envVars: {
        XDG_DATA_HOME: '/home/devuser/.local/share',
        XDG_CONFIG_HOME: '/home/devuser/.local/share/opencode/.xdg/config',
        XDG_STATE_HOME: '/home/devuser/.local/share/opencode/.xdg/state'
      },
      hostLiveMounts: [
        {
          hostPath: hostJoin(home, '.local', 'share', 'opencode', 'auth.json'),
          containerSubpath: 'auth.json'
        }
      ]
    }),
    aliases: [
      {
        name: 'opencode-yolo',
        command: `OPENCODE_PERMISSION='${YOLO_PERMISSION}' opencode; tput ed`
      },
      {
        name: 'oy',
        command: `OPENCODE_PERMISSION='${YOLO_PERMISSION}' opencode; tput ed`
      }
    ],
    hooks: [opencodeBeforeContainerCreateHook],
    recoveryChecks: opencodeRecoveryChecks
  }
});

export { opencodeAdapter };
