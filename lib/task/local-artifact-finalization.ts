import fs from 'node:fs';

import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { scanVisibleMarkdown } from './markdown.ts';
import { parseArtifactName } from './artifact-name.ts';
import {
  hasOpenArtifactRound,
  validateArtifactPublication,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { expectedQualificationRelations, validateQualificationAudit } from './qualification-audit.ts';
import { canonicalSemanticDigest, inspectArtifactPatterns, inspectArtifactStructure, sha256Content } from './artifact-operations.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { readArtifactRepairIntent, writeArtifactRepairIntent } from './artifact-repair-intent.ts';
import type { ArtifactRepairIntent } from './artifact-repair-intent.ts';

type LocalArtifactFamily = 'analysis' | 'plan' | 'code';

const LOCAL_ARTIFACT_REQUIRED_SECTIONS: Readonly<Record<LocalArtifactFamily, readonly string[]>> = {
  analysis: getArtifactSchema('analysis')!.sections.map((section) => section.headings.zh),
  plan: getArtifactSchema('plan')!.sections.map((section) => section.headings.zh),
  code: getArtifactSchema('code')!.sections.map((section) => section.headings.zh)
};

type LocalArtifactDiagnosticCode =
  | 'LOCAL_ARTIFACT_EMPTY'
  | 'LOCAL_ARTIFACT_MISSING_SECTION'
  | 'LOCAL_ARTIFACT_DUPLICATE_SECTION'
  | 'LOCAL_STATUS_COMMAND_MISSING'
  | 'LOCAL_DECISION_DETAIL_DUPLICATE'
  | 'LOCAL_REQUIRED_PATTERN_MISSING'
  | 'LOCAL_STRUCTURAL_INVALID'
  | 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION'
  | 'LOCAL_REPAIR_PROVENANCE_CONFLICT'
  | 'LOCAL_REPAIR_BASELINE_MISMATCH'
  | 'LOCAL_QUALIFICATION_AUDIT_INVALID';

type LocalArtifactDiagnostic = {
  code: LocalArtifactDiagnosticCode;
  message: string;
  repairable: boolean;
  line: number | null;
  from?: string;
  to?: string;
  operation?: 'replace-line';
};

type LocalArtifactValidationOptions = {
  family: LocalArtifactFamily;
  requiredSections?: readonly string[];
  taskContent?: string;
  artifact?: string;
};

type LocalArtifactValidationResult = {
  ok: boolean;
  family: LocalArtifactFamily;
  semanticDigest: string;
  repairable: boolean;
  diagnostics: readonly LocalArtifactDiagnostic[];
};

type LocalArtifactFinalizationRequest = {
  taskRef: string;
  family: LocalArtifactFamily;
  artifact: string;
  repoRoot?: string;
  requiredSections?: readonly string[];
};

type LocalArtifactFinalizationResult = {
  status: 'passed' | 'failed';
  changed: false;
  taskId: string | null;
  taskDir: string | null;
  family: LocalArtifactFamily;
  artifact: string;
  artifactSha256: string | null;
  semanticDigest: string | null;
  repairable: boolean;
  diagnostics: readonly LocalArtifactDiagnostic[];
  error: { code: string; message: string } | null;
};

type LocalArtifactFinalizationIntent = ArtifactRepairIntent;

function consumeLocalArtifactFinalizationIntent(
  repoRoot: string,
  intent: LocalArtifactFinalizationIntent
): LocalArtifactFinalizationIntent {
  if (intent.state === 'consumed') return intent;
  if (intent.state !== 'passed') throw new Error('LOCAL_FINALIZATION_INTENT_INVALID: only passed provenance can be consumed');
  const consumed = { ...intent, state: 'consumed' as const };
  writeArtifactRepairIntent(repoRoot, consumed);
  return consumed;
}

function localDiagnosticCode(code: string): LocalArtifactDiagnosticCode | null {
  const map: Record<string, LocalArtifactDiagnosticCode> = {
    ARTIFACT_EMPTY: 'LOCAL_ARTIFACT_EMPTY',
    ARTIFACT_MISSING_SECTION: 'LOCAL_ARTIFACT_MISSING_SECTION',
    ARTIFACT_DUPLICATE_SECTION: 'LOCAL_ARTIFACT_DUPLICATE_SECTION',
    ARTIFACT_HEADING_TRAILING_PUNCTUATION: 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION'
  };
  return map[code] ?? 'LOCAL_STRUCTURAL_INVALID';
}

function localDiagnostic(
  item: { code: string; message: string; line: number | null; repairable: boolean; operation?: { kind: string; from: string; to: string } }
): LocalArtifactDiagnostic | null {
  const code = localDiagnosticCode(item.code);
  if (!code) return null;
  return {
    code,
    message: item.message,
    repairable: item.repairable,
    line: item.line,
    ...(item.operation?.kind === 'replace-line'
      ? { from: item.operation.from, to: item.operation.to, operation: 'replace-line' as const }
      : {})
  };
}

function isStatusPattern(pattern: string): boolean {
  return pattern === '^\\$ ';
}

function validateLocalArtifact(
  content: string,
  options: LocalArtifactValidationOptions
): LocalArtifactValidationResult {
  const schema = getArtifactSchema(options.family)!;
  const patterns = schema.requiredPatterns;
  const diagnostics: LocalArtifactDiagnostic[] = [];
  const scanned = scanVisibleMarkdown(content);
  const structure = inspectArtifactStructure(content, schema);
  for (const item of structure.diagnostics) {
    const mapped = localDiagnostic(item);
    if (mapped) diagnostics.push(mapped);
  }

  const statusSection = schema.sections.find((section) => section.id === 'state-check');
  if (statusSection) {
    const statusHeading = scanned.headings.find((heading) => (
      heading.level === 2 && [statusSection.headings.zh, statusSection.headings.en].some((name) => (
        heading.text === name || heading.text === `${name}:` || heading.text === `${name}：`
      ))
    ));
    if (statusHeading) {
      const next = scanned.headings.find((candidate) => candidate.start > statusHeading.start && candidate.level <= 2);
      const body = content.slice(statusHeading.end, next?.start ?? content.length);
      for (const pattern of patterns.filter(isStatusPattern)) {
        if (!new RegExp(pattern, 'm').test(body)) {
          diagnostics.push({ code: 'LOCAL_STATUS_COMMAND_MISSING', message: `status section '${statusHeading.text}' is missing required command output`, repairable: false, line: content.slice(0, statusHeading.start).split('\n').length });
        }
      }
    }
  }

  const patternInspection = inspectArtifactPatterns(content, {
    ...schema,
    requiredPatterns: patterns.filter((item) => !isStatusPattern(item))
  });
  for (const item of patternInspection.diagnostics) {
    diagnostics.push({ code: 'LOCAL_REQUIRED_PATTERN_MISSING', message: item.message, repairable: false, line: null });
  }

  const decisionDetails = inspectDecisionDetailDuplicates(content);
  if (!decisionDetails.ok) {
    diagnostics.push({ code: 'LOCAL_DECISION_DETAIL_DUPLICATE', message: decisionDetails.message, repairable: false, line: null });
  }

  if (options.taskContent !== undefined) {
    const expected = expectedQualificationRelations(options.taskContent, options.family);
    if (!expected.ok) {
      diagnostics.push({ code: 'LOCAL_QUALIFICATION_AUDIT_INVALID', message: `${expected.code}: ${expected.message}`, repairable: false, line: null });
    }
    const qualification = validateQualificationAudit(options.taskContent, content, {
      family: options.family === 'analysis' ? 'analysis' : options.family === 'plan' ? 'plan' : 'code',
      artifact: options.artifact,
      expectedUpstreamRelations: expected.ok ? expected.relations : undefined
    });
    if (!qualification.ok) {
      diagnostics.push({ code: 'LOCAL_QUALIFICATION_AUDIT_INVALID', message: `${qualification.code}: ${qualification.message}`, repairable: false, line: null });
    }
  }

  const repairable = structure.repair !== null && diagnostics.length === 1 && diagnostics[0]?.repairable === true;
  const semanticDigestValue = canonicalSemanticDigest(content, structure.repair);

  return {
    ok: diagnostics.length === 0,
    family: options.family,
    semanticDigest: semanticDigestValue,
    repairable,
    diagnostics
  };
}

function failedFinalization(
  request: LocalArtifactFinalizationRequest,
  error: { code: string; message: string },
  extra: Partial<LocalArtifactFinalizationResult> = {}
): LocalArtifactFinalizationResult {
  return {
    status: 'failed', changed: false,
    taskId: null, taskDir: null,
    family: request.family, artifact: request.artifact,
    artifactSha256: null, semanticDigest: null,
    repairable: false, diagnostics: [], error, ...extra
  };
}

type LocalArtifactPreparation = Readonly<{
  result: LocalArtifactFinalizationResult;
  content: string;
  repoRoot?: string;
  provenance?: ArtifactRepairIntent;
}>;

/** Read and validate once; callers publish this content before committing provenance. */
function prepareLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  candidate?: string
): LocalArtifactPreparation {
  const failed = (code: string, message: string): LocalArtifactPreparation => ({
    result: failedFinalization(request, { code, message }), content: candidate ?? ''
  });
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: request.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message);
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== request.family) return failed('ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${request.family}`);
  let content: string;
  let taskContent: string;
  try {
    taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
    if (candidate !== undefined) {
      const error = validateArtifactPublication(resolved.taskDir, request.family, request.artifact);
      if (error) return failed(error.code, error.message);
      if (resolved.state !== 'active' || !hasOpenArtifactRound(taskContent, request.family, parsed.round)) {
        return failed('ARTIFACT_IDENTITY_INVALID', 'candidate must match one open started round in an active task');
      }
      content = candidate;
    } else {
      const validated = validateCompletedArtifact(resolved.taskDir, request.family, request.artifact, parsed.round);
      if (!validated.ok) return failed(validated.error.code, validated.error.message);
      content = fs.readFileSync(validated.artifact.path, 'utf8');
    }
  } catch (error) { return failed('ARTIFACT_NOT_READABLE', String(error)); }
  const validation = validateLocalArtifact(content, {
    family: request.family, requiredSections: request.requiredSections, taskContent, artifact: request.artifact
  });
  const artifactSha256 = sha256Content(content);
  const { semanticDigest, repairable, diagnostics } = validation;
  const result = failedFinalization(request, {
    code: 'LOCAL_ARTIFACT_INVALID', message: diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')
  }, { taskId: resolved.taskId, taskDir: resolved.taskDir, artifactSha256, semanticDigest, repairable, diagnostics });
  const prepared = { result, content, repoRoot: resolved.repoRoot };
  const reject = (code: LocalArtifactDiagnosticCode, message: string): LocalArtifactPreparation => ({
    ...prepared, result: { ...result, repairable: false, error: { code, message },
      diagnostics: [{ code, message, repairable: false, line: null }] }
  });
  let intent: ArtifactRepairIntent | null;
  try { intent = readArtifactRepairIntent(resolved.repoRoot, resolved.taskId, request.family, request.artifact); }
  catch (error) {
    return { ...prepared, result: { ...result, repairable: false, diagnostics: [],
      error: { code: 'LOCAL_FINALIZATION_INTENT_INVALID', message: String(error) } } };
  }
  if (repairable) {
    if (intent && (intent.state !== 'awaiting-repair' || intent.baselineSemanticDigest !== semanticDigest)) {
      return reject('LOCAL_REPAIR_PROVENANCE_CONFLICT', 'a different local repair baseline is already recorded for this artifact');
    }
    if (intent) return prepared;
  } else {
    if (!validation.ok) return prepared;
    if (intent?.state === 'awaiting-repair' && intent.baselineSemanticDigest !== semanticDigest) {
      return reject('LOCAL_REPAIR_BASELINE_MISMATCH', 'the repaired artifact semantic digest does not match the recorded repair baseline');
    }
    if ((intent?.state === 'passed' || intent?.state === 'consumed')
      && (intent.artifactSha256 !== artifactSha256 || intent.semanticDigest !== semanticDigest)) {
      return reject('LOCAL_REPAIR_PROVENANCE_CONFLICT', 'the artifact changed after its finalization provenance was recorded');
    }
    prepared.result = { ...result, status: 'passed', error: null };
    if (intent?.state === 'consumed') return prepared;
  }
  return { ...prepared, provenance: {
    version: 1, taskId: resolved.taskId, family: request.family, artifact: request.artifact,
    state: repairable ? 'awaiting-repair' : 'passed',
    baselineSemanticDigest: repairable ? semanticDigest : intent?.baselineSemanticDigest ?? null,
    artifactSha256, semanticDigest
  } };
}

