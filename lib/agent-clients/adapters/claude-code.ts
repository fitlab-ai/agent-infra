import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';
import {
  claudeCodeBeforeContainerCreateHook,
  claudeCodeBeforeEnterHook,
  claudeCodeCredentialPreflightHook
} from './claude-code-sandbox.ts';

const claudeCodeAdapter = defineAgentClientAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  invocation: '/${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'integrated' },
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
    actualModel: 'host-event',
    actualReasoningEffort: 'spawn-ack'
  },
  project: {
    ownedPathPrefixes: ['.claude/'],
    managed: ['.claude/commands/', '.claude/agents/', '.claude/rules/'],
    merged: ['.claude/settings.json'],
    ejected: [],
    seedCommands: [{
      templates: {
        en: '.claude/commands/update-agent-infra.en.md',
        'zh-CN': '.claude/commands/update-agent-infra.zh-CN.md'
      },
      target: '.claude/commands/update-agent-infra.md'
    }],
    customCommand: {
      target: '.claude/commands/${skillName}.md',
      frontmatter: {},
      includeUsage: true,
      inheritDisableModelInvocation: true
    }
  },
  sandbox: {
    image: {
      dockerfileFragment: 'claude-code'
    },
    createTool: ({ home, project }) => ({
      id: 'claude-code',
      name: 'Claude Code',
      install: { type: 'npm', cmd: '@anthropic-ai/claude-code@latest' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'claude-code'),
      containerMount: '/home/devuser/.claude',
      versionCmd: 'claude --version',
      setupHint: 'Authenticates via host credentials live-mounted at ~/.claude/.credentials.json',
      envVars: { CLAUDE_CONFIG_DIR: '/home/devuser/.claude' },
      hostPreSeedDirs: [
        { hostDir: hostJoin(home, '.claude', 'plugins'), sandboxSubdir: 'plugins' }
      ],
      pathRewriteFiles: [
        'plugins/installed_plugins.json',
        'plugins/known_marketplaces.json'
      ],
      hostLiveMounts: [
        {
          hostPath: hostJoin(
            home,
            '.agent-infra',
            'credentials',
            project,
            'claude-code',
            '.credentials.json'
          ),
          containerSubpath: '.credentials.json'
        }
      ]
    }),
    aliases: [
      { name: 'claude-yolo', command: 'claude --dangerously-skip-permissions; tput ed' },
      { name: 'cy', command: 'claude --dangerously-skip-permissions; tput ed' }
    ],
    hooks: [
      claudeCodeCredentialPreflightHook,
      claudeCodeBeforeContainerCreateHook,
      claudeCodeBeforeEnterHook
    ]
  }
});

export { claudeCodeAdapter };
