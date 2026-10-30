import fs from 'node:fs';
import path from 'node:path';

import { canonicalSemanticDigest } from './artifact-operations.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { parseArtifactName } from './artifact-name.ts';
import { sha256File } from './artifact-receipts.ts';

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
  if (family === 'validation-run') return 'validation-run.completed';
  if (family === 'analysis') return 'analyze.completed';
  if (family === 'review-analysis') return 'review-analysis.completed';
  if (family === 'plan') return 'plan.completed';
  if (family === 'review-plan') return 'review-plan.completed';
  if (family === 'code') return 'code.completed';
  if (family === 'review-code') return 'review-code.completed';
  return null;
}

/** Validates an artifact's own completion fact and output evidence. */
export function hasValidArtifactCompletion(taskContent: string, taskDir: string, artifact: string, event: string): boolean {
  try {
    const fact = findCompletionFact(taskContent, artifact, event);
    return Boolean(fact && validateOutput(taskDir, artifact, fact));
  } catch {
    return false;
  }
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

function findCompletionFact(taskContent: string, artifact: string, event: string): CompletionFact | null {
  const identity = parseArtifactName(artifact);
  if (!identity || completionEvent(identity.family) !== event) return null;
  const fact = parseCompletionFacts(parseTypedTaskFrontmatter(taskContent).completion_facts)
    .find((candidate) => candidate.event === event && candidate.output === artifact);
  return fact && fact.requestId.length > 0 ? fact : null;
}

function validateOutput(taskDir: string, artifact: string, fact: CompletionFact): boolean {
  const outputPath = path.join(taskDir, artifact);
  const stat = fs.lstatSync(outputPath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const content = fs.readFileSync(outputPath, 'utf8');
  return sha256File(outputPath) === fact.outputSha256
    && canonicalSemanticDigest(content) === fact.semanticDigest;
}
