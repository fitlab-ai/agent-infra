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
    const raw = parseTypedTaskFrontmatter(taskContent).completion_facts;
    if (raw === undefined) return false;
    if (typeof raw !== 'string') return true;
    if (raw.trim() === '') return false;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return true;
    return parsed.some((fact) => fact && typeof fact === 'object' && !Array.isArray(fact)
      && (fact as { event?: unknown }).event === event
      && (fact as { output?: unknown }).output === artifact);
  } catch {
    return true;
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

  let valid: boolean;
  try {
    const fact = findCompletionFact(taskContent, artifact, event);
    const inputs = fact?.lifecycleInputs;
    valid = Boolean(fact && inputs && validateOutput(taskDir, artifact, fact)
      && validateInputReceipts(taskContent, artifact, event, inputs)
      && validateInputCompletions(taskContent, taskDir, inputs, context));
  } catch {
    valid = false;
  }
  context.visiting.delete(key);
  context.results.set(key, valid);
  return valid;
}

function findCompletionFact(taskContent: string, artifact: string, event: string): CompletionFact | null {
  const identity = parseArtifactName(artifact);
  if (!identity || completionEvent(identity.family) !== event) return null;
  const fact = parseCompletionFacts(parseTypedTaskFrontmatter(taskContent).completion_facts)
    .find((candidate) => candidate.event === event && candidate.output === artifact);
  return fact && Array.isArray(fact.lifecycleInputs) && fact.requestId.length > 0 ? fact : null;
}

function validateOutput(taskDir: string, artifact: string, fact: CompletionFact): boolean {
  const outputPath = path.join(taskDir, artifact);
  const stat = fs.lstatSync(outputPath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const content = fs.readFileSync(outputPath, 'utf8');
  return sha256File(outputPath) === fact.outputSha256
    && canonicalSemanticDigest(content) === fact.semanticDigest;
}

function validateInputReceipts(
  taskContent: string,
  artifact: string,
  event: string,
  inputs: readonly Readonly<{ name: string; sha256: string }>[]
): boolean {
  const expectedEvent = receiptEvent(event);
  if (!expectedEvent || inputs.some((input) => !input || typeof input.name !== 'string'
    || !/^[a-f0-9]{64}$/u.test(input.sha256) || !parseArtifactName(input.name))) return false;
  const keys = inputs.map((input) => `${input.name}\0${input.sha256}`);
  if (new Set(keys).size !== keys.length) return false;
  const receipts = parseArtifactReceipts(taskContent).rows
    .filter((receipt) => receipt.output === artifact && receipt.event === expectedEvent);
  return receipts.length === inputs.length
    && receipts.every((receipt) => keys.includes(`${receipt.input}\0${receipt.inputSha256}`));
}

function validateInputCompletions(
  taskContent: string,
  taskDir: string,
  inputs: readonly Readonly<{ name: string; sha256: string }>[],
  context: ValidationContext
): boolean {
  for (const input of inputs) {
    const identity = parseArtifactName(input.name);
    const inputEvent = identity && completionEvent(identity.family);
    if (!inputEvent) return false;
    const inputPath = path.join(taskDir, input.name);
    const stat = fs.lstatSync(inputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(inputPath) !== input.sha256
      || !validateArtifactCompletion(taskContent, taskDir, input.name, inputEvent, context)) return false;
  }
  return true;
}
