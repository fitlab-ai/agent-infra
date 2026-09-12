#!/usr/bin/env node

import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { migrateActiveTaskMetadata } from '../lib/task/one-time-active-migration.ts';

function usage(): void {
  process.stderr.write(
    'Usage: node --experimental-strip-types scripts/migrate-active-task-metadata.ts --repository <owner/repository> --provider <name> [--repo-root <path>]\n'
  );
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const repository = option(args, '--repository');
const providerName = option(args, '--provider');
if (!repository || !providerName) {
  usage();
  process.exitCode = 1;
} else {
  const repoRoot = path.resolve(option(args, '--repo-root') ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  try {
    const result = migrateActiveTaskMetadata(repoRoot, {
      authority: 'direct-host',
      repository,
      provider: { name: providerName, canRead: true, canWrite: true }
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: {
      code: typeof error === 'object' && error && 'code' in error ? String(error.code) : 'MIGRATION_FAILED',
      message: error instanceof Error ? error.message : String(error)
    } })}\n`);
    process.exitCode = 1;
  }
}
