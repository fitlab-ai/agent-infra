import fs from 'node:fs';

import { applyQualificationConfirmation } from '../task/qualification-confirmation.ts';
import type { QualificationConfirmationRequest } from '../task/qualification-confirmation.ts';
import { applyQualificationProposal } from '../task/qualification-intents.ts';
import type { QualificationProposalRequest } from '../task/qualification-intents.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

const USAGE = `Usage: agent-infra-internal task-qualification <task-ref> <proposal|confirm|supersede|revoke> --input <json-file> [--dry-run]\n`;

function fail(message: string, code = 'QUALIFICATION_PROPOSAL_INVALID'): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function taskQualification(args: string[] = []): Promise<void> {
  const [taskRef, operation] = args;
  if (!taskRef || !['proposal', 'confirm', 'supersede', 'revoke'].includes(operation ?? '')) { fail('task ref and a valid qualification operation are required'); return; }
  let inputPath = '';
  let dryRun = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run') { if (dryRun) { fail('duplicate option --dry-run'); return; } dryRun = true; continue; }
    if (arg !== '--input' || inputPath) { fail(`unknown or duplicate option '${arg}'`); return; }
    inputPath = args[++index] ?? '';
    if (!inputPath || inputPath.startsWith('--')) { fail("option '--input' requires a value"); return; }
  }
  if (!inputPath) { fail("option '--input' is required"); return; }
  let payload: unknown;
  try { payload = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
  catch (error) { fail(`cannot read qualification input: ${error instanceof Error ? error.message : String(error)}`); return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail('qualification input must be an object'); return; }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { fail(resolved.message, resolved.code); return; }
  try {
    const result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, `task-qualification.${operation}`, () => operation === 'proposal'
      ? applyQualificationProposal({ ...(payload as Record<string, unknown>), taskRef: resolved.taskId, dryRun } as QualificationProposalRequest, { repoRoot: resolved.repoRoot })
      : applyQualificationConfirmation({ ...(payload as Record<string, unknown>), taskRef: resolved.taskId, operation, dryRun } as QualificationConfirmationRequest, { repoRoot: resolved.repoRoot }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    if (error instanceof TaskExecutionLockError) fail(`${error.code}: ${error.message}`, error.code);
    else throw error;
  }
}

export { taskQualification };
