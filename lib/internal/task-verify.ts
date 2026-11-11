import { renderTaskVerification, verifyTaskEvent } from '../task/verification.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-verify <N | TASK-id> <verification-event> [--artifact <canonical.md>] [--format json|text]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'VERIFY_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

type ParsedOptions =
  | { ok: true; artifact?: string; format: 'json' | 'text' }
  | { ok: false; error: string };

function parseOptions(args: string[]): ParsedOptions {
  let artifact: string | undefined;
  let format: 'json' | 'text' = 'json';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--artifact', '--format'].includes(flag)) return { ok: false, error: `unknown option '${flag}'` };
    if (seen.has(flag)) return { ok: false, error: `duplicate option '${flag}'` };
    const value = args[++index];
    if (!value || value.startsWith('--')) return { ok: false, error: `option '${flag}' requires a value` };
    seen.add(flag);
    if (flag === '--artifact') artifact = value;
    else if (value === 'json' || value === 'text') format = value;
    else return { ok: false, error: "option '--format' requires 'json' or 'text'" };
  }
  return { ok: true, ...(artifact ? { artifact } : {}), format };
}

function hasRequiredArguments(args: string[]): boolean {
  return Boolean(args[0] && args[1] && !args[0].startsWith('--') && !args[1].startsWith('--')
    && internalHandlerRoute('task-verify', 'event', args[1] ? 'event' : ''));
}

async function taskVerify(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('task-verify', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!hasRequiredArguments(args)) { fail('task ref and verification event are required'); return; }
  const taskRef = args[0]!;
  const event = args[1]!;
  const parsed = parseOptions(args);
  if (!parsed.ok) { fail(parsed.error); return; }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { fail(resolved.message); return; }
  const result = await verifyTaskEvent({ taskRef, event, ...(parsed.artifact ? { artifact: parsed.artifact } : {}) });
  process.stdout.write(parsed.format === 'text' ? renderTaskVerification(result) : `${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}

export { taskVerify };
