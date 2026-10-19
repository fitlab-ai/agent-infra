import { detectRepoRoot } from '../task/resolve-ref.ts';
import { migrateProjectTaskWorkspace } from '../task/workspace-migration.ts';
import { resolveProjectTaskWorkspaceLayout, type ExecutionBoundary } from '../task/workspace-root.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-workspace <resolve [--boundary host|container] | migrate --migration-id <id> --writers-stopped --old-mounts-inactive>\n`;

function fail(code: string, message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  process.exitCode = 1;
}

function parseFlags(args: string[]): Map<string, string | true> | null {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === '--writers-stopped' || name === '--old-mounts-inactive') {
      if (flags.has(name)) return null;
      flags.set(name, true);
      continue;
    }
    if (name === '--boundary' || name === '--migration-id') {
      if (flags.has(name)) return null;
      const value = args[++index];
      if (!value || value.startsWith('--')) return null;
      flags.set(name, value);
      continue;
    }
    return null;
  }
  return flags;
}

function resolveWorkspace(flags: Map<string, string | true>): void {
  const boundary = flags.get('--boundary') ?? 'host';
  if (flags.has('--migration-id') || flags.has('--writers-stopped') || flags.has('--old-mounts-inactive')
    || (boundary !== 'host' && boundary !== 'container')) {
    fail('TASK_WORKSPACE_PAYLOAD_INVALID', 'resolve accepts only --boundary host|container');
    return;
  }
  const layout = resolveProjectTaskWorkspaceLayout(detectRepoRoot(), boundary as ExecutionBoundary);
  process.stdout.write(`${JSON.stringify({ status: 'resolved', changed: false, projectKey: layout.projectKey, boundary: layout.boundary, root: layout.root, error: null })}\n`);
}

function migrateWorkspace(flags: Map<string, string | true>): void {
  const migrationId = flags.get('--migration-id');
  if (typeof migrationId !== 'string' || flags.has('--boundary')) {
    fail('TASK_WORKSPACE_PAYLOAD_INVALID', 'migrate requires --migration-id and does not accept --boundary');
    return;
  }
  if (!flags.has('--writers-stopped') || !flags.has('--old-mounts-inactive')) {
    fail('TASK_WORKSPACE_MAINTENANCE_REQUIRED', 'migration requires --writers-stopped and --old-mounts-inactive attestations');
    return;
  }
  const repoRoot = detectRepoRoot();
  const result = migrateProjectTaskWorkspace(repoRoot, migrationId);
  process.stdout.write(`${JSON.stringify({ status: result.status, changed: result.status === 'migrated', entries: result.entries, digest: result.digest, error: null })}\n`);
}

function runOperation(operation: 'resolve' | 'migrate', flags: Map<string, string | true>): void {
  if (!internalHandlerRoute('task-workspace', operation, operation)) {
    fail('TASK_WORKSPACE_PAYLOAD_INVALID', `operation '${operation}' is not registered`);
    return;
  }
  if (operation === 'resolve') resolveWorkspace(flags);
  else migrateWorkspace(flags);
}

function taskWorkspace(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-workspace', args)) return;
  const operation = args[0] ?? '';
  if (operation === '--help' || operation === '-h') { process.stdout.write(USAGE); return; }
  if (operation !== 'resolve' && operation !== 'migrate') {
    fail('TASK_WORKSPACE_PAYLOAD_INVALID', "operation must be 'resolve' or 'migrate'");
    return;
  }
  const flags = parseFlags(args.slice(1));
  if (!flags) { fail('TASK_WORKSPACE_PAYLOAD_INVALID', 'invalid or duplicate task-workspace option'); return; }
  try {
    runOperation(operation, flags);
  } catch (error) { fail('TASK_WORKSPACE_OPERATION_FAILED', error instanceof Error ? error.message : String(error)); }
}

export { taskWorkspace };
