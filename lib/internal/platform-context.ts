import path from 'node:path';

import { resolvePlatformContext } from '../platform/context.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal platform-context resolve [--cwd <path>]\n';

function fail(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'PLATFORM_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function platformContext(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('platform-context', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (!internalHandlerRoute('platform-context', 'resolve', args[0] ?? '')) { fail("operation must be 'resolve'"); return; }
  let cwd = process.cwd();
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--cwd') { fail(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { fail(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { fail(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    cwd = path.resolve(value);
  }
  const result = await resolvePlatformContext({ cwd });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

export { platformContext };
