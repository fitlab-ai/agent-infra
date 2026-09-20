import fs from 'node:fs';
import path from 'node:path';

import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { scanVisibleMarkdown } from './markdown.ts';
import { parseArtifactName } from './artifact-name.ts';
import {
  hasOpenArtifactRound,
} from './artifact-lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { expectedQualificationRelations, validateQualificationAudit } from './qualification-audit.ts';
import { canonicalSemanticDigest, inspectArtifactPatterns, inspectArtifactStructure, sha256Content } from './artifact-operations.ts';
import { getArtifactSchema } from './artifact-schema.ts';

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
  | 'LOCAL_QUALIFICATION_AUDIT_INVALID';

type LocalArtifactDiagnostic = {
  code: LocalArtifactDiagnosticCode;
  message: string;
  line: number | null;
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
  diagnostics: readonly LocalArtifactDiagnostic[];
};

type LocalArtifactFinalizationRequest = {
  taskRef: string;
  family: LocalArtifactFamily;
  artifact: string;
  repoRoot?: string;
  requiredSections?: readonly string[];
  lockAlreadyHeld?: boolean;
};

type LocalArtifactFinalizationResult = {
  status: 'passed' | 'failed';
  changed: boolean;
  taskId: string | null;
  taskDir: string | null;
  family: LocalArtifactFamily;
  artifact: string;
  artifactSha256: string | null;
  semanticDigest: string | null;
  diagnostics: readonly LocalArtifactDiagnostic[];
  error: { code: string; message: string } | null;
};

function localDiagnosticCode(code: string): LocalArtifactDiagnosticCode {
  const map: Record<string, LocalArtifactDiagnosticCode> = {
    ARTIFACT_EMPTY: 'LOCAL_ARTIFACT_EMPTY',
    ARTIFACT_MISSING_SECTION: 'LOCAL_ARTIFACT_MISSING_SECTION',
    ARTIFACT_DUPLICATE_SECTION: 'LOCAL_ARTIFACT_DUPLICATE_SECTION',
    ARTIFACT_HEADING_TRAILING_PUNCTUATION: 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION'
  };
  return map[code] ?? 'LOCAL_STRUCTURAL_INVALID';
}

function localDiagnostic(item: { code: string; message: string; line: number | null }): LocalArtifactDiagnostic {
  return { code: localDiagnosticCode(item.code), message: item.message, line: item.line };
}

function isStatusPattern(pattern: string): boolean {
  return pattern === '^\\$ ';
}

function validateLocalArtifact(
  content: string,
  options: LocalArtifactValidationOptions
): LocalArtifactValidationResult {
  const schema = getArtifactSchema(options.family)!;
  const diagnostics: LocalArtifactDiagnostic[] = [];
  const scanned = scanVisibleMarkdown(content);
  const structure = inspectArtifactStructure(content, schema);
  for (const item of structure.diagnostics) diagnostics.push(localDiagnostic(item));

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
      for (const pattern of schema.requiredPatterns.filter(isStatusPattern)) {
        if (!new RegExp(pattern, 'm').test(body)) {
          diagnostics.push({ code: 'LOCAL_STATUS_COMMAND_MISSING', message: `status section '${statusHeading.text}' is missing required command output`, line: content.slice(0, statusHeading.start).split('\n').length });
        }
      }
    }
  }

  const patternInspection = inspectArtifactPatterns(content, {
    ...schema,
    requiredPatterns: schema.requiredPatterns.filter((item) => !isStatusPattern(item))
  });
  for (const item of patternInspection.diagnostics) diagnostics.push({ code: 'LOCAL_REQUIRED_PATTERN_MISSING', message: item.message, line: null });

  const decisionDetails = inspectDecisionDetailDuplicates(content);
  if (!decisionDetails.ok) diagnostics.push({ code: 'LOCAL_DECISION_DETAIL_DUPLICATE', message: decisionDetails.message, line: null });

  if (options.taskContent !== undefined) {
    const identity = options.artifact ? parseArtifactName(options.artifact) : null;
    const expected = identity?.family === options.family && hasOpenArtifactRound(options.taskContent, options.family, identity.round)
      ? expectedQualificationRelations(options.taskContent, options.family)
      : undefined;
    if (expected && !expected.ok) diagnostics.push({ code: 'LOCAL_QUALIFICATION_AUDIT_INVALID', message: `${expected.code}: ${expected.message}`, line: null });
    const qualification = validateQualificationAudit(options.taskContent, content, {
      family: options.family,
      artifact: options.artifact,
      expectedUpstreamRelations: expected?.ok ? expected.relations : undefined
    });
    if (!qualification.ok) diagnostics.push({ code: 'LOCAL_QUALIFICATION_AUDIT_INVALID', message: `${qualification.code}: ${qualification.message}`, line: null });
  }

  return {
    ok: diagnostics.length === 0,
    family: options.family,
    semanticDigest: canonicalSemanticDigest(content),
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
    diagnostics: [], error, ...extra
  };
}

