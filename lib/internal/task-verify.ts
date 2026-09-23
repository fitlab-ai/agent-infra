import { renderTaskVerification, verifyTaskEvent } from '../task/verification.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-verify <N | TASK-id> <verification-event> [--artifact <canonical.md>] [--format json|text]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'VERIFY_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function taskVerify(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-verify', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!args[0] || !args[1] || args[0].startsWith('--') || args[1].startsWith('--')
    || !internalHandlerRoute('task-verify', 'event', args[1] ? 'event' : '')) { fail('task ref and verification event are required'); return; }
  const taskRef = args[0];
  const event = args[1];
  let artifact: string | undefined;
  let format: 'json' | 'text' = 'json';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--artifact', '--format'].includes(flag)) { fail(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { fail(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { fail(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    if (flag === '--artifact') artifact = value;
    else if (value === 'json' || value === 'text') format = value;
    else { fail("option '--format' requires 'json' or 'text'"); return; }
  }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { fail(resolved.message); return; }
  let result;
  try {
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-verify.${event}`, async () => verifyTaskEvent({ taskRef, event, ...(artifact ? { artifact } : {}) }));
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    fail(`${error.code}: ${error.message}`);
    return;
  }
  process.stdout.write(format === 'text' ? renderTaskVerification(result) : `${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}

export { taskVerify };
