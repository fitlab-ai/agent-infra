import { normalizeAgentToken, AGENT_USAGE_HINT } from '../agent-clients/tokens.ts';
import { consumeHumanOverride, failureId, overrideDryRunConflict } from '../task/human-override.ts';
import { applyTaskLifecycle, lifecycleIntentCatalog } from '../task/lifecycle.ts';
import type { TaskLifecycleRequest } from '../task/lifecycle.ts';
import { detectRepoRoot, resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

const USAGE = `Usage: agent-infra-internal task-lifecycle <N | TASK-id> <intent> --agent <agent> [intent flags] [--dry-run]\n\nIntents: ${lifecycleIntentCatalog.join(', ')}\nOverride: --override-ticket <ticket> --override-target <target> --override-scope <scope>\n`;
const FLAGS: Record<string, string> = {
  '--agent': 'agent', '--reason': 'reason', '--unblock-condition': 'unblockCondition',
  '--note': 'note', '--alert-number': 'alertNumber', '--staging-dir': 'stagingDir',
  '--issue-number': 'issueNumber', '--override-ticket': 'overrideTicket',
  '--override-target': 'overrideTarget', '--override-scope': 'overrideScope'
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'LIFECYCLE_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskLifecycle(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length < 2) { usageFailure('task ref and intent are required'); return; }
  const values: Record<string, unknown> = { taskRef: args[0], intent: args[1], agent: '' };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag); values.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    values[key] = key === 'alertNumber' || key === 'issueNumber' ? Number(value) : value;
  }
  const agent = normalizeAgentToken(String(values.agent ?? ''));
  if (!agent) { usageFailure(`invalid --agent '${values.agent}': ${AGENT_USAGE_HINT}`); return; }
  values.agent = agent;
  const dryRunConflict = overrideDryRunConflict(values);
  if (dryRunConflict) { usageFailure(dryRunConflict.message); return; }
  let repoRoot: string;
  let taskId: string;
  if (values.intent === 'restore') {
    // restore's precondition is that the task does NOT exist locally yet (it only lives
    // in a staging dir), so resolveTaskRef's existence check is inapplicable here; identity
    // is guaranteed by applyTaskLifecycle's own full-TASK-id check plus staging validation.
    try {
      repoRoot = detectRepoRoot();
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'REPO_ROOT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } })}\n`);
      process.exitCode = 1;
      return;
    }
    taskId = String(values.taskRef);
  } else {
    const resolved = resolveTaskRef(String(values.taskRef));
    if (!resolved.ok) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`);
      process.exitCode = 1;
      return;
    }
    repoRoot = resolved.repoRoot;
    taskId = resolved.taskId;
  }
  let result: ReturnType<typeof applyTaskLifecycle> & { humanOverride?: unknown };
  try {
    result = withTaskExecutionLock(
      repoRoot,
      taskId,
      `task-lifecycle.${String(values.intent)}`,
      () => {
        const lifecycleResult = applyTaskLifecycle(values as TaskLifecycleRequest);
        if (lifecycleResult.status !== 'failed' || !values.overrideTicket) return lifecycleResult;
        if (!values.overrideTarget || !values.overrideScope) {
          return {
            ...lifecycleResult,
            error: { code: 'OVERRIDE_PAYLOAD_INVALID', message: 'override ticket requires --override-target and --override-scope' }
          };
        }
        const override = consumeHumanOverride({
          taskRef: String(values.taskRef),
          ticketId: String(values.overrideTicket),
          failureId: failureId('lifecycle.apply', lifecycleResult.error?.code ?? 'LIFECYCLE_FAILED'),
          target: String(values.overrideTarget),
          scope: String(values.overrideScope),
          intent: String(values.intent) as TaskLifecycleRequest['intent'],
          ...(values.alertNumber ? { alertNumber: Number(values.alertNumber) } : {}),
          ...(values.issueNumber ? { issueNumber: Number(values.issueNumber) } : {}),
          ...(values.stagingDir ? { stagingDir: String(values.stagingDir) } : {})
        });
        if (override.status === 'failed') return { ...lifecycleResult, humanOverride: override };
        return { ...lifecycleResult, ...override, humanOverride: override, error: null };
      }
    );
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskLifecycle };
