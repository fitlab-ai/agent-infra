import { renderTaskVerification, verifyTaskEvent } from '../task/verification.ts';
import { consumeHumanOverride, failureId } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

const USAGE = 'Usage: agent-infra-internal task-verify <N | TASK-id> <verification-event> [--artifact <canonical.md>] [--format json|text] [--override-ticket <ticket> --override-target <target> --override-scope <scope>]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'VERIFY_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskVerify(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!args[0] || !args[1] || args[0].startsWith('--') || args[1].startsWith('--')) { fail('task ref and verification event are required'); return; }
  const taskRef = args[0];
  const event = args[1];
  let artifact: string | undefined;
  let format: 'json' | 'text' = 'json';
  let overrideTicket: string | undefined;
  let overrideTarget: string | undefined;
  let overrideScope: string | undefined;
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--artifact', '--format', '--override-ticket', '--override-target', '--override-scope'].includes(flag)) { fail(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { fail(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { fail(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    if (flag === '--artifact') artifact = value;
    else if (flag === '--override-ticket') overrideTicket = value;
    else if (flag === '--override-target') overrideTarget = value;
    else if (flag === '--override-scope') overrideScope = value;
    else if (value === 'json' || value === 'text') format = value;
    else { fail("option '--format' requires 'json' or 'text'"); return; }
  }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { fail(resolved.message); return; }
  let result;
  let humanOverride: unknown = null;
  try {
    result = withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-verify.${event}`, () => {
      let current = verifyTaskEvent({ taskRef, event, ...(artifact ? { artifact } : {}) });
      if (current.status === 'pass' || !overrideTicket) return current;
      if (!overrideTarget || !overrideScope) { fail('override ticket requires target and scope'); return current; }
      const failureProducer = current.status === 'blocked' || current.status === 'fail'
        ? 'verification-engine'
        : 'task-verify';
      const failureCode = current.status === 'blocked'
        ? 'CHECK_BLOCKED'
        : current.status === 'fail'
          ? 'CHECK_FAILED'
          : current.error?.code ?? 'VERIFY_TASK_STATE_MISMATCH';
      const consumed = consumeHumanOverride({
        taskRef, ticketId: overrideTicket,
        failureId: failureId(failureProducer, failureCode),
        target: overrideTarget, scope: overrideScope
      }, {
        effectExecutor: (capability) => {
          const retried = verifyTaskEvent({ taskRef, event, ...(artifact ? { artifact } : {}) }, { manualOverride: capability });
          current = retried;
          return retried.status !== 'pass'
            ? { code: 'OVERRIDE_EFFECT_FAILED', message: `${retried.error?.code ?? 'VERIFY_FAILED'}: ${retried.error?.message ?? 'manual verification effect failed'}` }
            : null;
        }
      });
      humanOverride = consumed;
      return current;
    });
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    fail(`${error.code}: ${error.message}`);
    return;
  }
  if (humanOverride) result = { ...result, humanOverride } as typeof result;
  process.stdout.write(format === 'text' ? renderTaskVerification(result) : `${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}

export { taskVerify };
