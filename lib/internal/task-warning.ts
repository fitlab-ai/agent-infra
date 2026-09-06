import { applyWorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import type { WorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import { consumeHumanOverride, failureId, overrideDryRunConflict } from '../task/human-override.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-warning <task-ref> <add|set-status|list> [intent flags] [--dry-run]\n`;
const FLAGS: Record<string, string> = {
  '--step': 'step', '--severity': 'severity', '--code': 'code', '--target': 'target',
  '--message': 'message', '--action': 'action', '--id': 'id', '--status': 'status', '--resolution': 'resolution'
  , '--override-ticket': 'overrideTicket', '--override-target': 'overrideTarget', '--override-scope': 'overrideScope'
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'WARNING_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function taskWarning(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-warning', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, kind] = args;
  if (!taskRef || !kind || ![
    internalHandlerRoute('task-warning', 'add', kind ?? ''),
    internalHandlerRoute('task-warning', 'set-status', kind ?? ''),
    internalHandlerRoute('task-warning', 'list', kind ?? '')
  ].some(Boolean)) { usageFailure('task ref and a valid intent are required'); return; }
  const values: Record<string, unknown> = { kind, taskRef };
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
    seen.add(flag); values[key] = value;
  }
  const required: Record<string, string[]> = {
    add: ['step', 'severity', 'code', 'target', 'message', 'action'],
    'set-status': ['id', 'status', 'resolution'], list: []
  };
  const optional = kind === 'list' ? ['status'] : [];
  const allowed = new Set(['kind', 'taskRef', 'dryRun', ...required[kind]!, ...optional]);
  allowed.add('overrideTicket'); allowed.add('overrideTarget'); allowed.add('overrideScope');
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  const missing = required[kind]!.find((key) => values[key] === undefined);
  if (unexpected) { usageFailure(`${kind} does not accept '${unexpected}'`); return; }
  if (missing) { usageFailure(`${kind} requires '${missing}'`); return; }
  const dryRunConflict = overrideDryRunConflict(values);
  if (dryRunConflict) { usageFailure(dryRunConflict.message); return; }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { usageFailure(resolved.message); return; }
  let result;
  let humanOverride: unknown = null;
  try {
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-warning.${kind}`, async () => {
      let current = applyWorkflowWarningIntent(values as WorkflowWarningIntent);
      if (current.status !== 'failed' || !values.overrideTicket) return current;
      if (!values.overrideTarget || !values.overrideScope) { usageFailure('override ticket requires target and scope'); return current; }
      const consumed = await consumeHumanOverride({
        taskRef, ticketId: String(values.overrideTicket),
        failureId: failureId('workflow-warning', current.error?.code ?? 'TASK_STATE_MISMATCH'),
        target: String(values.overrideTarget), scope: String(values.overrideScope)
      }, {
        effectExecutor: (capability) => {
          const retried = applyWorkflowWarningIntent(values as WorkflowWarningIntent, { manualOverride: capability });
          current = retried;
          return retried.status === 'failed' || retried.status === 'planned'
            ? { code: 'OVERRIDE_EFFECT_FAILED', message: retried.status === 'planned' ? 'producer returned planned; no workflow warning effect was committed' : `${retried.error?.code ?? 'WARNING_FAILED'}: ${retried.error?.message ?? 'manual warning effect failed'}` }
            : null;
        }
      });
      humanOverride = consumed;
      return current;
    });
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(humanOverride ? { ...result, humanOverride } : result)}\n`);
  const overrideFailed = Boolean(
    humanOverride && typeof humanOverride === 'object' &&
    (humanOverride as { status?: unknown }).status === 'failed'
  );
  if (result.status === 'failed' || overrideFailed) process.exitCode = 1;
}

export { taskWarning };
