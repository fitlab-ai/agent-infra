import { createHash } from 'node:crypto';

import type { ArtifactFamily } from './artifact-name.ts';

const ARTIFACT_FAMILIES: readonly ArtifactFamily[] = [
  'analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code',
  'manual-validation', 'validation-run'
];

type SelectionArtifact = Readonly<{
  family: ArtifactFamily;
  round: number;
  name: string;
}>;

type ArtifactDisposition = 'create-base' | 'resume-open' | 'reuse-completed' | 'create-next';

type CompletionFactV2 = Readonly<{
  version: 2;
  event: string;
  output: string;
  outputSha256: string;
  semanticDigest: string;
  requestId: string;
  result: string;
  inputDigest: string;
  resultDigest: string;
  changeEvidenceDigest: string | null;
  selectionReason: string;
}>;

type OpenArtifactSelection = Readonly<{
  version: 1;
  family: ArtifactFamily;
  artifact: string;
  round: number;
  inputDigest: string;
  changeEvidenceDigest: string | null;
  selectionReason: string;
  requestId: string;
}>;

type CompletionFactParseResult =
  | Readonly<{ ok: true; facts: readonly CompletionFactV2[] }>
  | Readonly<{ ok: false; code: 'ARTIFACT_SELECTION_FACT_INVALID' | 'ARTIFACT_SELECTION_FACT_VERSION_UNSUPPORTED'; message: string }>;

type ArtifactSelection = Readonly<{
  disposition: ArtifactDisposition;
  reasonCode: string;
  artifact: SelectionArtifact;
  writeRequired: boolean;
  inputDigest: string;
  changeEvidenceDigest: string | null;
  observedResultDigest: string | null;
  priorCompleted: SelectionArtifact | null;
}>;

type ArtifactInputDigestRequest = Readonly<{
  family: ArtifactFamily;
  taskInput: string;
  lifecyclePath: string;
  upstream: readonly Readonly<{
    family: ArtifactFamily;
    artifact: string;
    round: number;
    sha256: string;
    relation: string;
  }>[];
  changeEvidenceDigest?: string | null;
  implementationSnapshot?: Readonly<{
    head: string;
    headTree: string;
    worktreeTree: string;
    deliveryRemote: string;
    deliveryBaseRef: string;
  }> | null;
}>;

type ArtifactSelectionRequest = Readonly<{
  family: ArtifactFamily;
  next: SelectionArtifact;
  latest: SelectionArtifact | null;
  open: boolean;
  inputDigest: string;
  resultDigest: string | null;
  changeEvidenceDigest: string | null;
  completionFact: CompletionFactV2 | null;
}>;

const SHA256_RE = /^[a-f0-9]{64}$/u;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildArtifactInputDigest(request: ArtifactInputDigestRequest): string {
  return digest({
    family: request.family,
    taskInput: request.taskInput.normalize('NFKC').replace(/\s+/g, ' ').trim(),
    lifecyclePath: request.lifecyclePath,
    upstream: [...request.upstream]
      .map((row) => ({
        family: row.family,
        artifact: row.artifact,
        round: row.round,
        sha256: row.sha256,
        relation: row.relation
      }))
      .sort((left, right) => left.family.localeCompare(right.family)
        || left.round - right.round
        || left.artifact.localeCompare(right.artifact)
        || left.relation.localeCompare(right.relation)),
    ...(request.implementationSnapshot ? { implementationSnapshot: request.implementationSnapshot } : {})
  });
}

function parseCompletionFacts(encoded: unknown): CompletionFactParseResult {
  if (encoded === undefined || encoded === null || encoded === '') return { ok: true, facts: [] };
  if (typeof encoded !== 'string') return { ok: false, code: 'ARTIFACT_SELECTION_FACT_INVALID', message: 'completion_facts must be encoded as a JSON string' };
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); }
  catch { return { ok: false, code: 'ARTIFACT_SELECTION_FACT_INVALID', message: 'completion_facts is not valid JSON' }; }
  if (!Array.isArray(parsed)) return { ok: false, code: 'ARTIFACT_SELECTION_FACT_INVALID', message: 'completion_facts must contain an array' };
  const facts: CompletionFactV2[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, code: 'ARTIFACT_SELECTION_FACT_INVALID', message: 'completion fact must be an object' };
    }
    const row = value as Record<string, unknown>;
    if (row.version !== 2) {
      return {
        ok: false,
        code: 'ARTIFACT_SELECTION_FACT_VERSION_UNSUPPORTED',
        message: 'completion fact requires explicit conversion to version 2; run task-artifact convert-facts'
      };
    }
    const nullableDigest = row.changeEvidenceDigest === null || SHA256_RE.test(String(row.changeEvidenceDigest ?? ''));
    if (
      typeof row.event !== 'string' || !row.event
      || typeof row.output !== 'string' || !row.output
      || !SHA256_RE.test(String(row.outputSha256 ?? ''))
      || !SHA256_RE.test(String(row.semanticDigest ?? ''))
      || typeof row.requestId !== 'string'
      || typeof row.result !== 'string'
      || !SHA256_RE.test(String(row.inputDigest ?? ''))
      || !SHA256_RE.test(String(row.resultDigest ?? ''))
      || !nullableDigest
      || typeof row.selectionReason !== 'string' || !row.selectionReason
    ) {
      return { ok: false, code: 'ARTIFACT_SELECTION_FACT_INVALID', message: `completion fact for '${String(row.output ?? '')}' is invalid` };
    }
    facts.push({
      version: 2,
      event: row.event,
      output: row.output,
      outputSha256: String(row.outputSha256),
      semanticDigest: String(row.semanticDigest),
      requestId: row.requestId,
      result: row.result,
      inputDigest: String(row.inputDigest),
      resultDigest: String(row.resultDigest),
      changeEvidenceDigest: row.changeEvidenceDigest === null ? null : String(row.changeEvidenceDigest),
      selectionReason: row.selectionReason
    });
  }
  return { ok: true, facts };
}

