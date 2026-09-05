import path from 'node:path';

import { initializeLabels, initializeMilestones } from '../platform/repository-metadata.ts';

const USAGE = `Usage: agent-infra-internal platform-metadata init-labels [--cleanup-stale-in] [--cwd <path>]
       agent-infra-internal platform-metadata init-milestones [--history] [--cwd <path>]
`;

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'METADATA_INPUT_INVALID', message, retryable: false } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function finish(result: { status: string; [key: string]: unknown }, preserveMilestoneFallback = false): void {
  if (preserveMilestoneFallback && result.error && typeof result.error === 'object'
    && (result.error as { code?: string }).code === 'PLATFORM_CAPABILITY_UNSUPPORTED') {
    process.stderr.write('Milestone initialization skipped for unsupported platform.\n');
    process.exitCode = 0;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0;
}

function parseOptions(args: string[]): { cwd: string; cleanup: boolean; history: boolean } | null {
  let cwd = process.cwd();
  let cleanup = false;
  let history = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--cleanup-stale-in') { cleanup = true; continue; }
    if (flag === '--history') { history = true; continue; }
    if (flag === '--cwd') {
      const value = args[++index];
      if (!value || value.startsWith('--')) return null;
      cwd = path.resolve(value);
      continue;
    }
    return null;
  }
  return { cwd: path.resolve(cwd), cleanup, history };
}

async function platformMetadata(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const action = args[0];
  if (action !== 'init-labels' && action !== 'init-milestones') { fail('a valid operation is required'); return; }
  const parsed = parseOptions(args.slice(1));
  if (!parsed) { fail('invalid metadata options'); return; }
  if (action === 'init-labels' && parsed.history) { fail('init-labels does not accept --history'); return; }
  if (action === 'init-milestones' && parsed.cleanup) { fail('init-milestones does not accept --cleanup-stale-in'); return; }
  if (action === 'init-labels') {
    finish(await initializeLabels({ cleanupStaleIn: parsed.cleanup }, { cwd: parsed.cwd }));
    return;
  }
  finish(await initializeMilestones({ history: parsed.history }, { cwd: parsed.cwd }), true);
}

export { platformMetadata };
