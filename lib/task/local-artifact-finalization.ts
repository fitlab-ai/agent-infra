import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  inspectDecisionDetailDuplicates,
  scanVisibleMarkdown
} from './decision-details.ts';
import type { VisibleHeading } from './decision-details.ts';
import {
  parseArtifactName,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import { receiptForOutput } from './artifact-receipts.ts';
import { resolveTaskRef } from './resolve-ref.ts';

type LocalArtifactFamily = 'analysis' | 'plan' | 'code';

const LOCAL_ARTIFACT_REQUIRED_SECTIONS: Readonly<Record<LocalArtifactFamily, readonly string[]>> = {
  analysis: [
    '需求来源', '需求理解', '相关文件', '影响评估', '技术风险',
    '工作量和复杂度评估', '状态核对'
  ],
  plan: [
    '问题理解', '约束条件', '方案对比', '技术方法', '实施步骤',
    '文件清单', '验证策略', '状态核对'
  ],
  code: [
    '实现输入', '变更文件', '关键代码说明', '测试结果', '与方案的差异',
    '供审查关注的内容', '状态核对', '证据原文'
  ]
};

const LOCAL_ARTIFACT_REQUIRED_PATTERNS = ['^\\$ '];

type LocalArtifactDiagnosticCode =
  | 'LOCAL_ARTIFACT_EMPTY'
  | 'LOCAL_ARTIFACT_MISSING_SECTION'
  | 'LOCAL_ARTIFACT_DUPLICATE_SECTION'
  | 'LOCAL_STATUS_COMMAND_MISSING'
  | 'LOCAL_DECISION_DETAIL_DUPLICATE'
  | 'LOCAL_REQUIRED_PATTERN_MISSING'
  | 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION'
  | 'LOCAL_REPAIR_PROVENANCE_CONFLICT'
  | 'LOCAL_REPAIR_BASELINE_MISMATCH';

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

type LocalArtifactRebindRequest = Readonly<{
  taskRef: string;
  family: LocalArtifactFamily;
  artifact: string;
  reason: string;
  repoRoot?: string;
}>;

type LocalArtifactRebindResult = Readonly<{
  status: 'passed' | 'failed';
  changed: boolean;
  rebound: boolean;
  taskId: string | null;
  taskDir: string | null;
  family: LocalArtifactFamily;
  artifact: string;
  artifactSha256: string | null;
  semanticDigest: string | null;
  previousArtifactSha256: string | null;
  previousSemanticDigest: string | null;
  recovery: Readonly<{ at: string; reason: string }> | null;
  error: { code: string; message: string } | null;
}>;

type LocalArtifactFinalizationIntent = Readonly<{
  version: 1;
  taskId: string;
  family: LocalArtifactFamily;
  artifact: string;
  state: 'awaiting-repair' | 'passed' | 'consumed';
  baselineSemanticDigest: string | null;
  artifactSha256: string;
  semanticDigest: string;
  recovery?: Readonly<{
    at: string;
    reason: string;
    previousArtifactSha256: string;
    previousSemanticDigest: string;
  }>;
}>;

function finalizationIntentRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'workspace', '.local-artifact-finalization-intents');
}

function finalizationIntentPath(repoRoot: string, taskId: string, family: LocalArtifactFamily, artifact: string): string {
  return path.join(finalizationIntentRoot(repoRoot), `${taskId}-${family}-${artifact}.json`);
}

function isFinalizationIntent(value: unknown): value is LocalArtifactFinalizationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  const recovery = intent.recovery;
  const recoveryRecord = recovery !== null && typeof recovery === 'object' && !Array.isArray(recovery)
    ? recovery as Record<string, unknown>
    : null;
  const recoveryValid = recovery === undefined || (
    recoveryRecord !== null
    && typeof recoveryRecord.at === 'string' && !Number.isNaN(Date.parse(recoveryRecord.at))
    && typeof recoveryRecord.reason === 'string' && recoveryRecord.reason.length > 0 && recoveryRecord.reason.length <= 200 && !/[\r\n]/.test(recoveryRecord.reason)
    && typeof recoveryRecord.previousArtifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(recoveryRecord.previousArtifactSha256)
    && typeof recoveryRecord.previousSemanticDigest === 'string' && /^[a-f0-9]{64}$/.test(recoveryRecord.previousSemanticDigest)
  );
  return intent.version === 1
    && typeof intent.taskId === 'string' && intent.taskId.length > 0
    && (intent.family === 'analysis' || intent.family === 'plan' || intent.family === 'code')
    && typeof intent.artifact === 'string' && intent.artifact.length > 0
    && (intent.state === 'awaiting-repair' || intent.state === 'passed' || intent.state === 'consumed')
    && (intent.baselineSemanticDigest === null || (typeof intent.baselineSemanticDigest === 'string' && /^[a-f0-9]{64}$/.test(intent.baselineSemanticDigest)))
    && typeof intent.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(intent.artifactSha256)
    && typeof intent.semanticDigest === 'string' && /^[a-f0-9]{64}$/.test(intent.semanticDigest)
    && (intent.state === 'awaiting-repair' ? intent.baselineSemanticDigest === intent.semanticDigest : true)
    && recoveryValid;
}