type LocalArtifactPreparation = Readonly<{
  result: LocalArtifactFinalizationResult;
  content: string;
  repoRoot?: string;
  lockAlreadyHeld?: boolean;
}>;

function prepareLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  candidate?: string
): LocalArtifactPreparation {
  const failed = (code: string, message: string, extra: Partial<LocalArtifactFinalizationResult> = {}): LocalArtifactPreparation => ({
    result: failedFinalization(request, { code, message }, extra), content: candidate ?? ''
  });
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: request.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message);
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== request.family) return failed('ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${request.family}`);
  let taskContent: string;
  let content: string;
  try {
    taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
    const artifactPath = path.join(resolved.taskDir, request.artifact);
    if (!fs.statSync(artifactPath).isFile()) return failed('ARTIFACT_NOT_REGULAR', `artifact '${request.artifact}' is not a regular file`);
    content = candidate ?? fs.readFileSync(artifactPath, 'utf8');
  } catch (error) { return failed('ARTIFACT_NOT_READABLE', String(error)); }

  if (resolved.state !== 'active') {
    return failed('ARTIFACT_IDENTITY_INVALID', 'artifact finalization requires an active task');
  }
  const validation = validateLocalArtifact(content, {
    family: request.family, requiredSections: request.requiredSections, taskContent, artifact: request.artifact
  });
  const artifactSha256 = sha256Content(content);
  const result = failedFinalization(request, {
    code: 'LOCAL_ARTIFACT_INVALID',
    message: validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')
  }, {
    taskId: resolved.taskId, taskDir: resolved.taskDir, artifactSha256,
    semanticDigest: validation.semanticDigest, diagnostics: validation.diagnostics
  });

  // Trusted local operators edit the canonical artifact directly.  A
  // finalization result is a fresh observation of those bytes, never a
  // capability minted by an earlier recovery attempt or generation.
  return {
    result: validation.ok ? { ...result, status: 'passed', error: null } : result,
    content,
    repoRoot: resolved.repoRoot,
    lockAlreadyHeld: request.lockAlreadyHeld
  };

}

function commitLocalArtifactProvenance(
  prepared: LocalArtifactPreparation
): LocalArtifactFinalizationResult {
  return prepared.result;
}

function finalizeLocalArtifact(
  request: LocalArtifactFinalizationRequest
): LocalArtifactFinalizationResult {
  return prepareLocalArtifact(request).result;
}

/** Validate and seal an immutable preflight generation without publishing the formal artifact. */
function preflightLocalArtifact(
  request: LocalArtifactFinalizationRequest
): LocalArtifactFinalizationResult {
  const prepared = prepareLocalArtifact(request);
  return prepared.result;
}

export {
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  finalizeLocalArtifact,
  preflightLocalArtifact,
  prepareLocalArtifact,
  commitLocalArtifactProvenance,
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
  LocalArtifactPreparation,
  LocalArtifactValidationOptions,
  LocalArtifactValidationResult
};
