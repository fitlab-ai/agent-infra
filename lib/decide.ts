import { VERSION } from './version.ts';
import { parseTaskScope } from './task/command-options.ts';
import { applyHumanDecision } from './task/decision-intents.ts';
import { canonicalTimestamp } from './task/write.ts';

type DecideOptions = {
  repoRoot?: string;
  now?: () => string;
  version?: string;
};

function parseDecisionParts(parts: string[]): { decision: string; needsImplementation: boolean | undefined } {
  const decision: string[] = [];
  let needsImplementation: boolean | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== '--needs-implementation') {
      decision.push(parts[index]!);
      continue;
    }
    if (needsImplementation !== undefined) throw new Error("duplicate option '--needs-implementation'");
    const value = parts[++index];
    if (value !== 'true' && value !== 'false') {
      throw new Error("--needs-implementation must be 'true' or 'false'");
    }
    needsImplementation = value === 'true';
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
    const result = applyHumanDecision({
      taskRef, selector, decision: parsedDecision.decision,
      needsImplementation: parsedDecision.needsImplementation
    }, {
      repoRoot: options.repoRoot,
      metadataProvider: () => ({ timestamp: now, agentInfraVersion: options.version ?? VERSION })
    });
    if (result.error) throw new Error(result.error.message);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function cmdDecide(args: string[]): Promise<void> {
  process.exitCode = await decide(args);
}
