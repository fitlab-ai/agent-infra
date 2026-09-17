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
import { readArtifactRecoveryIntent } from './artifact-repair-intent.ts';
import type { ArtifactRecoveryIntent } from './artifact-repair-intent.ts';
import {
  beginArtifactRecovery,
  commitArtifactRecovery,
  consumeArtifactRecovery,
  prepareArtifactRecoveryFinal,
  prepareArtifactRecoveryCommit,
  recordArtifactRecoveryPassed,
  reconcileArtifactRecovery,
  recoveryContextFromIntent,
  stageArtifactCandidate
} from './artifact-recovery.ts';
import type { ArtifactRecoveryContext } from './artifact-recovery.ts';
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
  | 'LOCAL_RECOVERY_PROVENANCE_CONFLICT'
  | 'LOCAL_RECOVERY_BASELINE_MISMATCH'
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
  recoveryId?: string;
  lockAlreadyHeld?: boolean;
};

type LocalArtifactRecoveryInfo = Readonly<{
  recoveryId: string;
  candidatePath: string;
  baselineSha256: string;
  baselineSemanticDigest: string;
}>;

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
  recovery?: LocalArtifactRecoveryInfo;
  error: { code: string; message: string } | null;
};

type LocalArtifactFinalizationIntent = ArtifactRecoveryIntent;

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

function recoveryInfo(context: ArtifactRecoveryContext): LocalArtifactRecoveryInfo {
  return {
    recoveryId: context.recoveryId,
    candidatePath: context.stagingPath,
    baselineSha256: context.baselineSha256,
    baselineSemanticDigest: context.baselineSemanticDigest
  };
}

function consumeLocalArtifactFinalizationIntent(
  repoRoot: string,
  intent: LocalArtifactFinalizationIntent,
  options: Readonly<{ lockAlreadyHeld?: boolean }> = {}
): LocalArtifactFinalizationIntent {
  if (intent.state === 'consumed') return intent;
  const resolved = resolveTaskRef(intent.taskId, { repoRoot });
  if (!resolved.ok) throw new Error(resolved.message);
  return consumeArtifactRecovery(recoveryContextFromIntent(repoRoot, resolved.taskDir, intent), options);
}

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
  recovery?: ArtifactRecoveryContext;
  authority?: LifecycleRecoveryAttestationV1;
}>;

function tupleFor(
  request: LocalArtifactFinalizationRequest,
  taskId: string,
  authority?: LifecycleRecoveryAttestationV1
) {
  const round = parseArtifactName(request.artifact)?.round ?? 0;
  return {
    taskId,
    family: request.family,
    artifact: request.artifact,
    round,
    requestId: authority?.lifecycleRequestId ?? `local-finalize:${taskId}:${request.family}:${round}`,
    phase: authority?.phase ?? 'artifact.finalize-local' as const,
    authorityDigest: authority ? authorityDigest(authority) : null
  };
}

function prepareLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  candidate?: string,
  authority?: LifecycleRecoveryAttestationV1,
  preflightOnly = false
): LocalArtifactPreparation {
  const failed = (code: string, message: string, extra: Partial<LocalArtifactFinalizationResult> = {}): LocalArtifactPreparation => ({
    result: failedFinalization(request, { code, message }, extra), content: candidate ?? ''
  });
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: request.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message);
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== request.family) return failed('ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${request.family}`);
  if (authority && !validFinalizerAuthority(authority, request, resolved.taskId)) {
    return failed('LOCAL_EXECUTION_AUTHORITY_INVALID', 'finalizer authority does not match the artifact tuple');
  }

  let taskContent: string;
  let content: string;
  let recovery: ArtifactRecoveryContext | undefined;
  let recoveryState: ArtifactRecoveryIntent['state'] | undefined;
  try {
    taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
    if (request.recoveryId) {
      const intent = readArtifactRecoveryIntent(resolved.repoRoot, resolved.taskId, request.family, request.artifact);
      if (!intent || intent.recoveryOperationId !== request.recoveryId) return failed('LOCAL_RECOVERY_PROVENANCE_CONFLICT', 'recovery id does not match the artifact journal');
      if (!['awaiting-preflight-recovery', 'preflight-ready', 'preflight-commit-started', 'preflight-passed', 'full-finalizer-ready', 'commit-started'].includes(intent.state)) return failed('LOCAL_RECOVERY_PROVENANCE_CONFLICT', `recovery journal is in '${intent.state}' state`);
      recoveryState = intent.state;
      recovery = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, intent);
      content = fs.existsSync(recovery.stagingPath)
        ? fs.readFileSync(recovery.stagingPath, 'utf8')
        : fs.readFileSync(recovery.formalPath, 'utf8');
    } else {
      const validated = validateCompletedArtifact(resolved.taskDir, request.family, request.artifact, parsed.round);
      if (!validated.ok) return failed(validated.error.code, validated.error.message);
      content = candidate ?? fs.readFileSync(validated.artifact.path, 'utf8');
    }
  } catch (error) { return failed('ARTIFACT_NOT_READABLE', String(error)); }

  if (resolved.state !== 'active' || !hasOpenArtifactRound(taskContent, request.family, parsed.round)) {
    return failed('ARTIFACT_IDENTITY_INVALID', 'candidate must match one open started round in an active task');
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

  if (request.recoveryId) {
    if (!validation.ok) return { result, content, repoRoot: resolved.repoRoot, recovery, authority, lockAlreadyHeld: request.lockAlreadyHeld };
    if (preflightOnly && recovery && recoveryState === 'awaiting-preflight-recovery') {
      const staged = stageArtifactCandidate(recovery, Buffer.from(content, 'utf8'), { lockAlreadyHeld: request.lockAlreadyHeld });
      prepareArtifactRecoveryCommit(recovery, staged.candidateSha256, staged.semanticDigest, { lockAlreadyHeld: request.lockAlreadyHeld });
    }
    return {
      result: { ...result, status: 'passed', changed: false, error: null, recovery: recoveryInfo(recovery!) },
      content, repoRoot: resolved.repoRoot, recovery, authority, lockAlreadyHeld: request.lockAlreadyHeld
    };
  }

  const existing = readArtifactRecoveryIntent(resolved.repoRoot, resolved.taskId, request.family, request.artifact);
  if (existing?.state === 'passed' || existing?.state === 'consumed') {
    if (existing.state === 'consumed' && (existing.finalArtifactSha256 !== artifactSha256 || existing.finalSemanticDigest !== validation.semanticDigest)) {
      return { ...failed('LOCAL_RECOVERY_PROVENANCE_CONFLICT', 'formal artifact does not match its completed recovery journal'), content, repoRoot: resolved.repoRoot, authority, lockAlreadyHeld: request.lockAlreadyHeld };
    }
    if (existing.finalArtifactSha256 === artifactSha256 && existing.finalSemanticDigest === validation.semanticDigest) {
      const context = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, existing);
      return {
        result: { ...result, status: 'passed', error: null, recovery: recoveryInfo(context) },
        content, repoRoot: resolved.repoRoot, recovery: context, authority, lockAlreadyHeld: request.lockAlreadyHeld
      };
    }
  }

  if (existing && ['preflight-ready', 'preflight-commit-started', 'preflight-passed', 'full-finalizer-ready'].includes(existing.state)) {
    const context = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, existing);
    return {
      result: { ...result, status: 'passed', changed: false, error: null, recovery: recoveryInfo(context) },
      content, repoRoot: resolved.repoRoot, recovery: context, authority, lockAlreadyHeld: request.lockAlreadyHeld
    };
  }
  if (existing?.state === 'commit-started') {
    if (existing.finalArtifactSha256 !== artifactSha256 || existing.finalSemanticDigest !== validation.semanticDigest) {
      return { ...failed('LOCAL_RECOVERY_PROVENANCE_CONFLICT', 'formal artifact does not match the interrupted recovery journal'), content, repoRoot: resolved.repoRoot, authority, lockAlreadyHeld: request.lockAlreadyHeld };
    }
    const context = recoveryContextFromIntent(resolved.repoRoot, resolved.taskDir, existing);
    const reconciled = reconcileArtifactRecovery(context, {
      lockAlreadyHeld: request.lockAlreadyHeld,
      validateFinal: () => validation.semanticDigest === existing.finalSemanticDigest
    });
    if (reconciled.status !== 'passed') {
      return { ...failed('LOCAL_RECOVERY_PROVENANCE_CONFLICT', `interrupted recovery could not be reconciled: ${reconciled.status}`), content, repoRoot: resolved.repoRoot, recovery: context, authority, lockAlreadyHeld: request.lockAlreadyHeld };
    }
    return {
      result: { ...result, status: 'passed', changed: false, error: null, recovery: recoveryInfo(context) },
      content, repoRoot: resolved.repoRoot, recovery: context, authority, lockAlreadyHeld: request.lockAlreadyHeld
    };
  }

  try {
    if (validation.ok) {
      if (preflightOnly) {
        const context = beginArtifactRecovery(tupleFor(request, resolved.taskId, authority), Buffer.from(content, 'utf8'), {
          repoRoot: resolved.repoRoot, taskDir: resolved.taskDir,
          ...(authority ? { recoveryId: authority.operationId } : {}), lockAlreadyHeld: request.lockAlreadyHeld
        });
        const staged = stageArtifactCandidate(context, Buffer.from(content, 'utf8'), { lockAlreadyHeld: request.lockAlreadyHeld });
        prepareArtifactRecoveryCommit(context, staged.candidateSha256, staged.semanticDigest, { lockAlreadyHeld: request.lockAlreadyHeld });
        return { result: { ...result, status: 'passed', error: null, recovery: recoveryInfo(context) }, content, repoRoot: resolved.repoRoot, recovery: context, authority, lockAlreadyHeld: request.lockAlreadyHeld };
      }
      const context = recordArtifactRecoveryPassed(tupleFor(request, resolved.taskId, authority), {
        repoRoot: resolved.repoRoot,
        taskDir: resolved.taskDir,
        expectedFinalSha256: artifactSha256,
        expectedFinalSemanticDigest: validation.semanticDigest,
        ...(authority ? { recoveryId: authority.operationId } : {}),
        lockAlreadyHeld: request.lockAlreadyHeld
      });
      recovery = context;
      return { result: { ...result, status: 'passed', changed: false, error: null, recovery: recoveryInfo(context) }, content, repoRoot: resolved.repoRoot, recovery, authority, lockAlreadyHeld: request.lockAlreadyHeld };
    }
    const context = beginArtifactRecovery(tupleFor(request, resolved.taskId, authority), Buffer.from(content, 'utf8'), {
      repoRoot: resolved.repoRoot,
      taskDir: resolved.taskDir,
      ...(authority ? { recoveryId: authority.operationId } : {}),
      lockAlreadyHeld: request.lockAlreadyHeld
    });
    recovery = context;
    return {
      result: { ...result, recovery: recoveryInfo(context) },
      content, repoRoot: resolved.repoRoot, recovery, authority, lockAlreadyHeld: request.lockAlreadyHeld
    };
  } catch (error) {
    return { ...failed('LOCAL_RECOVERY_PROVENANCE_CONFLICT', String(error)), content, repoRoot: resolved.repoRoot, authority, lockAlreadyHeld: request.lockAlreadyHeld };
  }
}

