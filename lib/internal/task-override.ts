import {
  consumeHumanOverride,
  diagnoseHumanOverrideForTask,
  issueHumanOverride
} from '../task/human-override.ts';
import type { ConsumeHumanOverrideRequest, HumanOverrideRequest } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

const USAGE = `Usage: agent-infra-internal task-override <task-ref> <diagnose|issue|consume> [options]

Options: --failure-id <id> --target <target> --operator <operator> --reason <reason> --scope <scope>
         --intent <lifecycle-intent> --alert-number <N> --issue-number <N> --staging-dir <path>
         --expires-at <timestamp> --ticket <ticket-id> --pr-number <N>
`;

const FLAGS: Record<string, string> = {
  '--failure-id': 'failureId',
  '--target': 'target',
  '--operator': 'operator',
  '--reason': 'reason',
  '--scope': 'scope',
  '--intent': 'intent',
  '--failure-digest': 'failureDigest',
  '--expires-at': 'expiresAt',
  '--ticket': 'ticketId',
  '--facts': 'observedFacts',
  '--alert-number': 'alertNumber',
  '--issue-number': 'issueNumber',
  '--pr-number': 'pullRequestNumber',
  '--staging-dir': 'stagingDir'
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'OVERRIDE_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskOverride(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, operation] = args;
  if (!taskRef || !operation || !['diagnose', 'issue', 'consume'].includes(operation)) {
    usageFailure('task ref and a valid operation are required');
    return;
  }
  const values: Record<string, unknown> = { taskRef };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    values[key] = key === 'observedFacts' ? value.split(',').map((fact) => fact.trim()).filter(Boolean)
      : key === 'alertNumber' || key === 'issueNumber' || key === 'pullRequestNumber' ? Number(value) : value;
  }

  const required: Record<string, string[]> = {
    diagnose: [],
    issue: ['failureId', 'target', 'operator', 'reason', 'scope', 'expiresAt'],
    consume: ['failureId', 'target', 'scope', 'ticketId']
  };
  const missing = required[operation]!.find((key) => values[key] === undefined);
  if (missing) { usageFailure(`${operation} requires '--${missing.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}'`); return; }

  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`);
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    if (operation === 'diagnose') {
      result = diagnoseHumanOverrideForTask(
        taskRef,
        values.failureId ? String(values.failureId) : undefined,
        values.target ? String(values.target) : undefined
      );
    } else if (operation === 'issue') {
      result = withTaskExecutionLock(
        resolved.repoRoot,
        resolved.taskId,
        'task-override.issue',
        () => issueHumanOverride({
          taskRef,
          failureId: String(values.failureId),
          target: String(values.target),
          operator: String(values.operator),
          reason: String(values.reason),
          scope: String(values.scope),
          expiresAt: String(values.expiresAt),
          ...(values.intent ? { intent: String(values.intent) as HumanOverrideRequest['intent'] } : {}),
          ...(values.alertNumber !== undefined ? { alertNumber: Number(values.alertNumber) } : {}),
          ...(values.issueNumber !== undefined ? { issueNumber: Number(values.issueNumber) } : {}),
          ...(values.pullRequestNumber !== undefined ? { pullRequestNumber: Number(values.pullRequestNumber) } : {}),
          ...(values.stagingDir ? { stagingDir: String(values.stagingDir) } : {}),
          ...(values.failureDigest ? { failureDigest: String(values.failureDigest) } : {})
        } satisfies HumanOverrideRequest)
      );
    } else {
        result = withTaskExecutionLock(
        resolved.repoRoot,
        resolved.taskId,
        'task-override.consume',
        () => consumeHumanOverride({
          taskRef,
          ticketId: String(values.ticketId),
          failureId: String(values.failureId),
          target: String(values.target),
          scope: String(values.scope),
          ...(values.intent ? { intent: String(values.intent) as ConsumeHumanOverrideRequest['intent'] } : {}),
          ...(values.alertNumber !== undefined ? { alertNumber: Number(values.alertNumber) } : {}),
          ...(values.issueNumber !== undefined ? { issueNumber: Number(values.issueNumber) } : {}),
          ...(values.pullRequestNumber !== undefined ? { pullRequestNumber: Number(values.pullRequestNumber) } : {}),
          ...(values.stagingDir ? { stagingDir: String(values.stagingDir) } : {}),
          ...(values.failureDigest ? { failureDigest: String(values.failureDigest) } : {}),
          ...(values.observedFacts ? { observedFacts: values.observedFacts as string[] } : {})
        } satisfies ConsumeHumanOverrideRequest)
      );
    }
  } catch (cause) {
    if (cause instanceof TaskExecutionLockError) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: cause.code, message: cause.message } })}\n`);
      process.exitCode = 1;
      return;
    }
    throw cause;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskOverride };
