import path from 'node:path';

import { detectRepoRoot } from '../task/resolve-ref.ts';
import { resolveProjectTaskWorkspaceRoot } from '../task/workspace-root.ts';
import { configuredShortIdLength, executeShortIdCommand } from '../task/short-id.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-short-id <alloc|release|resolve|list> [argument] [--active-dir <path>] [--short-id-length <N>] [--verify]\n`;

function failure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, output: '', error: { code: 'SHORT_ID_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

type ParsedOptions = {
  positional: string[];
  activeDir: string | null;
  shortIdLength: number | null;
  verify: boolean;
};

function parseOptions(args: string[], operation: string): ParsedOptions | null {
  const positional: string[] = [];
  let activeDir: string | null = null;
  let shortIdLength: number | null = null;
  let verify = false;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === '--verify') {
      if (seen.has(value)) { failure(`duplicate option '${value}'`); return null; }
      seen.add(value); verify = true; continue;
    }
    if (value === '--active-dir' || value === '--short-id-length') {
      if (seen.has(value)) { failure(`duplicate option '${value}'`); return null; }
      const optionValue = args[++index];
      if (optionValue === undefined || optionValue.startsWith('--')) { failure(`option '${value}' requires a value`); return null; }
      seen.add(value);
      if (value === '--active-dir') activeDir = path.resolve(optionValue);
      else shortIdLength = Number(optionValue);
      continue;
    }
    if (value.startsWith('--')) { failure(`unknown option '${value}'`); return null; }
    positional.push(value);
  }
  if (positional.length > (operation === 'list' ? 0 : 1)) {
    failure('too many positional arguments');
    return null;
  }
  return { positional, activeDir, shortIdLength, verify };
}

function hasOperationRoute(route: string): boolean {
  return [
    internalHandlerRoute('task-short-id', 'alloc', route),
    internalHandlerRoute('task-short-id', 'release', route),
    internalHandlerRoute('task-short-id', 'resolve', route),
    internalHandlerRoute('task-short-id', 'list', route),
    internalHandlerRoute('task-short-id', 'list-verify', route)
  ].some(Boolean);
}

function resolveOperation(args: string[]): string | null {
  const operation = args[0];
  const route = operation === 'list' && args.includes('--verify') ? 'list-verify' : operation ?? '';
  if (!operation || !hasOperationRoute(route)) { failure('a valid short-id operation is required'); return null; }
  return operation;
}

function taskShortId(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-short-id', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const operation = resolveOperation(args);
  if (!operation) return;
  const parsed = parseOptions(args, operation);
  if (!parsed) return;
  let repoRoot: string | null = null;
  try { repoRoot = detectRepoRoot(); } catch { /* custom active-dir mode */ }
  const resolvedActiveDir = parsed.activeDir ?? (repoRoot ? path.join(resolveProjectTaskWorkspaceRoot(repoRoot), 'active') : null);
  if (!resolvedActiveDir) { failure('cannot determine active task directory'); return; }
  const width = parsed.shortIdLength ?? (repoRoot ? configuredShortIdLength(repoRoot) : 2);
  const result = executeShortIdCommand({
    operation: operation as 'alloc' | 'release' | 'resolve' | 'list',
    argument: parsed.positional[0], activeDir: resolvedActiveDir, shortIdLength: width, verify: parsed.verify
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskShortId };
