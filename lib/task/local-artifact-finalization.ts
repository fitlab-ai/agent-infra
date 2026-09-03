import fs from 'node:fs';
import { createHash } from 'node:crypto';

import {
  inspectDecisionDetailDuplicates,
  scanVisibleMarkdown
} from './decision-details.ts';
import type { VisibleHeading } from './decision-details.ts';
import {
  parseArtifactName,
  validateCompletedArtifact
} from './artifact-lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';

type LocalArtifactFamily = 'analysis' | 'plan';

const LOCAL_ARTIFACT_REQUIRED_SECTIONS: Readonly<Record<LocalArtifactFamily, readonly string[]>> = {
  analysis: [
    '需求来源', '需求理解', '相关文件', '影响评估', '技术风险',
    '工作量和复杂度评估', '状态核对'
  ],
  plan: [
    '问题理解', '约束条件', '方案对比', '技术方法', '实施步骤',
    '文件清单', '验证策略', '状态核对'
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
  | 'LOCAL_SECTION_HEADING_TRAILING_PUNCTUATION';

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
  return createHash('sha256').update(normalized.replace(/\s+/g, ''), 'utf8').digest('hex');
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
  finalizeLocalArtifact,
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
  LocalArtifactValidationOptions,
  LocalArtifactValidationResult
};
