import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';
import {
  codexBeforeContainerCreateHook,
  codexRecoveryChecks
} from './codex-sandbox.ts';

const codexAdapter = defineAgentClientAdapter({
  id: 'codex',
  displayName: 'Codex',
  invocation: '$${skillName}',
  capabilities: {
    instructions: { level: 'compatible' },
    skills: { level: 'compatible' },
    commands: { level: 'integrated' },
    hooks: { level: 'integrated' },
    subagents: { level: 'experimental' },
    orchestration: { level: 'unsupported' },
    sandbox: { level: 'integrated' },
    verification: { level: 'compatible' }
  },
  modelSelection: {
    kind: 'interactive-only',
    command: '/model',
    guidance: 'Use the host model picker for the complete model and reasoning-effort catalog.'
  },
  delegationEvidence: {
    actualModel: 'app-server',
    actualReasoningEffort: 'app-server'
  },
  project: {
    ownedPathPrefixes: ['.codex/'],
    managed: ['.codex/hooks.json', '.codex/agents/'],
    merged: [],
    ejected: [],
    seedCommands: []
  },
  sandbox: {
    createTool: ({ home }) => ({
      id: 'codex',
      name: 'Codex',
      install: { type: 'npm', cmd: '@openai/codex' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'codex'),
      containerMount: '/home/devuser/.codex',
      versionCmd: 'codex --version',
      setupHint: 'Run codex once inside the container and choose Device Code login if needed.',
      tmpfs: { size: '512m', seed: ['config.toml', 'model-catalogs'] },
      hostLiveMounts: [
        {
          hostPath: hostJoin(home, '.codex', 'auth.json'),
          containerSubpath: 'auth.json'
        }
      ],
      postSetupCmds: [
        'test -d /workspace/.codex/commands && ln -sfn /workspace/.codex/commands /home/devuser/.codex/prompts || true'
      ]
    }),
    aliases: [
      { name: 'codex-yolo', command: 'codex --yolo; tput ed' },
      { name: 'xy', command: 'codex --yolo; tput ed' }
    ],
    hooks: [codexBeforeContainerCreateHook],
    recoveryChecks: codexRecoveryChecks
  }
});

export { codexAdapter };