function readLocalArtifactFinalizationIntent(
  repoRoot: string,
  taskId: string,
  family: LocalArtifactFamily,
  artifact: string
): LocalArtifactFinalizationIntent | null {
  const target = finalizationIntentPath(repoRoot, taskId, family, artifact);
  if (!fs.existsSync(target)) return null;
  const value = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
  if (!isFinalizationIntent(value) || value.taskId !== taskId || value.family !== family || value.artifact !== artifact) {
    throw new Error('LOCAL_FINALIZATION_INTENT_INVALID: finalization provenance schema is invalid');
  }
  return value;
}

function writeLocalArtifactFinalizationIntent(repoRoot: string, value: LocalArtifactFinalizationIntent): void {
  if (!isFinalizationIntent(value)) throw new Error('LOCAL_FINALIZATION_INTENT_INVALID: finalization provenance schema is invalid');
  const directory = finalizationIntentRoot(repoRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = finalizationIntentPath(repoRoot, value.taskId, value.family, value.artifact);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, target); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve primary error */ }
    throw error;
  }
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

function requiredSections(family: LocalArtifactFamily): readonly string[] {
  return LOCAL_ARTIFACT_REQUIRED_SECTIONS[family];
}

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function sectionBody(content: string, heading: VisibleHeading): string {
  const next = scanVisibleMarkdown(content).headings.find((candidate) => (
    candidate.start > heading.start && candidate.level <= 2
  ));
  return content.slice(heading.end, next?.start ?? content.length);
}

