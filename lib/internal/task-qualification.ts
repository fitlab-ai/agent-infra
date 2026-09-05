import fs from 'node:fs';

import { applyQualificationProposal } from '../task/qualification-intents.ts';
import type { QualificationProposalRequest } from '../task/qualification-intents.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from '../task/task-execution-lock.ts';

const USAGE = `Usage: agent-infra-internal task-qualification <task-ref> proposal --input <json-file> [--dry-run]\n\nInternal qualification proposals may only add or update unconfirmed constraints and pending candidates.\n`;

function fail(message: string, code = 'QUALIFICATION_PROPOSAL_INVALID'): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

async function taskQualification(args: string[] = []): Promise<void> {
  const [taskRef, operation] = args;
  if (!taskRef || operation !== 'proposal') { fail('task ref and proposal operation are required'); return; }
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
  catch (error) { fail(`cannot read proposal input: ${error instanceof Error ? error.message : String(error)}`); return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail('proposal input must be an object'); return; }
  const request = { ...(payload as Record<string, unknown>), taskRef, dryRun } as QualificationProposalRequest;
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { fail(resolved.message, resolved.code); return; }
  try {
    const result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-qualification.proposal', () => applyQualificationProposal(request, { repoRoot: resolved.repoRoot }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    if (error instanceof TaskExecutionLockError) fail(`${error.code}: ${error.message}`, error.code);
    else throw error;
  }
}

export { taskQualification };
