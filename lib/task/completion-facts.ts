import fs from 'node:fs';

import { canonicalSemanticDigest } from './artifact-operations.ts';
import { inspectActivityLog } from './activity-log.ts';
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
  const identity = parseArtifactName(artifact);
  if (!identity) return false;
  const action = event === 'review-code.completed' ? 'Review Code'
    : event === 'review-plan.completed' ? 'Review Plan'
      : event === 'review-analysis.completed' ? 'Review Analysis' : null;
  if (!action) return false;
  const { section, invalidEntries } = inspectActivityLog(taskContent);
  if (!section || invalidEntries.length > 0) return false;
  const expected = `${action} (Round ${identity.round})`;
  return section.entries.some((entry) => entry.step === expected && entry.note.includes(`→ ${artifact}`));
}
