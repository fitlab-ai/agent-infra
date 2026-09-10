import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { withTaskExecutionLock } from '../../task/task-execution-lock.ts';
import { loadConfig } from '../config.ts';
import { assertValidBranchName, containerName } from '../constants.ts';
import {
  recordSandboxTaskCutoverReconciliation,
  readSandboxTaskCutoverJournal
} from '../cutover.ts';
import { resolveSandboxTarget } from '../workspace-identity.ts';
import {
  assertSandboxTaskSource,
  sandboxControlPaths
} from '../workspace-view.ts';

const USAGE = `Usage: ai sandbox reconcile --operator <name> <TASK-id | N>

Record an explicit host-side reconciliation for a preserved legacy task
cutover. Review the preserved payload and merge selected content into the
host task directory before running this command; it never performs the merge.
After it succeeds, retry with 'ai sandbox start --recreate <TASK-id | N>'.`;

export function parseReconcileArgs(args: string[]): { target: string; operator: string; help: boolean } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      operator: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  const help = values.help === true;
  if (help) return { target: positionals[0] ?? '', operator: String(values.operator ?? ''), help };
  if (positionals.length !== 1 || typeof values.operator !== 'string' || values.operator.trim().length === 0) {
    throw new Error(USAGE);
  }
  return { target: positionals[0]!, operator: values.operator, help };
}

function canonicalTerminalPath(value: string): string {
  return path.join(fs.realpathSync.native(path.dirname(path.resolve(value))), path.basename(value));
}

export async function reconcile(args: string[]): Promise<void> {
  if (args.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const parsed = parseReconcileArgs(args);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const target = resolveSandboxTarget(parsed.target, config.repoRoot);
  if (target.workspace.mode !== 'task-bound') {
    throw new Error('SANDBOX_TASK_CUTOVER_TASK_REQUIRED: reconcile requires an active TASK-id or task short id');
  }
  const taskId = target.workspace.taskId;
  assertValidBranchName(target.branch);
  const container = containerName(config, target.branch);
  const cutoverBase = path.join(config.home, '.agent-infra', 'sandbox-cutover');
  const journal = readSandboxTaskCutoverJournal({
    base: cutoverBase,
    project: config.project,
    container,
    taskId
  });
  if (!journal) {
    throw new Error(`SANDBOX_TASK_CUTOVER_JOURNAL_MISSING: no preserved cutover for ${taskId}`);
  }
  if (journal.state !== 'preserved') {
    throw new Error(`SANDBOX_TASK_CUTOVER_RECONCILIATION_REQUIRED: journal state is '${journal.state}'`);
  }

  const hostTaskDir = assertSandboxTaskSource(config.repoRoot, taskId);
  const expectedManifestPath = sandboxControlPaths({
    base: config.controlBase,
    project: config.project,
    container,
    identity: target.workspace
  }).manifestPath;
  if (journal.hostTaskDir !== hostTaskDir
    || journal.manifestPath !== canonicalTerminalPath(expectedManifestPath)) {
    throw new Error('SANDBOX_TASK_CUTOVER_IDENTITY_INVALID');
  }

  const reconciliation = await withTaskExecutionLock(
    config.repoRoot,
    taskId,
    'sandbox-cutover.reconcile',
    () => recordSandboxTaskCutoverReconciliation({
      base: cutoverBase,
      project: config.project,
      container,
      taskId,
      generation: journal.generation,
      hostTaskDir,
      projectionDir: journal.projectionDir,
      manifestPath: journal.manifestPath,
      operator: parsed.operator
    })
  );
  process.stdout.write(
    `Recorded host reconciliation for '${taskId}' by '${reconciliation.operator}'. `
    + `Retry 'ai sandbox start --recreate ${taskId}'.\n`
  );
}
