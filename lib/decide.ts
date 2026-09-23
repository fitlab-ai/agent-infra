import { VERSION } from './version.ts';
import { parseTaskScope } from './task/command-options.ts';
import { applyHumanDecision } from './task/decision-intents.ts';
import { canonicalTimestamp } from './task/write.ts';
import { resolveTaskContext } from './task/resolve-ref.ts';
import { TaskExecutionLockError, withTaskExecutionLock } from './task/task-execution-lock.ts';

type DecideOptions = {
  repoRoot?: string;
  now?: () => string;
  version?: string;
};

function parseDecisionParts(parts: string[]): { decision: string; needsImplementation: boolean | undefined } {
  const decision: string[] = [];
  let needsImplementation: boolean | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--needs-implementation') {
      if (needsImplementation !== undefined) throw new Error("duplicate option '--needs-implementation'");
      const value = parts[++index];
      if (value !== 'true' && value !== 'false') {
        throw new Error("--needs-implementation must be 'true' or 'false'");
      }
      needsImplementation = value === 'true';
    } else if (part?.startsWith('--')) {
      throw new Error(`unknown option '${part}'`);
    } else {
      decision.push(parts[index]!);
    }
  }
  if (decision.length === 0) throw new Error('decision content is required');
  return { decision: decision.join(' '), needsImplementation };
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
      process.stderr.write('Error: --item=... is not supported; use --item <selector> or -i <selector>\n'); return 1;
    } else operands.push(arg);
  }
  const taskRef = scope.taskRef;
  const selector = item;
  const decisionParts = operands;
  if (!selector || decisionParts.length === 0) {
    process.stderr.write('Usage: ai decide [--task <ref> | -t <ref>] (--item <ordinal|ledger-id> | -i <ordinal|ledger-id>) [--needs-implementation true|false] <decision>\n');
    return 1;
  }
  try {
    const parsedDecision = parseDecisionParts(decisionParts);
    const now = (options.now ?? canonicalTimestamp)();
    const resolved = resolveTaskContext(taskRef, { repoRoot: options.repoRoot });
    if (!resolved.ok) throw new Error(resolved.message);
    const request = {
      taskRef: resolved.taskId, selector, decision: parsedDecision.decision,
      needsImplementation: parsedDecision.needsImplementation
    };
    const writeOptions = {
      repoRoot: resolved.repoRoot,
      metadataProvider: () => ({ timestamp: now, agentInfraVersion: options.version ?? VERSION })
    };
    let result;
    const execute = async () => applyHumanDecision(request, writeOptions);
    result = await withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-decision', execute);
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