function commitLocalArtifactProvenance(prepared: LocalArtifactPreparation): LocalArtifactFinalizationResult {
  try {
    if (prepared.provenance) writeArtifactRepairIntent(prepared.repoRoot!, prepared.provenance);
    return prepared.result;
  } catch (error) {
    return { ...prepared.result, status: 'failed', error: {
      code: 'LOCAL_FINALIZATION_INTENT_WRITE_FAILED', message: String(error)
    } };
  }
}

function finalizeLocalArtifact(request: LocalArtifactFinalizationRequest): LocalArtifactFinalizationResult {
  return commitLocalArtifactProvenance(prepareLocalArtifact(request));
}

export {
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  consumeLocalArtifactFinalizationIntent,
  finalizeLocalArtifact,
  prepareLocalArtifact,
  commitLocalArtifactProvenance,
  readArtifactRepairIntent as readLocalArtifactFinalizationIntent,
  canonicalSemanticDigest as semanticDigest,
  sha256Content,
  validateLocalArtifact
};
export type {
  LocalArtifactDiagnostic,
  LocalArtifactDiagnosticCode,
  LocalArtifactFamily,
  LocalArtifactFinalizationRequest,
  LocalArtifactFinalizationResult,
  LocalArtifactFinalizationIntent,
  LocalArtifactPreparation,
  LocalArtifactValidationOptions,
  LocalArtifactValidationResult
};
