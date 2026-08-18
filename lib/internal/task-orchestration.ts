import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import {
  abortCommitIntent,
  activateMatchingOrchestrationDelegation,
  activateOrchestrationDelegation,
  advanceOrchestration,
  awaitOrchestrationDelegationActivation,
  beginCommitIntent,
  beginOrResumeOrchestration,
  checkpointCommitIntent,
  completeCommitIntent,
  pauseOrchestration,
  recoverCommitIntent,
  recoverPreparedOrchestrationDelegation,
  routeOrchestration,
  sealMatchingOrchestrationDelegation,
  sealOrchestrationDelegation,
  startCommitAttempt,
  statusCommitIntent,
  statusOrchestration,
  terminateCommitAttempt
} from '../task/orchestration.ts';
import { prepareCodexOrchestrationDelegation } from '../task/codex-orchestration.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientId } from '../agent-clients/types.ts';

const USAGE = 'Usage: agent-infra-internal task-orchestration <task-ref|auto> <begin-or-resume|route|prepare|await-activation|recover-prepared|hook-start|hook-stop|advance|pause|status|commit-start|commit-begin|commit-checkpoint|commit-complete|commit-recover|commit-abort|commit-terminate|commit-status> [options]\n';

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
    'begin-or-resume', 'route', 'prepare', 'await-activation', 'recover-prepared',
    'hook-start', 'hook-stop', 'advance', 'pause', 'status',
    'commit-start', 'commit-begin', 'commit-checkpoint', 'commit-complete', 'commit-recover', 'commit-abort', 'commit-terminate', 'commit-status'
  ].includes(intent!)) {
    usageFailure(`unknown intent '${intent}'`);
    return;
  }
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  let orchestrated = false;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--orchestrated') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag);
      orchestrated = true;
      continue;
    }
    if (![
      '--max-steps', '--executor-model', '--executor-reasoning-effort',
      '--reviewer-model', '--reviewer-reasoning-effort',
      '--client', '--requested-model', '--requested-reasoning-effort', '--capability-token',
      '--parent-id', '--before-fingerprint',
      '--stage', '--round', '--artifact', '--role',
      '--native-agent', '--child-id', '--spawn-mode', '--actual-model', '--actual-reasoning-effort',
      '--model-fallback-reason', '--reasoning-effort-fallback-reason',
      '--exit-code', '--after-fingerprint', '--changed-paths', '--code', '--message', '--recoverable', '--agent',
      '--baseline-head', '--token', '--kind', '--head', '--remote', '--ref', '--expected-head'
      , '--attempt', '--git-worktree-root'
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
  const commitIntentFlags: Record<string, readonly string[]> = {
    'commit-start': ['--agent', '--git-worktree-root'],
    'commit-begin': ['--agent', '--baseline-head', '--attempt', '--orchestrated', '--git-worktree-root'],
    'commit-checkpoint': ['--token', '--kind', '--head', '--remote', '--ref', '--git-worktree-root'],
    'commit-complete': ['--token', '--agent', '--git-worktree-root'],
    'commit-recover': ['--agent', '--git-worktree-root'],
    'commit-abort': ['--token', '--expected-head', '--git-worktree-root'],
    'commit-terminate': ['--attempt', '--agent', '--code', '--git-worktree-root'],
    'commit-status': ['--git-worktree-root']
  };
  if (intent! in commitIntentFlags) {
    const allowed = commitIntentFlags[intent!]!;
    const invalid = [...seen].find((flag) => !allowed.includes(flag));
    if (invalid) { usageFailure(`intent '${intent}' does not accept '${invalid}'`); return; }
  } else {
    const commitOnly = [...seen].find((flag) => [
      '--orchestrated', '--baseline-head', '--attempt', '--token', '--kind', '--head', '--remote', '--ref', '--expected-head'
    ].includes(flag));
    if (commitOnly) { usageFailure(`intent '${intent}' does not accept '${commitOnly}'`); return; }
  }
  const requireValues = (flags: string[]) => flags.find((flag) => values[flag] === undefined);
  const coreOptions = values['--git-worktree-root'] === undefined
    ? {}
    : { gitWorktreeRoot: values['--git-worktree-root'] };
  if (values['--client'] !== undefined && !isAgentClientId(values['--client'])) {
    usageFailure(`unknown client '${values['--client']}'`);
    return;
  }
  let result;
  if (intent === 'commit-start') {
    const missing = requireValues(['--agent']);
    if (missing) { usageFailure(`intent 'commit-start' requires '${missing}'`); return; }
    const agent = normalizeAgentToken(values['--agent']!);
    if (!agent) { usageFailure(`invalid --agent '${values['--agent']}': ${AGENT_USAGE_HINT}`); return; }
    result = startCommitAttempt(taskRef!, { agent }, coreOptions);
  } else if (intent === 'commit-begin') {
    const missing = requireValues(['--agent', '--baseline-head', '--attempt']);
    if (missing) { usageFailure(`intent 'commit-begin' requires '${missing}'`); return; }
    const agent = normalizeAgentToken(values['--agent']!);
    if (!agent) { usageFailure(`invalid --agent '${values['--agent']}': ${AGENT_USAGE_HINT}`); return; }
    result = beginCommitIntent(taskRef!, {
      agent, orchestrated, baselineHead: values['--baseline-head']!, attempt: values['--attempt']!
    }, coreOptions);
  } else if (intent === 'commit-checkpoint') {
    const missing = requireValues(['--token', '--kind', '--head']);
    if (missing) { usageFailure(`intent 'commit-checkpoint' requires '${missing}'`); return; }
    if (!['committed', 'pushed'].includes(values['--kind']!)) {
      usageFailure('--kind must be committed or pushed'); return;
    }
    if (values['--kind'] === 'pushed') {
      const pushedMissing = requireValues(['--remote', '--ref']);
      if (pushedMissing) { usageFailure(`pushed checkpoint requires '${pushedMissing}'`); return; }
    } else if (values['--remote'] !== undefined || values['--ref'] !== undefined) {
      usageFailure('committed checkpoint does not accept --remote or --ref'); return;
    }
    result = checkpointCommitIntent(taskRef!, {
      token: values['--token']!, kind: values['--kind'] as 'committed' | 'pushed',
      head: values['--head']!, remote: values['--remote'], ref: values['--ref']
    }, coreOptions);
  } else if (intent === 'commit-complete') {
    const missing = requireValues(['--token', '--agent']);
    if (missing) { usageFailure(`intent 'commit-complete' requires '${missing}'`); return; }
    const agent = normalizeAgentToken(values['--agent']!);
    if (!agent) { usageFailure(`invalid --agent '${values['--agent']}': ${AGENT_USAGE_HINT}`); return; }
    result = completeCommitIntent(taskRef!, { token: values['--token']!, agent }, coreOptions);
  } else if (intent === 'commit-recover') {
    const missing = requireValues(['--agent']);
    if (missing) { usageFailure(`intent 'commit-recover' requires '${missing}'`); return; }
    const agent = normalizeAgentToken(values['--agent']!);
    if (!agent) { usageFailure(`invalid --agent '${values['--agent']}': ${AGENT_USAGE_HINT}`); return; }
    result = recoverCommitIntent(taskRef!, { agent }, coreOptions);
  } else if (intent === 'commit-abort') {
    const missing = requireValues(['--token', '--expected-head']);
    if (missing) { usageFailure(`intent 'commit-abort' requires '${missing}'`); return; }
    result = abortCommitIntent(taskRef!, { token: values['--token']!, expectedHead: values['--expected-head']! }, coreOptions);
  } else if (intent === 'commit-terminate') {
    const missing = requireValues(['--attempt', '--agent', '--code']);
    if (missing) { usageFailure(`intent 'commit-terminate' requires '${missing}'`); return; }
    const agent = normalizeAgentToken(values['--agent']!);
    if (!agent) { usageFailure(`invalid --agent '${values['--agent']}': ${AGENT_USAGE_HINT}`); return; }
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(values['--code']!)) {
      usageFailure('--code must be a stable uppercase identifier'); return;
    }
    result = terminateCommitAttempt(taskRef!, {
      attempt: values['--attempt']!, agent, code: values['--code']!
    }, coreOptions);
  } else if (intent === 'commit-status') {
    result = statusCommitIntent(taskRef!, coreOptions);
  } else if (intent === 'begin-or-resume') {
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
    result = beginOrResumeOrchestration(taskRef!, {
      ...coreOptions,
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
        }
      } : undefined
    });
  } else if (intent === 'route') {
    result = routeOrchestration(taskRef!, coreOptions);
  } else if (intent === 'status') {
    result = statusOrchestration(taskRef!, coreOptions);
  } else if (intent === 'prepare') {
    const missing = requireValues(['--client']);
    if (missing) { usageFailure(`intent 'prepare' requires '${missing}'`); return; }
    result = await prepareCodexOrchestrationDelegation(taskRef!, {
      client: values['--client'] as AgentClientId,
      requestedModel: values['--requested-model'],
      requestedReasoningEffort: values['--requested-reasoning-effort'],
      capabilityToken: values['--capability-token']
    }, { orchestrationOptions: coreOptions });
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
    result = await awaitOrchestrationDelegationActivation(taskRef!, {
      stage: values['--stage'] as Parameters<typeof awaitOrchestrationDelegationActivation>[1]['stage'],
      round,
      artifact: values['--artifact']!,
      role: values['--role'] as 'executor' | 'reviewer'
    }, coreOptions);
  } else if (intent === 'recover-prepared') {
    result = recoverPreparedOrchestrationDelegation(taskRef!, coreOptions);
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
      ? activateMatchingOrchestrationDelegation(values['--client'] as AgentClientId, event, coreOptions)
      : activateOrchestrationDelegation(taskRef!, event, coreOptions);
  } else if (intent === 'hook-stop') {
    if (taskRef === 'auto') {
      const missing = requireValues(['--client', '--native-agent', '--child-id']);
      if (missing) { usageFailure(`intent 'hook-stop' requires '${missing}'`); return; }
      result = sealMatchingOrchestrationDelegation(values['--client'] as AgentClientId, {
        nativeAgent: values['--native-agent']!, childId: values['--child-id']!
      }, coreOptions);
    } else {
      const missing = requireValues(['--child-id', '--exit-code', '--after-fingerprint']);
      if (missing) { usageFailure(`intent 'hook-stop' requires '${missing}'`); return; }
      const exitCode = Number(values['--exit-code']);
      if (!Number.isInteger(exitCode)) { usageFailure('--exit-code must be an integer'); return; }
      result = sealOrchestrationDelegation(taskRef!, {
        childId: values['--child-id']!, exitCode,
        afterFingerprint: values['--after-fingerprint']!,
        changedPaths: values['--changed-paths'] ? values['--changed-paths']!.split(',').filter(Boolean) : []
      }, coreOptions);
    }
  } else if (intent === 'advance') {
    result = advanceOrchestration(taskRef!, coreOptions);
  } else {
    const missing = requireValues(['--code', '--message', '--recoverable']);
    if (missing) { usageFailure(`intent 'pause' requires '${missing}'`); return; }
    if (!['true', 'false'].includes(values['--recoverable']!)) { usageFailure('--recoverable must be true or false'); return; }
    result = pauseOrchestration(taskRef!, values['--code']!, values['--message']!, values['--recoverable'] === 'true', coreOptions);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskOrchestration };
