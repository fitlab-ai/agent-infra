import { OrchestrationStateError } from '../task/orchestration.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientId } from '../agent-clients/types.ts';
import {
  createDirectHostExecutionContext,
  dispatchTaskControlOperation
} from '../task/control-authority.ts';
import { detectRepoRoot } from '../task/resolve-ref.ts';

const USAGE = 'Usage: agent-infra-internal task-orchestration <task-ref|auto> <begin-or-resume|route|prepare|dispatch|await-activation|recover-prepared|hook-start|hook-stop|advance|pause|status> [options]\n';

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed', changed: false,
    error: { code: 'ORCHESTRATION_PAYLOAD_INVALID', message }
  })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

async function taskOrchestration(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length < 2) {
    usageFailure('task ref and intent are required');
    return;
  }
  const [taskRef, intent] = args;
  if (![
    'begin-or-resume', 'route', 'prepare', 'dispatch', 'await-activation', 'recover-prepared',
    'hook-start', 'hook-stop', 'advance', 'pause', 'status'
  ].includes(intent!)) {
    usageFailure(`unknown intent '${intent}'`);
    return;
  }
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (![
      '--max-steps', '--executor-model', '--executor-reasoning-effort',
      '--reviewer-model', '--reviewer-reasoning-effort',
      '--client', '--requested-model', '--requested-reasoning-effort', '--capability-token',
      '--parent-id', '--before-fingerprint',
      '--stage', '--round', '--artifact', '--role',
      '--native-agent', '--child-id', '--spawn-mode', '--actual-model', '--actual-reasoning-effort',
      '--model-fallback-reason', '--reasoning-effort-fallback-reason',
      '--exit-code', '--after-fingerprint', '--changed-paths', '--code', '--message', '--recoverable', '--agent',
      '--git-worktree-root'
    ].includes(flag)) {
      usageFailure(`unknown option '${flag}'`);
      return;
    }
    if (seen.has(flag)) {
      usageFailure(`duplicate option '${flag}'`);
      return;
    }
    seen.add(flag);
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      usageFailure(`option '${flag}' requires a value`);
      return;
    }
    values[flag] = value;
  }
  const requireValues = (flags: string[]) => flags.find((flag) => values[flag] === undefined);
  const coreOptions = values['--git-worktree-root'] === undefined
    ? {}
    : { gitWorktreeRoot: values['--git-worktree-root'] };
  let repoRoot = process.cwd();
  try { repoRoot = detectRepoRoot(); } catch { /* domain resolution reports the repository error */ }
  const context = createDirectHostExecutionContext({
    repoRoot,
    ...(process.env.AGENT_INFRA_RUNTIME_DIR ? { runtimeDir: process.env.AGENT_INFRA_RUNTIME_DIR } : {})
  });
  if (values['--client'] !== undefined && !isAgentClientId(values['--client'])) {
    usageFailure(`unknown client '${values['--client']}'`);
    return;
  }
  let result;
  try {
  if (intent === 'begin-or-resume') {
    const missing = requireValues(['--client']);
    if (missing) { usageFailure(`intent 'begin-or-resume' requires '${missing}'`); return; }
    const maxSteps = values['--max-steps'] === undefined ? undefined : Number(values['--max-steps']);
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
      usageFailure('--max-steps must be a positive integer'); return;
    }
    const policyFlags = [
      '--executor-model', '--executor-reasoning-effort',
      '--reviewer-model', '--reviewer-reasoning-effort'
    ];
    const hasAnyPolicy = policyFlags.some((flag) => values[flag] !== undefined);
    if (hasAnyPolicy && policyFlags.some((flag) => values[flag] === undefined)) {
      usageFailure('explicit model policy requires executor/reviewer model and reasoning effort');
      return;
    }
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'begin-or-resume',
      input: {
        client: values['--client'] as AgentClientId,
        maxSteps,
        modelPolicy: hasAnyPolicy ? {
          executor: {
            model: values['--executor-model']!,
            reasoningEffort: values['--executor-reasoning-effort']!
          },
          reviewer: {
            model: values['--reviewer-model']!,
            reasoningEffort: values['--reviewer-reasoning-effort']!
          }
        } : undefined
      },
      options: coreOptions
    });
  } else if (intent === 'route') {
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'route', input: {}, options: coreOptions
    });
  } else if (intent === 'status') {
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'status', input: {}, options: coreOptions
    });
  } else if (intent === 'prepare') {
    const missing = requireValues(['--client']);
    if (missing) { usageFailure(`intent 'prepare' requires '${missing}'`); return; }
    result = await dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'prepare',
      input: {
        client: values['--client'] as AgentClientId,
        requestedModel: values['--requested-model'],
        requestedReasoningEffort: values['--requested-reasoning-effort'],
        capabilityToken: values['--capability-token']
      },
      options: coreOptions
    });
  } else if (intent === 'dispatch') {
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'dispatch', input: {}, options: coreOptions
    });
  } else if (intent === 'await-activation') {
    const missing = requireValues(['--stage', '--round', '--artifact', '--role']);
    if (missing) { usageFailure(`intent 'await-activation' requires '${missing}'`); return; }
    const round = Number(values['--round']);
    if (!Number.isSafeInteger(round) || round < 1) {
      usageFailure('--round must be a positive integer'); return;
    }
    if (!['executor', 'reviewer'].includes(values['--role']!)) {
      usageFailure('--role must be executor or reviewer'); return;
    }
    result = await dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'await-activation',
      input: {
        event: {
          stage: values['--stage'],
          round,
          artifact: values['--artifact']!,
          role: values['--role'] as 'executor' | 'reviewer'
        }
      },
      options: coreOptions
    });
  } else if (intent === 'recover-prepared') {
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'recover-prepared', input: {}, options: coreOptions
    });
  } else if (intent === 'hook-start') {
    const missing = requireValues([
      ...(taskRef === 'auto' ? ['--client'] : []),
      '--native-agent', '--child-id', '--parent-id'
    ]);
    if (missing) { usageFailure(`intent 'hook-start' requires '${missing}'`); return; }
    const event = {
      nativeAgent: values['--native-agent']!, childId: values['--child-id']!,
      parentId: values['--parent-id']!, spawnMode: values['--spawn-mode'],
      actualModel: values['--actual-model'],
      actualReasoningEffort: values['--actual-reasoning-effort'],
      modelFallbackReason: values['--model-fallback-reason'],
      reasoningEffortFallbackReason: values['--reasoning-effort-fallback-reason']
    };
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'hook-start',
      input: { auto: taskRef === 'auto', client: values['--client'] as AgentClientId, event }, options: coreOptions
    });
  } else if (intent === 'hook-stop') {
    if (taskRef === 'auto') {
      const missing = requireValues(['--client', '--native-agent', '--child-id']);
      if (missing) { usageFailure(`intent 'hook-stop' requires '${missing}'`); return; }
      result = dispatchTaskControlOperation(context, {
        family: 'task-orchestration', taskRef: taskRef!, intent: 'hook-stop',
        input: {
          auto: true,
          client: values['--client'] as AgentClientId,
          event: {
            nativeAgent: values['--native-agent']!, childId: values['--child-id']!,
            actualModel: values['--actual-model'],
            actualReasoningEffort: values['--actual-reasoning-effort'],
            modelFallbackReason: values['--model-fallback-reason'],
            reasoningEffortFallbackReason: values['--reasoning-effort-fallback-reason']
          }
        },
        options: coreOptions
      });
    } else {
      const missing = requireValues(['--child-id', '--exit-code', '--after-fingerprint']);
      if (missing) { usageFailure(`intent 'hook-stop' requires '${missing}'`); return; }
      const exitCode = Number(values['--exit-code']);
      if (!Number.isInteger(exitCode)) { usageFailure('--exit-code must be an integer'); return; }
      result = dispatchTaskControlOperation(context, {
        family: 'task-orchestration', taskRef: taskRef!, intent: 'hook-stop',
        input: {
          auto: false,
          event: {
            childId: values['--child-id']!, exitCode,
            afterFingerprint: values['--after-fingerprint']!,
            changedPaths: values['--changed-paths'] ? values['--changed-paths']!.split(',').filter(Boolean) : [],
            actualModel: values['--actual-model'],
            actualReasoningEffort: values['--actual-reasoning-effort'],
            modelFallbackReason: values['--model-fallback-reason'],
            reasoningEffortFallbackReason: values['--reasoning-effort-fallback-reason']
          }
        },
        options: coreOptions
      });
    }
  } else if (intent === 'advance') {
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'advance', input: {}, options: coreOptions
    });
  } else {
    const missing = requireValues(['--code', '--message', '--recoverable']);
    if (missing) { usageFailure(`intent 'pause' requires '${missing}'`); return; }
    if (!['true', 'false'].includes(values['--recoverable']!)) { usageFailure('--recoverable must be true or false'); return; }
    result = dispatchTaskControlOperation(context, {
      family: 'task-orchestration', taskRef: taskRef!, intent: 'pause',
      input: {
        code: values['--code']!, message: values['--message']!, recoverable: values['--recoverable'] === 'true'
      },
      options: coreOptions
    });
  }
  } catch (error) {
    if (!(error instanceof OrchestrationStateError)) throw error;
    result = {
      status: 'failed' as const,
      changed: false,
      taskId: error.taskId,
      run: null,
      next: null,
      error: { code: error.code, message: error.message }
    };
  }
  const output = await result;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.status === 'failed') process.exitCode = 1;
}

export { taskOrchestration };