function parseOpenArtifactSelection(encoded: unknown): OpenArtifactSelection | null {
  if (typeof encoded !== 'string' || !encoded) return null;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1
    || !ARTIFACT_FAMILIES.includes(row.family as ArtifactFamily)
    || typeof row.artifact !== 'string' || !row.artifact
    || !Number.isInteger(row.round) || Number(row.round) < 1
    || !SHA256_RE.test(String(row.inputDigest ?? ''))
    || !(row.changeEvidenceDigest === null || SHA256_RE.test(String(row.changeEvidenceDigest ?? '')))
    || typeof row.selectionReason !== 'string' || !row.selectionReason
    || typeof row.requestId !== 'string') return null;
  return {
    version: 1,
    family: row.family as ArtifactFamily,
    artifact: row.artifact,
    round: Number(row.round),
    inputDigest: String(row.inputDigest),
    changeEvidenceDigest: row.changeEvidenceDigest === null ? null : String(row.changeEvidenceDigest),
    selectionReason: row.selectionReason,
    requestId: row.requestId
  };
}

function selectArtifactDisposition(request: ArtifactSelectionRequest): ArtifactSelection {
  if (request.open) {
    return {
      disposition: 'resume-open', reasonCode: 'open-round', artifact: request.next,
      writeRequired: true, inputDigest: request.inputDigest,
      changeEvidenceDigest: request.changeEvidenceDigest,
      observedResultDigest: request.resultDigest, priorCompleted: request.latest
    };
  }
  if (!request.latest) {
    return {
      disposition: request.next.round === 1 ? 'create-base' : 'create-next',
      reasonCode: request.next.round === 1 ? 'no-history' : 'invalidated-history',
      artifact: request.next, writeRequired: true, inputDigest: request.inputDigest,
      changeEvidenceDigest: request.changeEvidenceDigest,
      observedResultDigest: request.resultDigest, priorCompleted: null
    };
  }
  const fact = request.completionFact;
  if (!fact || fact.output !== request.latest.name) {
    return {
      disposition: 'create-next', reasonCode: 'completion-fact-missing', artifact: request.next,
      writeRequired: true, inputDigest: request.inputDigest,
      changeEvidenceDigest: request.changeEvidenceDigest,
      observedResultDigest: request.resultDigest, priorCompleted: request.latest
    };
  }
  const reasonCode = request.changeEvidenceDigest && request.changeEvidenceDigest !== fact.changeEvidenceDigest
    ? 'change-evidence'
    : request.inputDigest !== fact.inputDigest
      ? 'input-changed'
      : request.resultDigest !== fact.resultDigest
        ? 'result-changed'
        : 'substantive-identity-matched';
  const reuse = reasonCode === 'substantive-identity-matched';
  return {
    disposition: reuse ? 'reuse-completed' : 'create-next',
    reasonCode,
    artifact: reuse ? request.latest : request.next,
    writeRequired: !reuse,
    inputDigest: request.inputDigest,
    changeEvidenceDigest: request.changeEvidenceDigest,
    observedResultDigest: request.resultDigest,
    priorCompleted: request.latest
  };
}

export {
  buildArtifactInputDigest,
  parseCompletionFacts,
  parseOpenArtifactSelection,
  selectArtifactDisposition
};
export type {
  ArtifactDisposition,
  ArtifactInputDigestRequest,
  ArtifactSelection,
  ArtifactSelectionRequest,
  CompletionFactParseResult,
  CompletionFactV2,
  OpenArtifactSelection,
  SelectionArtifact
};
