import { detectRepoRoot } from '../task/resolve-ref.ts';
import { resolveProjectTaskWorkspaceLayout, type ExecutionBoundary } from '../task/workspace-root.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-workspace resolve [--boundary host|container]\n`;

function fail(code: string, message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  process.exitCode = 1;
}

function taskWorkspace(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-workspace', args)) return;
  const operation = args[0] ?? '';
  if (operation === '--help' || operation === '-h') { process.stdout.write(USAGE); return; }
  if (!internalHandlerRoute('task-workspace', 'resolve', operation)) {
    fail('TASK_WORKSPACE_PAYLOAD_INVALID', "operation must be 'resolve'");
    return;
  }
  let boundary: ExecutionBoundary = 'host';
  const options = args.slice(1);
  if (options.length !== 0) {
    if (options.length !== 2 || options[0] !== '--boundary' || !options[1] || options[1]!.startsWith('--')) {
      fail('TASK_WORKSPACE_PAYLOAD_INVALID', 'invalid or duplicate task-workspace option');
      return;
    }
    boundary = options[1] as ExecutionBoundary;
  }
  if (boundary !== 'host' && boundary !== 'container') {
    fail('TASK_WORKSPACE_PAYLOAD_INVALID', 'resolve accepts only --boundary host|container');
    return;
  }
  try {
    const layout = resolveProjectTaskWorkspaceLayout(detectRepoRoot(), boundary);
    process.stdout.write(`${JSON.stringify({ status: 'resolved', changed: false, projectKey: layout.projectKey, boundary: layout.boundary, root: layout.root, error: null })}\n`);
  } catch (error) { fail('TASK_WORKSPACE_OPERATION_FAILED', error instanceof Error ? error.message : String(error)); }
}

export { taskWorkspace };
