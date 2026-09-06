import path from 'node:path';

import { detectRepoRoot } from '../task/resolve-ref.ts';
import { configuredShortIdLength, executeShortIdCommand } from '../task/short-id.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-short-id <alloc|release|resolve|list> [argument] [--active-dir <path>] [--short-id-length <N>] [--verify]\n`;

function failure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, output: '', error: { code: 'SHORT_ID_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskShortId(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-short-id', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = args[0];
  if (!operation || !['alloc', 'release', 'resolve', 'list'].includes(operation)) { failure('a valid short-id operation is required'); return; }
  const positional: string[] = [];
  let activeDir: string | null = null;
  let shortIdLength: number | null = null;
  let verify = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === '--verify') {
      if (seen.has(value)) { failure(`duplicate option '${value}'`); return; }
      seen.add(value); verify = true; continue;
    }
    if (value === '--active-dir' || value === '--short-id-length') {
      if (seen.has(value)) { failure(`duplicate option '${value}'`); return; }
      const optionValue = args[++index];
      if (optionValue === undefined || optionValue.startsWith('--')) { failure(`option '${value}' requires a value`); return; }
      seen.add(value);
      if (value === '--active-dir') activeDir = path.resolve(optionValue);
      else shortIdLength = Number(optionValue);
      continue;
    }
    if (value.startsWith('--')) { failure(`unknown option '${value}'`); return; }
    positional.push(value);
  }
  if (positional.length > (operation === 'list' ? 0 : 1)) { failure('too many positional arguments'); return; }
  let repoRoot: string | null = null;
  try { repoRoot = detectRepoRoot(); } catch { /* custom active-dir mode */ }
  const resolvedActiveDir = activeDir ?? (repoRoot ? path.join(repoRoot, '.agents', 'workspace', 'active') : null);
  if (!resolvedActiveDir) { failure('cannot determine active task directory'); return; }
  const width = shortIdLength ?? (repoRoot ? configuredShortIdLength(repoRoot) : 2);
  const result = executeShortIdCommand({
    operation: operation as 'alloc' | 'release' | 'resolve' | 'list',
    argument: positional[0], activeDir: resolvedActiveDir, shortIdLength: width, verify
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskShortId };
