import fs from 'node:fs';

import { applyQualificationConfirmation } from '../task/qualification-confirmation.ts';
import type { QualificationConfirmationRequest } from '../task/qualification-confirmation.ts';
import { applyQualificationProposal } from '../task/qualification-intents.ts';
import type { QualificationProposalRequest } from '../task/qualification-intents.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-qualification <task-ref> <proposal|confirm|supersede|revoke> --input <json-file> [--dry-run]\n`;

function fail(message: string, code = 'QUALIFICATION_PROPOSAL_INVALID'): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

type QualificationArguments = { inputPath: string; dryRun: boolean } | { error: string };

function parseQualificationOptions(args: string[]): QualificationArguments {
  let inputPath = '';
  let dryRun = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run') {
      if (dryRun) return { error: 'duplicate option --dry-run' };
      dryRun = true;
      continue;
    }
    if (arg !== '--input' || inputPath) return { error: `unknown or duplicate option '${arg}'` };
    inputPath = args[++index] ?? '';
    if (!inputPath || inputPath.startsWith('--')) return { error: "option '--input' requires a value" };
  }
  return inputPath ? { inputPath, dryRun } : { error: "option '--input' is required" };
}

function readQualificationInput(inputPath: string): { payload: unknown } | { error: string } {
  try { return { payload: JSON.parse(fs.readFileSync(inputPath, 'utf8')) }; }
  catch (error) { return { error: `cannot read qualification input: ${error instanceof Error ? error.message : String(error)}` }; }
}

type QualificationContext = {
  payload: Record<string, unknown>;
  taskRef: string;
  repoRoot: string;
  dryRun: boolean;
};

type QualificationHandler = (context: QualificationContext) =>
  ReturnType<typeof applyQualificationProposal> | ReturnType<typeof applyQualificationConfirmation>;

function confirmationHandler(operation: 'confirm' | 'supersede' | 'revoke'): QualificationHandler {
  return ({ payload, taskRef, repoRoot, dryRun }) => applyQualificationConfirmation(
    { ...payload, taskRef, operation, dryRun } as QualificationConfirmationRequest, { repoRoot }
  );
}

const proposalHandler: QualificationHandler = ({ payload, taskRef, repoRoot, dryRun }) => applyQualificationProposal(
  { ...payload, taskRef, dryRun } as QualificationProposalRequest, { repoRoot }
);

async function taskQualification(args: string[] = []): Promise<void> {
  const [taskRef, operation = ''] = args;
  const route = [
    { matches: internalHandlerRoute('task-qualification', 'proposal', operation), handler: proposalHandler },
    { matches: internalHandlerRoute('task-qualification', 'confirm', operation), handler: confirmationHandler('confirm') },
    { matches: internalHandlerRoute('task-qualification', 'supersede', operation), handler: confirmationHandler('supersede') },
    { matches: internalHandlerRoute('task-qualification', 'revoke', operation), handler: confirmationHandler('revoke') }
  ].find((candidate) => candidate.matches);
  if (!route) {
    fail('task ref and a valid qualification operation are required');
    return;
  }
  if (!ensureInternalHandlerRoute('task-qualification', args)) return;
  if (!taskRef) { fail('task ref and a valid qualification operation are required'); return; }
  const parsed = parseQualificationOptions(args);
  if ('error' in parsed) { fail(parsed.error); return; }
  const input = readQualificationInput(parsed.inputPath);
  if ('error' in input) { fail(input.error); return; }
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { fail('qualification input must be an object'); return; }
  const resolved = resolveTaskRef(taskRef);
  if (!resolved.ok) { fail(resolved.message, resolved.code); return; }
  const result = await route.handler({ payload: payload as Record<string, unknown>, taskRef: resolved.taskId, repoRoot: resolved.repoRoot, dryRun: parsed.dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskQualification };
