import fs from 'node:fs';
import path from 'node:path';

import { canonicalSemanticDigest } from './artifact-operations.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { parseArtifactName } from './artifact-name.ts';
import { parseArtifactReceipts, sha256File } from './artifact-receipts.ts';

export type CompletionFact = Readonly<{
  event: string;
  output: string;
  outputSha256: string;
  semanticDigest: string;
  requestId: string;
  result: string;
  lifecycleInputs?: readonly Readonly<{ name: string; sha256: string }>[];
}>;

export function parseCompletionFacts(value: unknown): CompletionFact[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((fact): fact is CompletionFact => Boolean(
      fact && typeof fact === 'object' && !Array.isArray(fact)
      && typeof (fact as CompletionFact).event === 'string'
      && typeof (fact as CompletionFact).output === 'string'
      && /^[a-f0-9]{64}$/u.test((fact as CompletionFact).outputSha256)
      && /^[a-f0-9]{64}$/u.test((fact as CompletionFact).semanticDigest)
      && typeof (fact as CompletionFact).requestId === 'string'
      && typeof (fact as CompletionFact).result === 'string'
    ));
  } catch {
    return [];
  }
}

function completionEvent(family: string): string | null {
  if (family === 'analysis') return 'analyze.completed';
  if (family === 'review-analysis') return 'review-analysis.completed';
  if (family === 'plan') return 'plan.completed';
  if (family === 'review-plan') return 'review-plan.completed';
  if (family === 'code') return 'code.completed';
  if (family === 'review-code') return 'review-code.completed';
  return null;
}

function receiptEvent(event: string): string | null {
  return event === 'analyze.completed' ? 'analysis.completed'
    : ['review-analysis.completed', 'plan.completed', 'review-plan.completed', 'code.completed', 'review-code.completed'].includes(event)
      ? event : null;
}

type ValidationContext = {
  visiting: Set<string>;
  results: Map<string, boolean>;
};

/** Validates an artifact and the exact historical input chain captured when it completed. */
export function hasValidArtifactCompletion(taskContent: string, taskDir: string, artifact: string, event: string): boolean {
  return validateArtifactCompletion(taskContent, taskDir, artifact, event, {
    visiting: new Set(),
    results: new Map()
  });
}

/** Distinguishes an invalidated completion fact from a round that has never completed. */
export function hasArtifactCompletionRecord(taskContent: string, artifact: string, event: string): boolean {
  try {
    const facts = parseCompletionFacts(parseTypedTaskFrontmatter(taskContent).completion_facts);
    return facts.some((fact) => fact.event === event && fact.output === artifact);
  } catch {
    return false;
  }
}

function validateArtifactCompletion(
  taskContent: string,
  taskDir: string,
  artifact: string,
  event: string,
  context: ValidationContext
): boolean {
  const key = `${event}\0${artifact}`;
  const cached = context.results.get(key);
  if (cached !== undefined) return cached;
  if (context.visiting.has(key)) return false;
  context.visiting.add(key);

  let valid = false;
  try {
    const identity = parseArtifactName(artifact);
    if (!identity || completionEvent(identity.family) !== event) return finish(false);
    const frontmatter = parseTypedTaskFrontmatter(taskContent);
    const fact = parseCompletionFacts(frontmatter.completion_facts)
      .find((candidate) => candidate.event === event && candidate.output === artifact);
    if (!fact || !Array.isArray(fact.lifecycleInputs) || fact.requestId.length === 0) return finish(false);

    const outputPath = path.join(taskDir, artifact);
    const outputStat = fs.lstatSync(outputPath);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) return finish(false);
    const outputContent = fs.readFileSync(outputPath, 'utf8');
    if (sha256File(outputPath) !== fact.outputSha256
      || canonicalSemanticDigest(outputContent) !== fact.semanticDigest) return finish(false);

    const expectedReceiptEvent = receiptEvent(event);
    if (!expectedReceiptEvent) return finish(false);
    const receiptRows = parseArtifactReceipts(taskContent).rows
      .filter((receipt) => receipt.output === artifact && receipt.event === expectedReceiptEvent);
    const inputs = fact.lifecycleInputs;
    if (inputs.some((input) => !input || typeof input.name !== 'string'
      || !/^[a-f0-9]{64}$/u.test(input.sha256) || !parseArtifactName(input.name))) return finish(false);
    const inputKeys = inputs.map((input) => `${input.name}\0${input.sha256}`);
    if (new Set(inputKeys).size !== inputKeys.length || receiptRows.length !== inputs.length) return finish(false);
    if (receiptRows.some((receipt) => !inputKeys.includes(`${receipt.input}\0${receipt.inputSha256}`))) return finish(false);

    for (const input of inputs) {
      const inputIdentity = parseArtifactName(input.name);
      const inputEvent = inputIdentity && completionEvent(inputIdentity.family);
      if (!inputIdentity || !inputEvent) return finish(false);
      const inputPath = path.join(taskDir, input.name);
      const inputStat = fs.lstatSync(inputPath);
      if (!inputStat.isFile() || inputStat.isSymbolicLink() || sha256File(inputPath) !== input.sha256) return finish(false);
      if (!validateArtifactCompletion(taskContent, taskDir, input.name, inputEvent, context)) return finish(false);
    }

    valid = true;
  } catch {
    valid = false;
  }
  return finish(valid);

  function finish(result: boolean): boolean {
    context.visiting.delete(key);
    context.results.set(key, result);
    return result;
  }
}
