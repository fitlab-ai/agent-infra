import { defineAgentClientAdapter } from '../adapter.ts';
import { hostJoin } from '../../sandbox/engines/wsl2-paths.ts';
import {
  codexBeforeContainerCreateHook,
  codexRecoveryChecks
} from './codex-sandbox.ts';
import { parseCodexLifecycleBinding } from './codex-lifecycle/binding.ts';

function codexCarrierError(code: string): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}

function codexLaunchCarrier(
  adapterContext: string,
  identity: Readonly<{ stage: string; round: number; role: string }>
): Readonly<Record<string, string>> {
  if (!Number.isSafeInteger(identity.round) || identity.round < 1
    || !/^[a-z-]+$/u.test(identity.stage) || !/^[a-z-]+$/u.test(identity.role)) {
    throw codexCarrierError('CODEX_LIFECYCLE_SPAWN_IDENTITY_INVALID');
  }
  const label = `${identity.stage.replaceAll('-', '_')}_${identity.role.replaceAll('-', '_')}_r${identity.round}`;
  const taskName = `${label}${adapterContext}`;
  const parsed = parseCodexLifecycleBinding(taskName);
  if (!parsed) throw codexCarrierError('CODEX_LIFECYCLE_LAUNCH_CONTEXT_INVALID');
  return Object.freeze({ task_name: parsed.taskName });
}

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
    actualModel: 'app-server',
    actualReasoningEffort: 'app-server'
  },
  orchestrationAdapter: {
    createLaunchCarrier: codexLaunchCarrier,
    prepareDelegation: async (...args) => {
      const { prepareCodexOrchestrationDelegation } = await import('../../task/codex-orchestration.ts');
      return prepareCodexOrchestrationDelegation(...args);
    },
    recoverStarted: async (...args) => {
      const { recoverStartedLifecycleFromAdapter } = await import('./codex-lifecycle/recovery.ts');
      return recoverStartedLifecycleFromAdapter(...args);
    }
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
      tmpfs: { size: '512m', seed: ['config.toml', 'model-catalogs'], exec: true },
      hostStateMounts: [{
        hostSubdir: 'packages/app-server-daemon',
        containerSubpath: 'packages/app-server-daemon'
      }],
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
