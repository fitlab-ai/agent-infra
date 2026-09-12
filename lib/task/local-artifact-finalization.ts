import fs from 'node:fs';

import { inspectDecisionDetailDuplicates } from './decision-details.ts';
import { scanVisibleMarkdown } from './markdown.ts';
import { parseArtifactName } from './artifact-name.ts';
import {
  hasOpenArtifactRound,
  parseCodePlanInputReference,
  validateArtifactPublication,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { expectedQualificationRelations, validateQualificationAudit } from './qualification-audit.ts';
import { canonicalSemanticDigest, inspectArtifactPatterns, inspectArtifactStructure, sha256Content } from './artifact-operations.ts';
import { receiptForOutput } from './artifact-receipts.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { readArtifactRepairIntent, writeArtifactRepairIntent } from './artifact-repair-intent.ts';
import type { ArtifactRepairIntent } from './artifact-repair-intent.ts';
import { withTaskExecutionLock } from './task-execution-lock.ts';
import {
  consumeLifecycleRecoveryAttestation,
  lifecycleRecoveryAttestationDigest,
  validateLifecycleRecoveryAttestation
} from './control-authority.ts';
import type { LifecycleRecoveryAttestationV1 } from './control-authority.ts';

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

type LocalArtifactReopenRequest = {
  taskRef: string;
  family: LocalArtifactFamily;
  artifact: string;
  expectedSha256: string;
  expectedSemanticDigest: string;
  repoRoot?: string;
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

type LocalArtifactReopenResult = {
  status: 'applied' | 'failed';
  changed: boolean;
  taskId: string | null;
  taskDir: string | null;
  family: LocalArtifactFamily;
  artifact: string;
  artifactSha256: string | null;
  semanticDigest: string | null;
  error: { code: string; message: string } | null;
};

type LocalArtifactFinalizationIntent = ArtifactRepairIntent;

function authorityDigest(authority: LifecycleRecoveryAttestationV1): string {
  return lifecycleRecoveryAttestationDigest(authority);
}

function validFinalizerAuthority(
  authority: LifecycleRecoveryAttestationV1 | undefined,
  request: LocalArtifactFinalizationRequest,
  taskId: string
): boolean {
  if (!authority) return false;
  try { validateLifecycleRecoveryAttestation(authority); }
  catch { return false; }
  return authority.version === 1
    && authority.phase === 'artifact.finalize-local'
    && authority.taskId === taskId
    && authority.family === request.family
    && authority.artifact === request.artifact
    && authority.round === (parseArtifactName(request.artifact)?.round ?? 0)
    && authority.requestId.length > 0
    && authority.operationId.length > 0;
}

function consumeLocalArtifactFinalizationIntent(
  repoRoot: string,
  intent: LocalArtifactFinalizationIntent
): LocalArtifactFinalizationIntent {
  if (intent.state === 'consumed') return intent;
  if (intent.state !== 'passed') throw new Error('LOCAL_FINALIZATION_INTENT_INVALID: only passed provenance can be consumed');
  const consumed = { ...intent, state: 'consumed' as const, updatedAt: Date.now() };
  writeArtifactRepairIntent(repoRoot, consumed, { expected: intent });
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
  expectedIntent?: ArtifactRepairIntent | null;
}>;

/** Read and validate once; callers publish this content before committing provenance. */
function prepareLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  candidate?: string,
  authority?: LifecycleRecoveryAttestationV1
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
  const preparedBase = { result, content, repoRoot: resolved.repoRoot };
  if (authority !== undefined && !validFinalizerAuthority(authority, request, resolved.taskId)) {
    return {
      ...preparedBase,
      result: { ...result, repairable: false, error: {
        code: 'LOCAL_EXECUTION_AUTHORITY_INVALID',
        message: 'finalizer authority does not match the artifact tuple'
      }, diagnostics: [] }
    };
  }
  const reject = (code: LocalArtifactDiagnosticCode, message: string): LocalArtifactPreparation => ({
    ...prepared, result: { ...result, repairable: false, error: { code, message },
      diagnostics: [{ code, message, repairable: false, line: null }] }
  });
  let intent: ArtifactRepairIntent | null;
  try { intent = readArtifactRepairIntent(resolved.repoRoot, resolved.taskId, request.family, request.artifact); }
  catch (error) {
    return { ...preparedBase, result: { ...result, repairable: false, diagnostics: [],
      error: { code: 'LOCAL_FINALIZATION_INTENT_INVALID', message: String(error) } } };
  }
  const prepared = { ...preparedBase, expectedIntent: intent };
  if (intent && intent.recoveryOperationId !== null
    && (!authority || intent.recoveryOperationId !== authority.operationId)) {
    return reject('LOCAL_REPAIR_PROVENANCE_CONFLICT', 'local repair provenance is owned by another recovery operation');
  }
  if (repairable) {
    if (intent && (intent.state !== 'awaiting-repair' || intent.baselineSemanticDigest !== semanticDigest)) {
      return reject('LOCAL_REPAIR_PROVENANCE_CONFLICT', 'a different local repair baseline is already recorded for this artifact');
    }
    if (intent && !authority) return prepared;
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
  const timestamp = Date.now();
  return { ...prepared, provenance: {
    version: 2, taskId: resolved.taskId, family: request.family, artifact: request.artifact,
    state: repairable ? 'awaiting-repair' : 'passed',
    baselineSemanticDigest: repairable ? semanticDigest : intent?.baselineSemanticDigest ?? null,
    artifactSha256, semanticDigest,
    recoveryOperationId: authority?.operationId ?? intent?.recoveryOperationId ?? null,
    phase: authority?.phase ?? intent?.phase ?? null,
    authorityDigest: authority ? authorityDigest(authority) : intent?.authorityDigest ?? null,
    requestId: authority?.lifecycleRequestId ?? intent?.requestId ?? `local-finalize:${resolved.taskId}`,
    createdAt: intent?.createdAt ?? timestamp,
    updatedAt: timestamp
  } };
}

function commitLocalArtifactProvenance(prepared: LocalArtifactPreparation): LocalArtifactFinalizationResult {
  try {
    if (prepared.provenance) {
      writeArtifactRepairIntent(prepared.repoRoot!, prepared.provenance, { expected: prepared.expectedIntent ?? null });
    }
    return prepared.result;
  } catch (error) {
    return { ...prepared.result, status: 'failed', error: {
      code: 'LOCAL_FINALIZATION_INTENT_WRITE_FAILED', message: String(error)
    } };
  }
}

function finalizeLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  authority?: LifecycleRecoveryAttestationV1,
  options: Readonly<{ deferLifecycleRecoveryConsumption?: boolean }> = {}
): LocalArtifactFinalizationResult {
  const result = commitLocalArtifactProvenance(prepareLocalArtifact(request, undefined, authority));
  if (authority && !options.deferLifecycleRecoveryConsumption && result.status === 'passed') {
    try { consumeLifecycleRecoveryAttestation(authority); }
    catch (error) {
      return { ...result, status: 'failed', error: {
        code: 'LOCAL_EXECUTION_AUTHORITY_CONSUME_FAILED',
        message: error instanceof Error ? error.message : String(error)
      } };
    }
  }
  return result;
}

function failedReopen(
  request: LocalArtifactReopenRequest,
  error: { code: string; message: string },
  extra: Partial<LocalArtifactReopenResult> = {}
): LocalArtifactReopenResult {
  return {
    status: 'failed', changed: false,
    taskId: null, taskDir: null,
    family: request.family, artifact: request.artifact,
    artifactSha256: null, semanticDigest: null, error, ...extra
  };
}

function reopenLocalArtifactFinalizationUnlocked(
  request: LocalArtifactReopenRequest,
  repoRoot: string,
  resolvedTaskId: string,
  resolvedTaskDir: string,
  taskMdPath: string,
  taskState: string
): LocalArtifactReopenResult {
  const fail = (code: string, message: string, extra: Partial<LocalArtifactReopenResult> = {}) =>
    failedReopen(request, { code, message }, { taskId: resolvedTaskId, taskDir: resolvedTaskDir, ...extra });
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== request.family) {
    return fail('ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${request.family}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(request.expectedSha256) || !/^[a-f0-9]{64}$/u.test(request.expectedSemanticDigest)) {
    return fail('LOCAL_REOPEN_PROVENANCE_INVALID', 'reopen requires lowercase 64-character digests');
  }
  if (request.family !== 'analysis' && request.family !== 'plan' && request.family !== 'code') {
    return fail('LOCAL_REOPEN_FAMILY_INVALID', 'reopen-finalization only supports analysis, plan, and code artifacts');
  }
  let taskContent: string;
  let artifactContent: string;
  try {
    taskContent = fs.readFileSync(taskMdPath, 'utf8');
    const completed = validateCompletedArtifact(resolvedTaskDir, request.family, request.artifact, parsed.round);
    if (!completed.ok) return fail('LOCAL_REOPEN_ARTIFACT_INVALID', completed.error.message);
    artifactContent = fs.readFileSync(completed.artifact.path, 'utf8');
  } catch (error) {
    return fail('LOCAL_REOPEN_NOT_READABLE', String(error));
  }
  if (taskState !== 'active' || !hasOpenArtifactRound(taskContent, request.family, parsed.round)) {
    return fail('LOCAL_REOPEN_CONTEXT_INVALID', 'reopen requires an active task with exactly one open started round');
  }
  try {
    if (receiptForOutput(taskContent, request.artifact)) {
      return fail('LOCAL_REOPEN_ALREADY_COMPLETED', `completion receipt already exists for ${request.artifact}`);
    }
  } catch (error) {
    return fail('LOCAL_REOPEN_RECEIPT_INVALID', String(error));
  }
  const validation = validateLocalArtifact(artifactContent, {
    family: request.family, taskContent, artifact: request.artifact
  });
  if (!validation.ok) {
    return fail('LOCAL_REOPEN_ARTIFACT_INVALID', validation.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '), {
      artifactSha256: sha256Content(artifactContent), semanticDigest: validation.semanticDigest
    });
  }
  const artifactSha256 = sha256Content(artifactContent);
  let intent: ArtifactRepairIntent | null;
  try { intent = readArtifactRepairIntent(repoRoot, resolvedTaskId, request.family, request.artifact); }
  catch (error) { return fail('LOCAL_REOPEN_PROVENANCE_INVALID', String(error)); }
  if (intent && (!['passed', 'awaiting-repair'].includes(intent.state)
    || intent.artifactSha256 !== request.expectedSha256
    || intent.semanticDigest !== request.expectedSemanticDigest)) {
    return fail('LOCAL_REOPEN_PROVENANCE_MISMATCH', 'expected provenance does not match the previously passed or reopened finalizer intent');
  }
  if (!intent
    && (artifactSha256 !== request.expectedSha256 || validation.semanticDigest !== request.expectedSemanticDigest)
    && !(request.family === 'code' && parseCodePlanInputReference(artifactContent) !== null)) {
    return fail('LOCAL_REOPEN_PROVENANCE_MISMATCH', 'without a finalizer intent, current artifact digests or canonical code input must match the supplied finalizer result');
  }
  const timestamp = Date.now();
  const reopened: ArtifactRepairIntent = {
    ...(intent ?? {
      version: 2,
      taskId: resolvedTaskId,
      family: request.family,
      artifact: request.artifact,
      createdAt: timestamp
    }),
    state: 'awaiting-repair',
    baselineSemanticDigest: validation.semanticDigest,
    artifactSha256,
    semanticDigest: validation.semanticDigest,
    recoveryOperationId: null,
    phase: null,
    authorityDigest: null,
    requestId: intent?.requestId ?? `local-reopen:${resolvedTaskId}:${request.artifact}`,
    updatedAt: timestamp
  };
  try {
    writeArtifactRepairIntent(repoRoot, reopened, { expected: intent });
  } catch (error) {
    return fail('LOCAL_REOPEN_PROVENANCE_WRITE_FAILED', String(error), { artifactSha256, semanticDigest: validation.semanticDigest });
  }
  return {
    status: 'applied', changed: true,
    taskId: resolvedTaskId, taskDir: resolvedTaskDir,
    family: request.family, artifact: request.artifact,
    artifactSha256, semanticDigest: validation.semanticDigest, error: null
  };
}

function reopenLocalArtifactFinalization(request: LocalArtifactReopenRequest): LocalArtifactReopenResult {
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: request.repoRoot });
  if (!resolved.ok) return failedReopen(request, { code: resolved.code, message: resolved.message });
  try {
    return withTaskExecutionLock(resolved.repoRoot, resolved.taskId, 'task-artifact.reopen-finalization', () => (
      reopenLocalArtifactFinalizationUnlocked(request, resolved.repoRoot, resolved.taskId, resolved.taskDir, resolved.taskMdPath, resolved.state)
    ));
  } catch (error) {
    return failedReopen(request, { code: 'LOCAL_REOPEN_LOCK_FAILED', message: String(error) }, {
      taskId: resolved.taskId, taskDir: resolved.taskDir
    });
  }
}

export {
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  consumeLocalArtifactFinalizationIntent,
  finalizeLocalArtifact,
  reopenLocalArtifactFinalization,
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
  LocalArtifactReopenRequest,
  LocalArtifactReopenResult,
  LocalArtifactFinalizationIntent,
  LocalArtifactPreparation,
  LocalArtifactValidationOptions,
  LocalArtifactValidationResult
};