function semanticDigest(content: string, candidate?: VisibleHeading): string {
  let normalized = content;
  if (candidate) {
    const raw = content.slice(candidate.start, candidate.end);
    const marker = raw.match(/([:：])\s*$/);
    if (marker?.index !== undefined) {
      const canonical = raw.slice(0, marker.index) + raw.slice(marker.index + 1);
      normalized = `${content.slice(0, candidate.start)}${canonical}${content.slice(candidate.end)}`;
    }
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function sha256Content(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function visibleSectionHeadings(content: string, section: string): VisibleHeading[] {
  return scanVisibleMarkdown(content).headings.filter((heading) => (
    heading.level === 2 && heading.text === section
  ));
}

function trailingPunctuationCandidates(content: string, section: string): VisibleHeading[] {
  return scanVisibleMarkdown(content).headings.filter((heading) => (
    heading.level === 2 && (
      heading.text === `${section}:` || heading.text === `${section}：`
    )
  ));
}

function diagnostic(
  code: LocalArtifactDiagnosticCode,
  message: string,
  content: string,
  heading?: VisibleHeading,
  extra: Partial<LocalArtifactDiagnostic> = {}
): LocalArtifactDiagnostic {
  return {
    code, message, repairable: false,
    line: heading ? lineNumber(content, heading.start) : null,
    ...extra
  };
}

function isStatusPattern(pattern: string): boolean {
  return pattern === '^\\$ ';
}

function validateLocalArtifact(
  content: string,
  options: LocalArtifactValidationOptions
): LocalArtifactValidationResult {
  const sections = options.requiredSections ?? requiredSections(options.family);
  const patterns = options.requiredPatterns ?? LOCAL_ARTIFACT_REQUIRED_PATTERNS;
  const diagnostics: LocalArtifactDiagnostic[] = [];
  const candidates: VisibleHeading[] = [];
  const scanned = scanVisibleMarkdown(content);

  if (!content.trim()) {
    diagnostics.push(diagnostic('LOCAL_ARTIFACT_EMPTY', 'artifact is empty', content));
  }

  for (const section of sections) {
    const exact = scanned.headings.filter((heading) => heading.level === 2 && heading.text === section);
    const punctuated = trailingPunctuationCandidates(content, section);
    if (exact.length > 1 || punctuated.length > 0 && exact.length > 0 || punctuated.length > 1) {
      const first = exact[1] ?? punctuated[0] ?? exact[0];
      diagnostics.push(diagnostic(
        'LOCAL_ARTIFACT_DUPLICATE_SECTION',
        `required section '${section}' is duplicated or has an ambiguous punctuation variant`,
        content, first
      ));
    } else if (exact.length === 0 && punctuated.length === 1) {
      candidates.push(punctuated[0]!);
    } else if (exact.length === 0) {
      diagnostics.push(diagnostic(
        'LOCAL_ARTIFACT_MISSING_SECTION',
        `required section '${section}' is missing`,
        content
      ));
    }
  }

  const statusSection = sections.find((section) => section === '状态核对' || section.toLowerCase() === 'state check');
  if (statusSection) {
    const statusHeading = visibleSectionHeadings(content, statusSection)[0]
      ?? candidates.find((heading) => heading.text === `${statusSection}:` || heading.text === `${statusSection}：`);
    if (statusHeading) {
      const body = sectionBody(content, statusHeading);
      for (const pattern of patterns.filter(isStatusPattern)) {
        if (!new RegExp(pattern, 'm').test(body)) {
          diagnostics.push(diagnostic(
            'LOCAL_STATUS_COMMAND_MISSING',
            `status section '${statusSection}' is missing required command output`,
            content, statusHeading
          ));
        }
      }
    }
  }

  for (const pattern of patterns.filter((item) => !isStatusPattern(item))) {
    if (!new RegExp(pattern, 'm').test(content)) {
      diagnostics.push(diagnostic(
        'LOCAL_REQUIRED_PATTERN_MISSING',
        `artifact is missing required pattern '${pattern}'`,
        content
      ));
    }
  }

  const decisionDetails = inspectDecisionDetailDuplicates(content);
  if (!decisionDetails.ok) {
    diagnostics.push(diagnostic(
      'LOCAL_DECISION_DETAIL_DUPLICATE',
      decisionDetails.message,
      content,
      decisionDetails.duplicates[0]?.blocks[0]
        ? scanned.headings.find((heading) => heading.start === decisionDetails.duplicates[0]!.blocks[0]!.start)
        : undefined
    ));
  }

  if (candidates.length === 1 && diagnostics.length === 0) {
    const candidate = candidates[0]!;
    const section = candidate.text.slice(0, -1);
    const repair = diagnostic(
      'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION',
      `visible required H2 '${candidate.text}' may be normalized to '${section}'`,
      content,
      candidate,
      {
        repairable: true,
        from: candidate.text,
        to: section,
        operation: 'replace-line'
      }
    );
    return {
      ok: false,
      family: options.family,
      semanticDigest: semanticDigest(content, candidate),
      repairable: true,
      diagnostics: [repair]
    };
  }

  if (candidates.length > 0) {
    for (const candidate of candidates) {
      const section = candidate.text.slice(0, -1);
      diagnostics.push(diagnostic(
        'LOCAL_ARTIFACT_MISSING_SECTION',
        `required section '${section}' is missing and cannot be repaired while other structural defects exist`,
        content, candidate
      ));
    }
  }

  return {
    ok: diagnostics.length === 0,
    family: options.family,
    semanticDigest: semanticDigest(content),
    repairable: false,
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
    diagnostics: [diagnostic(code, message, content)]
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
  const result = validateLocalArtifact(content, {
    family: request.family,
    requiredSections: request.requiredSections,
    requiredPatterns: request.requiredPatterns
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

function rebindLocalArtifactFinalization(request: LocalArtifactRebindRequest): LocalArtifactRebindResult {
  const failed = (code: string, message: string, taskId: string | null = null, taskDir: string | null = null): LocalArtifactRebindResult => ({
    status: 'failed',
    changed: false,
    rebound: false,
    taskId,
    taskDir,
    family: request.family,
    artifact: request.artifact,
    artifactSha256: null,
    semanticDigest: null,
    previousArtifactSha256: null,
    previousSemanticDigest: null,
    recovery: null,
    error: { code, message }
  });

  if (!request.reason || request.reason !== request.reason.trim() || request.reason.length > 200 || /[\r\n]/.test(request.reason)) {
    return failed('LOCAL_REBIND_REASON_INVALID', 'rebind reason must be a non-empty single line of at most 200 characters');
  }
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: request.repoRoot });
  if (!resolved.ok) return failed(resolved.code, resolved.message, resolved.taskId);
  if (resolved.state !== 'active') return failed('LOCAL_REBIND_TASK_STATE_INVALID', 'local provenance rebind requires an active task', resolved.taskId, resolved.taskDir);
  const parsed = parseArtifactName(request.artifact);
  if (!parsed || parsed.family !== request.family) return failed('ARTIFACT_IDENTITY_INVALID', `artifact '${request.artifact}' does not match ${request.family}`, resolved.taskId, resolved.taskDir);
  const validated = validateCompletedArtifact(resolved.taskDir, request.family, request.artifact, parsed.round);
  if (!validated.ok) return failed(validated.error.code, validated.error.message, resolved.taskId, resolved.taskDir);

  let content: string;
  let taskContent: string;
  try {
    content = fs.readFileSync(validated.artifact.path, 'utf8');
    taskContent = fs.readFileSync(resolved.taskMdPath, 'utf8');
  } catch (error) {
    return failed('ARTIFACT_NOT_READABLE', String(error), resolved.taskId, resolved.taskDir);
  }
  const local = validateLocalArtifact(content, { family: request.family });
  if (!local.ok) return failed('LOCAL_ARTIFACT_INVALID', local.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '), resolved.taskId, resolved.taskDir);
  try {
    if (receiptForOutput(taskContent, request.artifact)) {
      return failed('LOCAL_REBIND_ALREADY_COMPLETED', `cannot rebind completed artifact '${request.artifact}'`, resolved.taskId, resolved.taskDir);
    }
  } catch (error) {
    return failed('LOCAL_REBIND_TASK_INVALID', `cannot inspect artifact receipts: ${error instanceof Error ? error.message : String(error)}`, resolved.taskId, resolved.taskDir);
  }

  let intent: LocalArtifactFinalizationIntent | null;
  try {
    intent = readLocalArtifactFinalizationIntent(resolved.repoRoot, resolved.taskId, request.family, request.artifact);
  } catch (error) {
    return failed('LOCAL_FINALIZATION_INTENT_INVALID', error instanceof Error ? error.message : String(error), resolved.taskId, resolved.taskDir);
  }
  if (!intent || intent.state !== 'passed' || intent.baselineSemanticDigest !== null) {
    return failed('LOCAL_REBIND_PROVENANCE_INVALID', 'rebind requires an existing passed provenance without a repair baseline', resolved.taskId, resolved.taskDir);
  }

  const artifactSha256 = sha256Content(content);
  const currentSemanticDigest = local.semanticDigest;
  if (intent.artifactSha256 === artifactSha256 && intent.semanticDigest === currentSemanticDigest) {
    return {
      status: 'passed',
      changed: false,
      rebound: false,
      taskId: resolved.taskId,
      taskDir: resolved.taskDir,
      family: request.family,
      artifact: request.artifact,
      artifactSha256,
      semanticDigest: currentSemanticDigest,
      previousArtifactSha256: intent.artifactSha256,
      previousSemanticDigest: intent.semanticDigest,
      recovery: intent.recovery ? { at: intent.recovery.at, reason: intent.recovery.reason } : null,
      error: null
    };
  }

  const recovery = {
    at: new Date().toISOString(),
    reason: request.reason,
    previousArtifactSha256: intent.artifactSha256,
    previousSemanticDigest: intent.semanticDigest
  };
  try {
    writeLocalArtifactFinalizationIntent(resolved.repoRoot, {
      ...intent,
      artifactSha256,
      semanticDigest: currentSemanticDigest,
      recovery
    });
  } catch (error) {
    return failed('LOCAL_FINALIZATION_INTENT_WRITE_FAILED', error instanceof Error ? error.message : String(error), resolved.taskId, resolved.taskDir);
  }
  return {
    status: 'passed',
    changed: true,
    rebound: true,
    taskId: resolved.taskId,
    taskDir: resolved.taskDir,
    family: request.family,
    artifact: request.artifact,
    artifactSha256,
    semanticDigest: currentSemanticDigest,
    previousArtifactSha256: intent.artifactSha256,
    previousSemanticDigest: intent.semanticDigest,
    recovery: { at: recovery.at, reason: recovery.reason },
    error: null
  };
}

export {
  LOCAL_ARTIFACT_REQUIRED_PATTERNS,
  LOCAL_ARTIFACT_REQUIRED_SECTIONS,
  consumeLocalArtifactFinalizationIntent,
  finalizeLocalArtifact,
  rebindLocalArtifactFinalization,
  readLocalArtifactFinalizationIntent,
  semanticDigest,
  sha256Content,
  validateLocalArtifact
};
export type {
  LocalArtifactDiagnostic,
  LocalArtifactDiagnosticCode,
  LocalArtifactFamily,
  LocalArtifactFinalizationRequest,
  LocalArtifactFinalizationResult,
  LocalArtifactRebindRequest,
  LocalArtifactRebindResult,
  LocalArtifactFinalizationIntent,
  LocalArtifactValidationOptions,
  LocalArtifactValidationResult
};