function commitLocalArtifactProvenance(
  prepared: LocalArtifactPreparation,
  options: Readonly<{ afterPublish?: () => void }> = {}
): LocalArtifactFinalizationResult {
  if (!prepared.recovery || !prepared.repoRoot || prepared.result.status === 'failed' && !prepared.result.recovery) return prepared.result;
  if (prepared.result.status === 'failed') return prepared.result;
  try {
    const intent = readArtifactRecoveryIntent(prepared.repoRoot, prepared.recovery.taskId, prepared.recovery.family, prepared.recovery.artifact);
    if (!intent) throw new Error('ARTIFACT_RECOVERY_INTENT_MISSING');
    let committed;
    if (intent.state === 'passed' || intent.state === 'consumed') {
      return {
        ...prepared.result,
        changed: false,
        artifactSha256: intent.finalArtifactSha256,
        semanticDigest: intent.finalSemanticDigest,
        error: null
      };
    } else if (intent.state === 'commit-started') {
      const reconciled = reconcileArtifactRecovery(prepared.recovery, {
        lockAlreadyHeld: prepared.lockAlreadyHeld,
        afterPublish: options.afterPublish
      });
      committed = reconciled.intent;
    } else if (intent.state === 'awaiting-preflight-recovery') {
      const staged = stageArtifactCandidate(prepared.recovery, Buffer.from(prepared.content, 'utf8'), { lockAlreadyHeld: prepared.lockAlreadyHeld });
      prepareArtifactRecoveryCommit(prepared.recovery, staged.candidateSha256, staged.semanticDigest, { lockAlreadyHeld: prepared.lockAlreadyHeld });
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld });
    }
    if (intent.state === 'preflight-ready' || intent.state === 'preflight-commit-started') {
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld });
    }
    if (committed?.state === 'preflight-passed' || intent.state === 'preflight-passed') {
      prepareArtifactRecoveryFinal(prepared.recovery, Buffer.from(prepared.content, 'utf8'), { lockAlreadyHeld: prepared.lockAlreadyHeld });
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld, afterPublish: options.afterPublish });
    } else if (intent.state === 'full-finalizer-ready') {
      committed = commitArtifactRecovery(prepared.recovery, { lockAlreadyHeld: prepared.lockAlreadyHeld, afterPublish: options.afterPublish });
    }
    if (!committed || committed.state !== 'passed') throw new Error(`ARTIFACT_RECOVERY_STATE_INVALID: commit ended in '${committed?.state ?? intent.state}'`);
    return {
      ...prepared.result,
      status: 'passed',
      changed: false,
      artifactSha256: committed.finalArtifactSha256,
      semanticDigest: committed.finalSemanticDigest,
      error: null
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TASK_WORKFLOW_FAULT_INJECTED:')) throw error;
    return { ...prepared.result, status: 'failed', error: {
      code: 'LOCAL_RECOVERY_COMMIT_FAILED', message: String(error)
    } };
  }
}

function finalizeLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  authority?: LifecycleRecoveryAttestationV1,
  options: Readonly<{ deferLifecycleRecoveryConsumption?: boolean }> = {}
): LocalArtifactFinalizationResult {
  const prepared = prepareLocalArtifact(request, undefined, authority);
  const result = commitLocalArtifactProvenance(prepared);
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

/** Validate and seal an immutable preflight generation without publishing the formal artifact. */
function preflightLocalArtifact(
  request: LocalArtifactFinalizationRequest,
  authority?: LifecycleRecoveryAttestationV1
): LocalArtifactFinalizationResult {
  const prepared = prepareLocalArtifact(request, undefined, authority, true);
  return prepared.result;
}

export {
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  consumeLocalArtifactFinalizationIntent,
  finalizeLocalArtifact,
  preflightLocalArtifact,
  prepareLocalArtifact,
  commitLocalArtifactProvenance,
  readArtifactRecoveryIntent as readLocalArtifactFinalizationIntent,
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
  LocalArtifactValidationResult,
  LocalArtifactRecoveryInfo
};
