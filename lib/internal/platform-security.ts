import path from 'node:path';

import { dismissSecurityAlert, readCommentFile, readSecurityAlert } from '../platform/security-alerts.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal platform-security read --kind <dependabot|code-scanning> --number <number> [--cwd <path>]
       agent-infra-internal platform-security dismiss --kind <dependabot|code-scanning> --number <number> --reason <reason> --comment-file <path> [--cwd <path>]
`;

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'SECURITY_INPUT_INVALID', message, retryable: false } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(result: { status: string; [key: string]: unknown }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0;
}

function parseOptions(args: string[]): { values: Map<string, string>; switches: Set<string> } | null {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const valueFlags = new Set(['--cwd', '--kind', '--number', '--reason', '--comment-file']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--help' || flag === '-h') return null;
    if (!valueFlags.has(flag) || values.has(flag) || switches.has(flag)) return null;
    const value = args[++index];
    if (!value || value.startsWith('--')) return null;
    values.set(flag, value);
  }
  return { values, switches };
}

function required(values: Map<string, string>, flag: string): string | null {
  const value = values.get(flag);
  return value && !value.startsWith('--') ? value : null;
}

async function platformSecurity(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('platform-security', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const action = args[0];
  if (!internalHandlerRoute('platform-security', 'read', action ?? '')
    && !internalHandlerRoute('platform-security', 'dismiss', action ?? '')) {
    fail('a valid operation is required');
    return;
  }
  if (action !== 'read' && action !== 'dismiss') { fail('a valid operation is required'); return; }
  const parsed = parseOptions(args.slice(1));
  if (!parsed) { fail('invalid security alert options'); return; }
  const kind = required(parsed.values, '--kind');
  const numberRaw = required(parsed.values, '--number');
  const cwd = path.resolve(required(parsed.values, '--cwd') || process.cwd());
  if (!kind || !numberRaw) { fail(`${action} requires --kind and --number`); return; }
  const number = Number(numberRaw);
  if (!Number.isSafeInteger(number) || number <= 0) { fail('--number must be a positive integer'); return; }

  if (action === 'read') {
    if ([...parsed.values.keys()].some((flag) => !['--kind', '--number', '--cwd'].includes(flag))) {
      fail('read does not accept dismissal options');
      return;
    }
    finish(await readSecurityAlert({ kind: kind as 'dependabot' | 'code-scanning', number }, { cwd }));
    return;
  }

  const reason = required(parsed.values, '--reason');
  const commentFile = required(parsed.values, '--comment-file');
  if (!reason || !commentFile) { fail('dismiss requires --reason and --comment-file'); return; }
  const comment = readCommentFile(commentFile, cwd);
  if (!comment.ok) {
    finish({ status: 'failed', changed: false, error: comment.error });
    return;
  }
  finish(await dismissSecurityAlert(
    { kind: kind as 'dependabot' | 'code-scanning', number, reason, comment: comment.value },
    { cwd }
  ));
}

export { platformSecurity };
