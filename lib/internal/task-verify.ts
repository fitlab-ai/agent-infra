import { renderTaskVerification, verifyTaskEvent } from '../task/verification.ts';

const USAGE = 'Usage: agent-infra-internal task-verify <N | TASK-id> <verification-event> [--artifact <canonical.md>] [--format json|text]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'VERIFY_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskVerify(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!args[0] || !args[1] || args[0].startsWith('--') || args[1].startsWith('--')) { fail('task ref and verification event are required'); return; }
  let artifact: string | undefined;
  let format: 'json' | 'text' = 'json';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--artifact' && flag !== '--format') { fail(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { fail(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { fail(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    if (flag === '--artifact') artifact = value;
    else if (value === 'json' || value === 'text') format = value;
    else { fail("option '--format' requires 'json' or 'text'"); return; }
  }
  const result = verifyTaskEvent({ taskRef: args[0], event: args[1], ...(artifact ? { artifact } : {}) });
  process.stdout.write(format === 'text' ? renderTaskVerification(result) : `${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}

export { taskVerify };
