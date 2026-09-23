import { applyWorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import type { WorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-warning <task-ref> <add|set-status|list> [intent flags] [--dry-run]\n`;
const FLAGS: Record<string, string> = {
  '--step': 'step', '--severity': 'severity', '--code': 'code', '--target': 'target',
  '--message': 'message', '--action': 'action', '--id': 'id', '--status': 'status', '--resolution': 'resolution'
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
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  const missing = required[kind]!.find((key) => values[key] === undefined);
  if (unexpected) { usageFailure(`${kind} does not accept '${unexpected}'`); return; }
  if (missing) { usageFailure(`${kind} requires '${missing}'`); return; }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { usageFailure(resolved.message); return; }
  let result;
  try {
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-warning.${kind}`, async () => applyWorkflowWarningIntent(values as WorkflowWarningIntent));
  } catch (error) {
    if (!(error instanceof TaskExecutionLockError)) throw error;
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: error.code, message: error.message } })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskWarning };
