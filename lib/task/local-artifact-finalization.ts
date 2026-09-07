import fs from 'node:fs';

import { inspectDecisionDetailDuplicates, scanVisibleMarkdown } from './decision-details.ts';
import {
  parseArtifactName,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { expectedQualificationRelations, validateQualificationAudit } from './qualification-audit.ts';
import { canonicalSemanticDigest, inspectArtifactStructure, sha256Content } from './artifact-operations.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { readArtifactRepairIntent, writeArtifactRepairIntent } from './artifact-repair-intent.ts';
import type { ArtifactRepairIntent } from './artifact-repair-intent.ts';

type LocalArtifactFamily = 'analysis' | 'plan' | 'code';

const LOCAL_ARTIFACT_REQUIRED_SECTIONS: Readonly<Record<LocalArtifactFamily, readonly string[]>> = {
  analysis: getArtifactSchema('analysis')!.sections.map((section) => section.headings.zh),
  plan: getArtifactSchema('plan')!.sections.map((section) => section.headings.zh),
  code: getArtifactSchema('code')!.sections.map((section) => section.headings.zh)
};

const LOCAL_ARTIFACT_REQUIRED_PATTERNS = ['^\\$ '];

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
  requiredPatterns?: readonly string[];
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
  requiredPatterns?: readonly string[];
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

function readLocalArtifactFinalizationIntent(
  repoRoot: string,
  taskId: string,
  family: LocalArtifactFamily,
  artifact: string
): LocalArtifactFinalizationIntent | null {
  return readArtifactRepairIntent(repoRoot, taskId, family, artifact);
}

function writeLocalArtifactFinalizationIntent(repoRoot: string, value: LocalArtifactFinalizationIntent): void {
  writeArtifactRepairIntent(repoRoot, value);
}

function consumeLocalArtifactFinalizationIntent(
  repoRoot: string,
  intent: LocalArtifactFinalizationIntent
): LocalArtifactFinalizationIntent {
  if (intent.state === 'consumed') return intent;
  if (intent.state !== 'passed') throw new Error('LOCAL_FINALIZATION_INTENT_INVALID: only passed provenance can be consumed');
  const consumed = { ...intent, state: 'consumed' as const };
  writeLocalArtifactFinalizationIntent(repoRoot, consumed);
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
  const patterns = options.requiredPatterns ?? LOCAL_ARTIFACT_REQUIRED_PATTERNS;
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

  for (const pattern of patterns.filter((item) => !isStatusPattern(item))) {
    if (!new RegExp(pattern, 'm').test(content)) {
      diagnostics.push({ code: 'LOCAL_REQUIRED_PATTERN_MISSING', message: `artifact is missing required pattern '${pattern}'`, repairable: false, line: null });
    }
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

function provenanceFailure(
  request: LocalArtifactFinalizationRequest,
  resolved: { taskId: string; taskDir: string },
  content: string,
  artifactSha256: string,
  semanticDigestValue: string,
  code: LocalArtifactDiagnosticCode,
  message: string
): LocalArtifactFinalizationResult {
  return failedFinalization(request, { code, message }, {
    taskId: resolved.taskId,
    taskDir: resolved.taskDir,
    artifactSha256,
    semanticDigest: semanticDigestValue,
    diagnostics: [{ code, message, repairable: false, line: null }]
  });
}

function finalizeLocalArtifact(request: LocalArtifactFinalizationRequest): LocalArtifactFinalizationResult {
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: request.repoRoot });
  if (!resolved.ok) return failedFinalization(request, { code: resolved.code, message: resolved.message });
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== request.family) {
    return failedFinalization(request, {
      code: 'ARTIFACT_IDENTITY_INVALID',
      message: `artifact '${request.artifact}' does not match ${request.family}`
    }, { taskId: resolved.taskId, taskDir: resolved.taskDir });
  }
  const validated = validateCompletedArtifact(resolved.taskDir, request.family, request.artifact, parsed.round);
  if (!validated.ok) {
    return failedFinalization(request, validated.error, { taskId: resolved.taskId, taskDir: resolved.taskDir });
  }
  let content: string;
  try { content = fs.readFileSync(validated.artifact.path, 'utf8'); }
  catch (error) {
    return failedFinalization(request, { code: 'ARTIFACT_NOT_READABLE', message: String(error) }, {
      taskId: resolved.taskId, taskDir: resolved.taskDir
    });
  }
  let taskContent: string;
  try { taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8'); }
  catch (error) {
    return failedFinalization(request, { code: 'TASK_READ_FAILED', message: error instanceof Error ? error.message : String(error) }, {
      taskId: resolved.taskId, taskDir: resolved.taskDir
    });
  }
  const result = validateLocalArtifact(content, {
    family: request.family,
    requiredSections: request.requiredSections,
    requiredPatterns: request.requiredPatterns,
    taskContent,
    artifact: request.artifact
  });
  const artifactSha256 = sha256Content(content);
  let intent: LocalArtifactFinalizationIntent | null;
  try {
    intent = readLocalArtifactFinalizationIntent(resolved.repoRoot, resolved.taskId, request.family, request.artifact);
  } catch (error) {
    return failedFinalization(request, {
      code: 'LOCAL_FINALIZATION_INTENT_INVALID',
      message: error instanceof Error ? error.message : String(error)
    }, { taskId: resolved.taskId, taskDir: resolved.taskDir, artifactSha256, semanticDigest: result.semanticDigest });
  }
  if (result.repairable) {
    if (intent && (intent.state !== 'awaiting-repair' || intent.baselineSemanticDigest !== result.semanticDigest)) {
      return provenanceFailure(
        request, resolved, content, artifactSha256, result.semanticDigest,
        'LOCAL_REPAIR_PROVENANCE_CONFLICT',
        'a different local repair baseline is already recorded for this artifact'
      );
    }
    if (!intent) {
      try {
        writeLocalArtifactFinalizationIntent(resolved.repoRoot, {
          version: 1,
          taskId: resolved.taskId,
          family: request.family,
          artifact: request.artifact,
          state: 'awaiting-repair',
          baselineSemanticDigest: result.semanticDigest,
          artifactSha256,
          semanticDigest: result.semanticDigest
        });
      } catch (error) {
        return failedFinalization(request, {
          code: 'LOCAL_FINALIZATION_INTENT_WRITE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }, { taskId: resolved.taskId, taskDir: resolved.taskDir, artifactSha256, semanticDigest: result.semanticDigest });
      }
    }
    return {
      status: 'failed',
      changed: false,
      taskId: resolved.taskId,
      taskDir: resolved.taskDir,
      family: request.family,
      artifact: request.artifact,
      artifactSha256,
      semanticDigest: result.semanticDigest,
      repairable: true,
      diagnostics: result.diagnostics,
      error: {
        code: 'LOCAL_ARTIFACT_INVALID',
        message: result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')
      }
    };
  }
  if (!result.ok) {
    return {
      status: 'failed',
      changed: false,
      taskId: resolved.taskId,
      taskDir: resolved.taskDir,
      family: request.family,
      artifact: request.artifact,
      artifactSha256,
      semanticDigest: result.semanticDigest,
      repairable: false,
      diagnostics: result.diagnostics,
      error: {
        code: 'LOCAL_ARTIFACT_INVALID',
        message: result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')
      }
    };
  }
  if (intent?.state === 'awaiting-repair' && intent.baselineSemanticDigest !== result.semanticDigest) {
    return provenanceFailure(
      request, resolved, content, artifactSha256, result.semanticDigest,
      'LOCAL_REPAIR_BASELINE_MISMATCH',
      'the repaired artifact semantic digest does not match the recorded repair baseline'
    );
  }
  if ((intent?.state === 'passed' || intent?.state === 'consumed')
    && (intent.artifactSha256 !== artifactSha256 || intent.semanticDigest !== result.semanticDigest)) {
    return provenanceFailure(
      request, resolved, content, artifactSha256, result.semanticDigest,
      'LOCAL_REPAIR_PROVENANCE_CONFLICT',
      'the artifact changed after its finalization provenance was recorded'
    );
  }
  if (intent?.state === 'consumed') {
    return {
      status: 'passed',
      changed: false,
      taskId: resolved.taskId,
      taskDir: resolved.taskDir,
      family: request.family,
      artifact: request.artifact,
      artifactSha256,
      semanticDigest: result.semanticDigest,
      repairable: false,
      diagnostics: result.diagnostics,
      error: null
    };
  }
  try {
    writeLocalArtifactFinalizationIntent(resolved.repoRoot, {
      version: 1,
      taskId: resolved.taskId,
      family: request.family,
      artifact: request.artifact,
      state: 'passed',
      baselineSemanticDigest: intent?.baselineSemanticDigest ?? null,
      artifactSha256,
      semanticDigest: result.semanticDigest
    });
  } catch (error) {
    return failedFinalization(request, {
      code: 'LOCAL_FINALIZATION_INTENT_WRITE_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }, { taskId: resolved.taskId, taskDir: resolved.taskDir, artifactSha256, semanticDigest: result.semanticDigest });
  }
  return {
    status: result.ok ? 'passed' : 'failed',
    changed: false,
    taskId: resolved.taskId,
    taskDir: resolved.taskDir,
    family: request.family,
    artifact: request.artifact,
    artifactSha256,
    semanticDigest: result.semanticDigest,
    repairable: result.repairable,
    diagnostics: result.diagnostics,
    error: result.ok ? null : {
      code: 'LOCAL_ARTIFACT_INVALID',
      message: result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')
    }
  };
}

export {
  LOCAL_ARTIFACT_REQUIRED_PATTERNS,
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  consumeLocalArtifactFinalizationIntent,
  finalizeLocalArtifact,
  readLocalArtifactFinalizationIntent,
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
  LocalArtifactValidationOptions,
  LocalArtifactValidationResult
};
