import { applyWorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import type { WorkflowWarningIntent } from '../task/workflow-warning-intents.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-warning <task-ref> <add|set-status|list> [intent flags] [--dry-run]\n`;
const FLAGS: Record<string, string> = {
  '--step': 'step', '--severity': 'severity', '--code': 'code', '--target': 'target',
  '--message': 'message', '--action': 'action', '--id': 'id', '--status': 'status', '--resolution': 'resolution'
};
const REQUIRED_FIELDS: Record<string, string[]> = {
  add: ['step', 'severity', 'code', 'target', 'message', 'action'],
  'set-status': ['id', 'status', 'resolution'], list: []
};

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'WARNING_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function isSupportedIntent(kind: string): boolean {
  return ['add', 'set-status', 'list'].some((intent) => internalHandlerRoute('task-warning', intent, kind));
}

function parseOptions(args: string[], values: Record<string, unknown>): boolean {
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return false; }
      seen.add(flag); values.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return false; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return false; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return false; }
    seen.add(flag); values[key] = value;
  }
  return true;
}

function validateIntentValues(kind: string, values: Record<string, unknown>): string | undefined {
  const required = REQUIRED_FIELDS[kind]!;
  const optional = kind === 'list' ? ['status'] : [];
  const allowed = new Set(['kind', 'taskRef', 'dryRun', ...required, ...optional]);
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  const missing = required.find((key) => values[key] === undefined);
  if (unexpected) return `${kind} does not accept '${unexpected}'`;
  if (missing) return `${kind} requires '${missing}'`;
  return undefined;
}

async function taskWarning(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-warning', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, kind] = args;
  if (!taskRef || !kind || !isSupportedIntent(kind)) { usageFailure('task ref and a valid intent are required'); return; }
  const values: Record<string, unknown> = { kind, taskRef };
  if (!parseOptions(args, values)) return;
  const validationError = validateIntentValues(kind, values);
  if (validationError) { usageFailure(validationError); return; }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { usageFailure(resolved.message); return; }
  const result = await applyWorkflowWarningIntent(values as WorkflowWarningIntent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskWarning };
