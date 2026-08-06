import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import {
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  beginOrResumeOrchestration,
  completeCommitOrchestrationStage,
  pauseOrchestration,
  prepareOrchestrationDelegation,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation,
  statusOrchestration
} from '../task/orchestration.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientId } from '../agent-clients/types.ts';

const USAGE = 'Usage: agent-infra-internal task-orchestration <task-ref|auto> <begin-or-resume|route|prepare|hook-start|stage-completed|hook-stop|advance|pause|status> [options]\n';

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed', changed: false,
    error: { code: 'ORCHESTRATION_PAYLOAD_INVALID', message }
  })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function taskOrchestration(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.length < 2) {
    usageFailure('task ref and intent are required');
    return;
  }
  const [taskRef, intent] = args;
  if (!['begin-or-resume', 'route', 'prepare', 'hook-start', 'stage-completed', 'hook-stop', 'advance', 'pause', 'status'].includes(intent!)) {
    usageFailure(`unknown intent '${intent}'`);
    return;
  }
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (![
      '--max-steps', '--executor-model', '--executor-reasoning-effort',
      '--reviewer-model', '--reviewer-reasoning-effort', '--same-model-reason',
      '--client', '--requested-model', '--requested-reasoning-effort', '--parent-id', '--before-fingerprint',
      '--native-agent', '--child-id', '--spawn-mode', '--actual-model', '--actual-reasoning-effort',
      '--model-fallback-reason', '--reasoning-effort-fallback-reason',
      '--exit-code', '--after-fingerprint', '--changed-paths', '--code', '--message', '--recoverable', '--agent'
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
  if (values['--client'] !== undefined && !isAgentClientId(values['--client'])) {
    usageFailure(`unknown client '${values['--client']}'`);
    return;
  }
  let result;
  if (intent === 'begin-or-resume') {
    const missing = requireValues(['--client']);
    if (missing) { usageFailure(`intent 'begin-or-resume' requires '${missing}'`); return; }
    const maxSteps = values['--max-steps'] === undefined ? undefined : Number(values['--max-steps']);
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
      usageFailure('--max-steps must be a positive integer'); return;
    }
    const policyFlags = [
      '--executor-model', '--executor-reasoning-effort',
      '--reviewer-model', '--reviewer-reasoning-effort', '--same-model-reason'
    ];
    const hasAnyPolicy = policyFlags.some((flag) => values[flag] !== undefined);
    const requiredPolicy = policyFlags.slice(0, 4);
    if (hasAnyPolicy && requiredPolicy.some((flag) => values[flag] === undefined)) {
      usageFailure('explicit model policy requires executor/reviewer model and reasoning effort');
      return;
    }
    result = beginOrResumeOrchestration(taskRef!, {
      maxSteps,
      client: values['--client'] as AgentClientId,
      modelPolicy: hasAnyPolicy ? {
        executor: {
          model: values['--executor-model']!,
          reasoningEffort: values['--executor-reasoning-effort']!
        },
        reviewer: {
          model: values['--reviewer-model']!,
          reasoningEffort: values['--reviewer-reasoning-effort']!
        },
        sameModelReason: values['--same-model-reason'] ?? null
      } : undefined
    });
  } else if (intent === 'route') {
    result = routeOrchestration(taskRef!);
  } else if (intent === 'status') {
    result = statusOrchestration(taskRef!);
  } else if (intent === 'prepare') {
    const missing = requireValues(['--client']);
    if (missing) { usageFailure(`intent 'prepare' requires '${missing}'`); return; }
    result = prepareOrchestrationDelegation(taskRef!, {
      client: values['--client'] as AgentClientId,
      requestedModel: values['--requested-model'],
      requestedReasoningEffort: values['--requested-reasoning-effort']
    });
  } else if (intent === 'hook-start') {
    const missing = requireValues([
      ...(taskRef === 'auto' ? ['--client'] : []),
      '--native-agent', '--child-id', '--parent-id', '--spawn-mode'
    ]);
    if (missing) { usageFailure(`intent 'hook-start' requires '${missing}'`); return; }
    const event = {
      nativeAgent: values['--native-agent']!, childId: values['--child-id']!,
      parentId: values['--parent-id']!, spawnMode: values['--spawn-mode']!,
      actualModel: values['--actual-model'],
      actualReasoningEffort: values['--actual-reasoning-effort'],
      modelFallbackReason: values['--model-fallback-reason'],
      reasoningEffortFallbackReason: values['--reasoning-effort-fallback-reason']
    };
    result = taskRef === 'auto'
      ? activateMatchingOrchestrationDelegation(values['--client'] as AgentClientId, event)
      : activateOrchestrationDelegation(taskRef!, event);
  } else if (intent === 'hook-stop') {
    if (taskRef === 'auto') {
      const missing = requireValues(['--client', '--native-agent', '--child-id']);
      if (missing) { usageFailure(`intent 'hook-stop' requires '${missing}'`); return; }
      result = sealMatchingOrchestrationDelegation(values['--client'] as AgentClientId, {
        nativeAgent: values['--native-agent']!, childId: values['--child-id']!
      });
    } else {
      const missing = requireValues(['--child-id', '--exit-code', '--after-fingerprint']);
      if (missing) { usageFailure(`intent 'hook-stop' requires '${missing}'`); return; }
      const exitCode = Number(values['--exit-code']);
      if (!Number.isInteger(exitCode)) { usageFailure('--exit-code must be an integer'); return; }
      result = sealOrchestrationDelegation(taskRef!, {
        childId: values['--child-id']!, exitCode,
        afterFingerprint: values['--after-fingerprint']!,
        changedPaths: values['--changed-paths'] ? values['--changed-paths']!.split(',').filter(Boolean) : []
      });
    }
  } else if (intent === 'stage-completed') {
    const missing = requireValues(['--agent']);
    if (missing) { usageFailure(`intent 'stage-completed' requires '${missing}'`); return; }
    const agent = normalizeAgentToken(values['--agent']!);
    if (!agent) { usageFailure(`invalid --agent '${values['--agent']}': ${AGENT_USAGE_HINT}`); return; }
    result = completeCommitOrchestrationStage(taskRef!, agent);
  } else if (intent === 'advance') {
    result = advanceOrchestration(taskRef!);
  } else {
    const missing = requireValues(['--code', '--message', '--recoverable']);
    if (missing) { usageFailure(`intent 'pause' requires '${missing}'`); return; }
    if (!['true', 'false'].includes(values['--recoverable']!)) { usageFailure('--recoverable must be true or false'); return; }
    result = pauseOrchestration(taskRef!, values['--code']!, values['--message']!, values['--recoverable'] === 'true');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskOrchestration };
