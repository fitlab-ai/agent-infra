import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { artifactSubstantiveDigest, canonicalSemanticDigest } from './artifact-operations.ts';
import { buildArtifactInputDigest, parseCompletionFacts } from './artifact-selection.ts';
import type { CompletionFactV2, OpenArtifactSelection } from './artifact-selection.ts';
import { parseArtifactName } from './artifact-name.ts';
import { sha256File } from './artifact-receipts.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { extractSection } from './sections.ts';
import { parseQualificationAudit } from './qualification-audit.ts';
import { parseLifecyclePathDecision } from './lifecycle-path.ts';
import { inspectArtifactDirectory, hasOpenArtifactRound, resolveArtifactContext } from './artifact-lifecycle.ts';
import { captureWorktreeTree } from './workspace-snapshot.ts';
import { writeTask } from './write.ts';

type LegacyCompletionFact = Readonly<{
  event: string;
  output: string;
  outputSha256: string;
  semanticDigest: string;
  requestId: string;
  result: string;
}>;

type ConversionResult = Readonly<{
  status: 'planned' | 'applied' | 'no-op' | 'failed';
  changed: boolean;
  converted: number;
  error: Readonly<{ code: string; message: string }> | null;
}>;

function failure(code: string, message: string): ConversionResult {
  return { status: 'failed', changed: false, converted: 0, error: { code, message } };
}

function parseLegacyFacts(value: unknown): readonly LegacyCompletionFact[] | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const facts: LegacyCompletionFact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const convertibleV2 = row.version === 2 && row.selectionReason === 'converted-v1';
    if ((row.version !== undefined && !convertibleV2)
      || typeof row.event !== 'string' || !row.event
      || typeof row.output !== 'string' || !row.output
      || !/^[a-f0-9]{64}$/u.test(String(row.outputSha256 ?? ''))
      || !/^[a-f0-9]{64}$/u.test(String(row.semanticDigest ?? ''))
      || typeof row.requestId !== 'string'
      || typeof row.result !== 'string') return null;
    facts.push({
      event: row.event, output: row.output,
      outputSha256: String(row.outputSha256), semanticDigest: String(row.semanticDigest),
      requestId: row.requestId, result: row.result
    });
  }
  return facts;
}

function convertArtifactFact(
  fact: LegacyCompletionFact,
  taskDir: string,
  taskInput: string,
  lifecyclePath: string,
  repoRoot: string
): CompletionFactV2 {
  const identity = parseArtifactName(fact.output);
  if (!identity) throw new Error(`completion fact output '${fact.output}' is not canonical`);
  const artifactPath = path.join(taskDir, fact.output);
  const content = fs.readFileSync(artifactPath, 'utf8');
  if (sha256File(artifactPath) !== fact.outputSha256) throw new Error(`completion fact output '${fact.output}' changed on disk`);
  if (canonicalSemanticDigest(content) !== fact.semanticDigest) throw new Error(`completion fact semantic digest for '${fact.output}' changed`);
  const audit = parseQualificationAudit(content);
  if (!audit.ok) throw new Error(`${audit.code}: ${audit.message}`);
  const reviewedFamily = identity.family === 'review-analysis' ? 'analysis'
    : identity.family === 'review-plan' ? 'plan'
      : identity.family === 'review-code' ? 'code' : null;
  const upstream = audit.audit.upstreamRelations.filter((relation) => reviewedFamily
    ? relation.upstreamFamily === reviewedFamily
    : identity.family === 'plan' ? relation.upstreamFamily === 'analysis'
      : identity.family === 'code' ? ['analysis', 'plan'].includes(relation.upstreamFamily)
        : false).map((relation) => ({
    family: relation.upstreamFamily,
    artifact: relation.upstreamArtifact,
    round: relation.upstreamRound,
    sha256: relation.upstreamSha256,
    relation: relation.relation
  }));
  const inputDigest = buildArtifactInputDigest({
    family: identity.family,
    taskInput,
    lifecyclePath: identity.family === 'analysis' ? 'analysis-input' : lifecyclePath,
    upstream
  });
  const resultDigest = createHash('sha256').update(JSON.stringify({
    artifact: artifactSubstantiveDigest(content),
    ...(identity.family === 'code' ? { worktreeTree: captureWorktreeTree(repoRoot, null) } : {})
  })).digest('hex');
  return {
    version: 2, ...fact, inputDigest, resultDigest,
    changeEvidenceDigest: null,
    selectionReason: 'converted-v1'
  };
}

function currentOpenSelection(taskRef: string, taskContent: string, repoRoot: string): OpenArtifactSelection | null {
  const resolved = resolveTaskRef(taskRef, { repoRoot });
  if (!resolved.ok) throw new Error(resolved.message);
  const families = ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'] as const;
  for (const family of families) {
    const inventory = inspectArtifactDirectory(resolved.taskDir, family);
    const rounds = [inventory.latest?.round, inventory.next?.round].filter((round): round is number => round !== undefined);
    if (!rounds.some((round) => hasOpenArtifactRound(taskContent, family, round))) continue;
    const context = resolveArtifactContext(taskRef, family, { repoRoot });
    if (context.status !== 'ready' || !context.selection) throw new Error(context.error?.message ?? `cannot reconstruct open ${family} selection`);
    return {
      version: 1,
      family: context.selection.artifact.family,
      artifact: context.selection.artifact.name,
      round: context.selection.artifact.round,
      inputDigest: context.selection.inputDigest,
      changeEvidenceDigest: context.selection.changeEvidenceDigest,
      selectionReason: context.selection.reasonCode,
      requestId: ''
    };
  }
  return null;
}

function convertCompletionFacts(taskRef: string, options: Readonly<{ repoRoot?: string; dryRun?: boolean }> = {}): ConversionResult {
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(resolved.code, resolved.message);
  let content: string;
  let frontmatter: ReturnType<typeof parseTypedTaskFrontmatter>;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
    frontmatter = parseTypedTaskFrontmatter(content);
  } catch (error) {
    return failure('ARTIFACT_FACT_CONVERSION_INVALID', error instanceof Error ? error.message : String(error));
  }
  const already = parseCompletionFacts(frontmatter.completion_facts);
  if (already.ok && !already.facts.some((fact) => fact.selectionReason === 'converted-v1')) {
    return { status: 'no-op', changed: false, converted: 0, error: null };
  }
  const legacy = parseLegacyFacts(frontmatter.completion_facts);
  if (!legacy) return failure('ARTIFACT_FACT_CONVERSION_INVALID', 'completion_facts is neither valid version 1 nor version 2 data');
  try {
    const analysis = inspectArtifactDirectory(resolved.taskDir, 'analysis');
    if (analysis.status !== 'ready' || !analysis.latest) throw new Error('latest analysis artifact is required to recover lifecycle path');
    const pathState = parseLifecyclePathDecision(fs.readFileSync(analysis.latest.path, 'utf8'));
    if (pathState.status !== 'valid') throw new Error(pathState.message);
    const taskInput = `${extractSection(content, ['任务输入', 'Task Input'])}\n${extractSection(content, ['需求', 'Requirements'])}`;
    const converted = legacy.map((fact) => convertArtifactFact(
      fact, resolved.taskDir, taskInput, pathState.decision.path, resolved.repoRoot
    ));
    const open = currentOpenSelection(taskRef, content, resolved.repoRoot);
    if (open && open.family !== 'code') throw new Error('open legacy selection can only be converted when its request identity is recoverable');
    const openSelection = open ? {
      ...open,
      requestId: `code-task:${resolved.taskId}:${open.artifact}`
    } : null;
    const result = writeTask({
      taskRef,
      expectedState: resolved.state,
      dryRun: options.dryRun,
      mutations: [{
        kind: 'frontmatter',
        set: {
          completion_facts: JSON.stringify(converted),
          ...(openSelection ? { open_artifact_selection: JSON.stringify(openSelection) } : {})
        }
      }]
    }, { repoRoot: resolved.repoRoot });
    if (result.status === 'failed') return failure(result.error.code, result.error.message);
    return { status: result.status, changed: result.changed, converted: converted.length, error: null };
  } catch (error) {
    return failure('ARTIFACT_FACT_CONVERSION_INVALID', error instanceof Error ? error.message : String(error));
  }
}

export { convertCompletionFacts };
export type { ConversionResult };
