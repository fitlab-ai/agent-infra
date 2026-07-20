import { collectTaskSnapshot } from '../task/snapshot.ts';

const USAGE = 'Usage: agent-infra-internal task-snapshot <N | #N | TASK-id> [--format json|text]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'SNAPSHOT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskSnapshot(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!args[0] || args[0].startsWith('--')) { fail('task ref is required'); return; }
  let format: 'json' | 'text' = 'json';
  let seenFormat = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--format') { fail(`unknown option '${flag}'`); return; }
    if (seenFormat) { fail("duplicate option '--format'"); return; }
    const value = args[++index];
    if (value !== 'json' && value !== 'text') { fail("option '--format' requires 'json' or 'text'"); return; }
    seenFormat = true;
    format = value;
  }
  const result = collectTaskSnapshot(args[0]);
  if (format === 'text') {
    process.stdout.write(result.status === 'ready' ? `${result.evidence}\n` : `Snapshot failed: ${result.error?.code} - ${result.error?.message}\n`);
  } else process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskSnapshot };
