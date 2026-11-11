import { collectTaskSnapshot } from '../task/snapshot.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal task-snapshot <N | TASK-id> [--format json|text]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'SNAPSHOT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function parseTaskSnapshotCommand(args: string[]): { taskRef: string; format: 'json' | 'text' } | null {
  if (!ensureInternalHandlerRoute('task-snapshot', args)) return null;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return null; }
  if (!args[0] || args[0].startsWith('--') || !internalHandlerRoute('task-snapshot', 'snapshot', 'snapshot')) { fail('task ref is required'); return null; }

  let format: 'json' | 'text' = 'json';
  let seenFormat = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--format') { fail(`unknown option '${flag}'`); return null; }
    if (seenFormat) { fail("duplicate option '--format'"); return null; }
    const value = args[++index];
    if (value !== 'json' && value !== 'text') { fail("option '--format' requires 'json' or 'text'"); return null; }
    seenFormat = true;
    format = value;
  }
  return { taskRef: args[0], format };
}

function taskSnapshot(args: string[] = []): void {
  const command = parseTaskSnapshotCommand(args);
  if (!command) return;
  const result = collectTaskSnapshot(command.taskRef);
  if (command.format === 'text') {
    process.stdout.write(result.status === 'ready' ? `${result.evidence}\n` : `Snapshot failed: ${result.error?.code} - ${result.error?.message}\n`);
  } else process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskSnapshot };
