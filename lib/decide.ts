import { VERSION } from './version.ts';
import { parseTaskScope } from './task/command-options.ts';
import { applyHumanDecision } from './task/decision-intents.ts';
import { canonicalTimestamp } from './task/write.ts';
import { consumeHumanOverride, failureId } from './task/human-override.ts';
import { resolveTaskRef } from './task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task/task-execution-lock.ts';

type DecideOptions = {
  repoRoot?: string;
  now?: () => string;
  version?: string;
};

function parseDecisionParts(parts: string[]): { decision: string; needsImplementation: boolean | undefined; overrideTicket?: string; overrideTarget?: string; overrideScope?: string } {
  const decision: string[] = [];
  let needsImplementation: boolean | undefined;
  let overrideTicket: string | undefined;
  let overrideTarget: string | undefined;
  let overrideScope: string | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--needs-implementation') {
      if (needsImplementation !== undefined) throw new Error("duplicate option '--needs-implementation'");
      const value = parts[++index];
      if (value !== 'true' && value !== 'false') {
        throw new Error("--needs-implementation must be 'true' or 'false'");
      }
      needsImplementation = value === 'true';
    } else if (part === '--override-ticket' || part === '--override-target' || part === '--override-scope') {
      const value = parts[++index];
      if (!value) throw new Error(`${part} requires a value`);
      if (part === '--override-ticket') overrideTicket = value;
      else if (part === '--override-target') overrideTarget = value;
      else overrideScope = value;
    } else {
      decision.push(parts[index]!);
    }
  }
  if (decision.length === 0) throw new Error('decision content is required');
  return { decision: decision.join(' '), needsImplementation, overrideTicket, overrideTarget, overrideScope };
}

export async function decide(args: string[], options: DecideOptions = {}): Promise<number> {
  let scope;
  try { scope = parseTaskScope(args); } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); return 1;
  }
  let item: string | undefined;
  const operands: string[] = [];
  for (let index = 0; index < scope.positionals.length; index += 1) {
    const arg = scope.positionals[index]!;
    if (arg === '--item' || arg === '-i') {
      if (item !== undefined) { process.stderr.write("Error: duplicate option '--item'\n"); return 1; }
      item = scope.positionals[++index];
      if (!item) { process.stderr.write(`Error: ${arg} requires a value\n`); return 1; }
    } else if (arg.startsWith('--item=')) {
      if (item !== undefined) { process.stderr.write("Error: duplicate option '--item'\n"); return 1; }
      item = arg.slice('--item='.length);
      if (item === '') { process.stderr.write('Error: --item requires a value\n'); return 1; }
    } else operands.push(arg);
  }
  let taskRef = scope.taskRef;
  let selector = item;
  let decisionParts: string[];
  if (item !== undefined) {
    decisionParts = operands;
  } else if (!scope.explicit) {
    [taskRef, selector, ...decisionParts] = operands;
  } else {
    decisionParts = [];
  }
  if (!selector || decisionParts.length === 0) {
    process.stderr.write('Usage: ai decide [--task <ref>] --item <ordinal|ledger-id> [--needs-implementation true|false] <decision>\n       ai decide <task-ref> <ordinal|ledger-id> [--needs-implementation true|false] <decision>\n');
    return 1;
  }
  try {
    const parsedDecision = parseDecisionParts(decisionParts);
    const now = (options.now ?? canonicalTimestamp)();
    const request = {
      taskRef, selector, decision: parsedDecision.decision,
      needsImplementation: parsedDecision.needsImplementation
    };
    const writeOptions = {
      repoRoot: options.repoRoot,
      metadataProvider: () => ({ timestamp: now, agentInfraVersion: options.version ?? VERSION })
    };
    const resolved = taskRef ? resolveTaskRef(taskRef, { repoRoot: options.repoRoot }) : null;
    let result;
    const execute = () => {
      let current = applyHumanDecision(request, writeOptions);
      if (current.status !== 'failed' || !parsedDecision.overrideTicket) return current;
      if (!parsedDecision.overrideTarget || !parsedDecision.overrideScope) throw new Error('override ticket requires --override-target and --override-scope');
      const consumed = consumeHumanOverride({
        taskRef: resolved?.ok ? resolved.taskId : String(taskRef ?? ''),
        ticketId: parsedDecision.overrideTicket,
        failureId: failureId('decision-intent', current.error?.code ?? 'TASK_STATE_MISMATCH'),
        target: parsedDecision.overrideTarget,
        scope: parsedDecision.overrideScope
      }, {
        ...writeOptions,
        effectExecutor: (capability) => {
          const retried = applyHumanDecision(request, { ...writeOptions, manualOverride: capability });
          current = retried;
          return retried.status === 'failed' || retried.status === 'planned'
            ? { code: 'OVERRIDE_EFFECT_FAILED', message: retried.status === 'planned' ? 'producer returned planned; no decision effect was committed' : `${retried.error?.code ?? 'DECISION_FAILED'}: ${retried.error?.message ?? 'manual decision effect failed'}` }
            : null;
        }
      });
      if (consumed.status === 'failed') throw new Error(consumed.error.message);
      return current;
    };
    result = resolved?.ok
      ? withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-decision', execute)
      : execute();
    if (result.error) throw new Error(result.error.message);
    return 0;
  } catch (error) {
    const message = error instanceof TaskExecutionLockError
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

export async function cmdDecide(args: string[]): Promise<void> {
  process.exitCode = await decide(args);
}
