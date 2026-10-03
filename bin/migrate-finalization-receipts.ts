import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { migrateFinalizationReceipts } from '../lib/task/finalization-migration.ts';

const USAGE = 'Usage: node --experimental-strip-types bin/migrate-finalization-receipts.ts [--dry-run] [--repo-root <path>]';

function run(args: readonly string[]): number {
  let dryRun = false;
  let repoRoot = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--repo-root' && args[index + 1]) {
      repoRoot = path.resolve(args[index + 1]!);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
  }

  const result = migrateFinalizationReceipts(repoRoot, { dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.failed ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exitCode = run(process.argv.slice(2));

export { run as runFinalizationReceiptMigrationCli };
