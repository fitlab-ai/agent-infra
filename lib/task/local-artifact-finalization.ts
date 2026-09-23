import fs from 'node:fs';
import path from 'node:path';

import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { parseArtifactName } from './artifact-name.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { canonicalSemanticDigest, inspectArtifactContract, sha256Content } from './artifact-operations.ts';
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
  | 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION';

type LocalArtifactDiagnostic = {
  code: LocalArtifactDiagnosticCode;
  message: string;
  line: number | null;
};

type LocalArtifactValidationOptions = {
  family: LocalArtifactFamily;
  requiredSections?: readonly string[];
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
    ARTIFACT_HEADING_TRAILING_PUNCTUATION: 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION',
    ARTIFACT_STATE_CHECK_PATTERN_MISSING: 'LOCAL_STATUS_COMMAND_MISSING',
    ARTIFACT_REQUIRED_PATTERN_MISSING: 'LOCAL_REQUIRED_PATTERN_MISSING'
  };
  return map[code] ?? 'LOCAL_STRUCTURAL_INVALID';
}

function localDiagnostic(item: { code: string; message: string; line: number | null }): LocalArtifactDiagnostic {
  return { code: localDiagnosticCode(item.code), message: item.message, line: item.line };
}

function validateLocalArtifact(
  content: string,
  options: LocalArtifactValidationOptions
): LocalArtifactValidationResult {
  const schema = getArtifactSchema(options.family)!;
  const diagnostics: LocalArtifactDiagnostic[] = [];
  const inspection = inspectArtifactContract(content, schema, { scopeStateCheckSection: true });
  for (const item of inspection.diagnostics) diagnostics.push(localDiagnostic(item));

  const decisionDetails = inspectDecisionDetailDuplicates(content);
  if (!decisionDetails.ok) diagnostics.push({ code: 'LOCAL_DECISION_DETAIL_DUPLICATE', message: decisionDetails.message, line: null });

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
  let content: string;
  try {
    const artifactPath = path.join(resolved.taskDir, request.artifact);
    if (!fs.statSync(artifactPath).isFile()) return failed('ARTIFACT_NOT_REGULAR', `artifact '${request.artifact}' is not a regular file`);
    content = candidate ?? fs.readFileSync(artifactPath, 'utf8');
  } catch (error) { return failed('ARTIFACT_NOT_READABLE', String(error)); }

  if (resolved.state !== 'active') {
    return failed('ARTIFACT_IDENTITY_INVALID', 'artifact finalization requires an active task');
  }
  const validation = validateLocalArtifact(content, {
    family: request.family, requiredSections: request.requiredSections
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
