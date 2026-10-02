import fs from 'node:fs';

import { canonicalSemanticDigest } from './artifact-operations.ts';
import { inspectActivityLog, pairEntries } from './activity-log.ts';
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

export function hasArtifactCompletionFact(taskContent: string, artifactPath: string, event: string): boolean {
  try {
    const frontmatter = parseTypedTaskFrontmatter(taskContent);
    const output = artifactPath.split(/[\\/]/u).at(-1) ?? '';
    const content = fs.readFileSync(artifactPath, 'utf8');
    const outputSha256 = sha256File(artifactPath);
    const semanticDigest = canonicalSemanticDigest(content);
    return parseCompletionFacts(frontmatter.completion_facts).some((fact) =>
      fact.event === event && fact.output === output
      && fact.outputSha256 === outputSha256 && fact.semanticDigest === semanticDigest
      && fact.requestId.length > 0
    );
  } catch {
    return false;
  }
}

export function hasArtifactCompletionLog(taskContent: string, artifact: string, event: string): boolean {
  return artifactCompletionOrder(taskContent, artifact, event) !== null;
}

/** Returns the stable Activity Log position of a paired completion row. */
export function artifactCompletionOrder(taskContent: string, artifact: string, event: string): number | null {
  const identity = parseArtifactName(artifact);
  if (!identity) return null;
  const family = event === 'analysis.completed' || event === 'analyze.completed' ? 'analysis'
    : event === 'review-analysis.completed' ? 'review-analysis'
      : event === 'plan.completed' ? 'plan'
        : event === 'review-plan.completed' ? 'review-plan'
          : event === 'code.completed' ? 'code'
            : event === 'review-code.completed' ? 'review-code' : null;
  if (!family || family !== identity.family) return null;
  const action = family === 'analysis' ? 'Analyze Task'
    : family === 'review-analysis' ? 'Review Analysis'
      : family === 'plan' ? 'Plan Task'
        : family === 'review-plan' ? 'Review Plan'
          : family === 'code' ? 'Code Task' : 'Review Code';
  const { section, invalidEntries } = inspectActivityLog(taskContent);
  if (!section || invalidEntries.length > 0) return null;
  const ordered = section.entries.map((entry, sourceOrder) => ({ entry, sourceOrder }))
    .sort((left, right) => Date.parse(left.entry.time.replace(' ', 'T')) - Date.parse(right.entry.time.replace(' ', 'T')) || left.sourceOrder - right.sourceOrder);
  const entries = ordered.map(({ entry }) => entry);
  const roundPattern = new RegExp(`^${action} \\(Round ${identity.round}(?:, [^)]+)?\\)$`);
  const row = pairEntries(entries).find((candidate) => candidate.started !== ''
    && candidate.done !== '' && roundPattern.test(candidate.step)
    && candidate.note.includes(`→ ${artifact}`));
  if (!row) return null;
  const doneIndex = ordered.findIndex(({ entry }) => entry.time === row.done
    && entry.step === row.step && entry.note === row.note);
  return doneIndex < 0 ? null : doneIndex;
}
