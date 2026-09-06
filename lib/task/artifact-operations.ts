import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { scanVisibleMarkdown } from './decision-details.ts';
import {
  getArtifactSchema,
  renderArtifactSkeleton
} from './artifact-schema.ts';
import type {
  ArtifactSchema,
  ArtifactSchemaFamily,
  ArtifactSection
} from './artifact-schema.ts';
import { withTaskExecutionLock } from './task-execution-lock.ts';

type ArtifactRepairOperation = Readonly<{
  kind: 'replace-line' | 'insert-section';
  sectionId: string;
  line: number;
  from: string;
  to: string;
  start: number;
  end: number;
}>;

type ArtifactStructuralDiagnosticCode =
  | 'ARTIFACT_EMPTY'
  | 'ARTIFACT_MISSING_SECTION'
  | 'ARTIFACT_DUPLICATE_SECTION'
  | 'ARTIFACT_UNCLOSED_FENCE'
  | 'ARTIFACT_MARKER_MISSING'
  | 'ARTIFACT_MARKER_DUPLICATE'
  | 'ARTIFACT_MARKER_MISMATCH'
  | 'ARTIFACT_EMPTY_SECTION'
  | 'ARTIFACT_HEADING_TRAILING_PUNCTUATION';

type ArtifactStructuralDiagnostic = Readonly<{
  code: ArtifactStructuralDiagnosticCode;
  message: string;
  sectionId: string | null;
  line: number | null;
  repairable: boolean;
  operation?: ArtifactRepairOperation;
}>;

type ArtifactStructureResult = Readonly<{
  ok: boolean;
  family: ArtifactSchemaFamily;
  semanticDigest: string;
  diagnostics: readonly ArtifactStructuralDiagnostic[];
  repair: ArtifactRepairOperation | null;
}>;

type ArtifactFileResult = Readonly<{
  status: 'applied' | 'no-op' | 'failed';
  changed: boolean;
  artifactSha256: string | null;
  semanticDigest: string | null;
  operation: ArtifactRepairOperation | null;
  error: { code: string; message: string } | null;
}>;

type ArtifactRepairRequest = Readonly<{
  repoRoot: string;
  taskId: string;
  taskDir: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  expectedSha256: string;
  expectedSemanticDigest: string;
  operation: ArtifactRepairOperation;
}>;

type ArtifactInitRequest = Readonly<{
  repoRoot: string;
  taskId: string;
  taskDir: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  locale?: 'zh-CN' | 'en';
}>;

function sha256Content(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sourceLines(content: string): Array<{ start: number; end: number; text: string }> {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    lines.push({ start, end, text: content.slice(start, end).replace(/\r$/, '') });
    start = newline === -1 ? content.length : newline + 1;
  }
  if (content.length === 0) lines.push({ start: 0, end: 0, text: '' });
  return lines;
}

function hasUnclosedFence(content: string): boolean {
  let fence: { character: '`' | '~'; length: number } | null = null;
  for (const line of sourceLines(content)) {
    if (fence) {
      const close = line.text.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.character && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = { character: open[1]![0] as '`' | '~', length: open[1]!.length };
    }
  }
  return fence !== null;
}

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function markerPattern(marker: string): RegExp {
  return new RegExp(`<!--\\s*${escapeRegExp(marker)}\\s*-->`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerEntries(content: string): Array<{ marker: string; start: number; end: number; line: number }> {
  const entries: Array<{ marker: string; start: number; end: number; line: number }> = [];
  for (const line of sourceLines(content)) {
    const match = line.text.match(/<!--\s*(artifact-section:[^\s>]+)\s*-->/g);
    if (!match) continue;
    for (const raw of match) {
      const marker = raw.match(/artifact-section:[^\s>]+/)![0]!;
      const offset = line.text.indexOf(raw);
      entries.push({
        marker,
        start: line.start + offset,
        end: line.start + offset + raw.length,
        line: lineNumber(content, line.start)
      });
    }
  }
  return entries;
}

function sectionBodyBounds(content: string, heading: { start: number }): { start: number; end: number } {
  const next = scanVisibleMarkdown(content).headings.find((candidate) => (
    candidate.start > heading.start && candidate.level <= 2
  ));
  const headingEnd = scanVisibleMarkdown(content).headings.find((candidate) => candidate.start === heading.start)?.end ?? heading.start;
  return { start: headingEnd, end: next?.start ?? content.length };
}

function diagnostic(
  code: ArtifactStructuralDiagnosticCode,
  message: string,
  sectionId: string | null,
  line: number | null,
  repairable = false,
  operation?: ArtifactRepairOperation
): ArtifactStructuralDiagnostic {
  return {
    code, message, sectionId, line, repairable,
    ...(operation ? { operation } : {})
  };
}

function sectionHeadings(schema: ArtifactSchema, section: ArtifactSection): readonly string[] {
  return [section.headings.zh, section.headings.en];
}

function createHeadingRepair(
  content: string,
  section: ArtifactSection,
  heading: { start: number; end: number; text: string }
): ArtifactRepairOperation {
  const to = heading.text.slice(0, -1);
  return {
    kind: 'replace-line',
    sectionId: section.id,
    line: lineNumber(content, heading.start),
    from: heading.text,
    to,
    start: heading.start,
    end: heading.end
  };
}

function canonicalContent(content: string, operation: ArtifactRepairOperation | null = null): string {
  let normalized = content;
  if (operation) {
    const raw = normalized.slice(operation.start, operation.end);
    const replaced = raw.replace(operation.from, operation.to);
    if (replaced !== raw) normalized = `${normalized.slice(0, operation.start)}${replaced}${normalized.slice(operation.end)}`;
  }
  normalized = normalized.replace(/\r\n/g, '\n');
  normalized = normalized.replace(/^<!--\s*artifact-context:[^\n]+-->\s*\n?/gm, '');
  normalized = normalized.replace(/^\s*<!--\s*artifact-section:[^\n]+-->\s*\n?/gm, '');
  normalized = normalized.replace(/^\s*<!--\s*artifact-slot:empty\s*-->\s*\n?/gm, '');
  return normalized;
}

function canonicalSemanticDigest(content: string, operation: ArtifactRepairOperation | null = null): string {
  return sha256Content(canonicalContent(content, operation));
}

function inspectArtifactStructure(
  content: string,
  schema: ArtifactSchema,
  options: { requireMarkers?: boolean } = {}
): ArtifactStructureResult {
  const diagnostics: ArtifactStructuralDiagnostic[] = [];
  const scanned = scanVisibleMarkdown(content);
  const repairCandidates: ArtifactRepairOperation[] = [];
  if (!content.trim()) diagnostics.push(diagnostic('ARTIFACT_EMPTY', 'artifact is empty', null, null));
  if (hasUnclosedFence(content)) diagnostics.push(diagnostic('ARTIFACT_UNCLOSED_FENCE', 'artifact contains an unclosed Markdown fence', null, null));

  const headingsBySection = new Map<string, typeof scanned.headings>();
  for (const section of schema.sections) {
    const aliases = sectionHeadings(schema, section);
    const exact = scanned.headings.filter((heading) => heading.level === 2 && aliases.includes(heading.text));
    const punctuated = scanned.headings.filter((heading) => heading.level === 2 && aliases.some((alias) => heading.text === `${alias}:` || heading.text === `${alias}：`));
    headingsBySection.set(section.id, exact.length === 0 && punctuated.length === 1 ? punctuated : exact);
    if (exact.length > 1 || punctuated.length > 0 && exact.length > 0 || punctuated.length > 1) {
      const first = exact[1] ?? punctuated[0] ?? exact[0];
      diagnostics.push(diagnostic(
        'ARTIFACT_DUPLICATE_SECTION',
        `required section '${aliases[0]}' is duplicated or has an ambiguous punctuation variant`,
        section.id,
        first ? lineNumber(content, first.start) : null
      ));
    } else if (exact.length === 0 && punctuated.length === 1) {
      repairCandidates.push(createHeadingRepair(content, section, punctuated[0]!));
    } else if (exact.length === 0) {
      diagnostics.push(diagnostic('ARTIFACT_MISSING_SECTION', `required section '${aliases[0]}' is missing`, section.id, null));
    }
  }

  const markers = markerEntries(content);
  const markerMode = options.requireMarkers === true || markers.length > 0;
  if (markerMode) {
    for (const section of schema.sections) {
      const matches = markers.filter((entry) => entry.marker === section.marker);
      if (matches.length === 0) {
        diagnostics.push(diagnostic('ARTIFACT_MARKER_MISSING', `section marker '${section.marker}' is missing`, section.id, null));
      } else if (matches.length > 1) {
        diagnostics.push(diagnostic('ARTIFACT_MARKER_DUPLICATE', `section marker '${section.marker}' is duplicated`, section.id, matches[1]!.line));
      }
      const heading = headingsBySection.get(section.id)?.[0];
      if (heading && matches.length === 1) {
        const bounds = sectionBodyBounds(content, heading);
        if (matches[0]!.start < bounds.start || matches[0]!.start >= bounds.end) {
          diagnostics.push(diagnostic('ARTIFACT_MARKER_MISMATCH', `section marker '${section.marker}' is outside its section`, section.id, matches[0]!.line));
        }
        const body = content.slice(bounds.start, bounds.end).replace(/<!--[\s\S]*?-->/g, '').trim();
        if (!body) diagnostics.push(diagnostic('ARTIFACT_EMPTY_SECTION', `section '${section.headings.zh}' has no semantic body`, section.id, lineNumber(content, heading.start)));
      }
    }
    for (const marker of markers) {
      if (!schema.sections.some((section) => markerPattern(section.marker).test(`<!-- ${marker.marker} -->`))) {
        diagnostics.push(diagnostic('ARTIFACT_MARKER_MISMATCH', `unknown section marker '${marker.marker}'`, null, marker.line));
      }
    }
  }

  const repair = repairCandidates.length === 1 && diagnostics.length === 0 ? repairCandidates[0]! : null;
  if (repair) {
    diagnostics.push(diagnostic(
      'ARTIFACT_HEADING_TRAILING_PUNCTUATION',
      `visible required H2 '${repair.from}' may be normalized to '${repair.to}'`,
      repair.sectionId,
      repair.line,
      true,
      repair
    ));
  }
  return {
    ok: diagnostics.length === 0,
    family: schema.family,
    semanticDigest: canonicalSemanticDigest(content, repair),
    diagnostics,
    repair
  };
}

function resultFailure(code: string, message: string): ArtifactFileResult {
  return { status: 'failed', changed: false, artifactSha256: null, semanticDigest: null, operation: null, error: { code, message } };
}

function resultNoOp(content: string): ArtifactFileResult {
  return {
    status: 'no-op',
    changed: false,
    artifactSha256: sha256Content(content),
    semanticDigest: canonicalSemanticDigest(content),
    operation: null,
    error: null
  };
}

function artifactRound(family: ArtifactSchemaFamily, artifact: string): number | null {
  if (artifact === `${family}.md`) return 1;
  const match = artifact.match(new RegExp(`^${escapeRegExp(family)}-r([2-9]|[1-9]\\d+)\\.md$`));
  if (!match) return null;
  const round = Number(match[1]);
  return Number.isSafeInteger(round) ? round : null;
}

function validateTarget(taskDir: string, family: ArtifactSchemaFamily, artifact: string): { path: string } | ArtifactFileResult {
  if (path.basename(artifact) !== artifact || artifactRound(family, artifact) === null || !artifact.endsWith('.md')) return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', 'artifact must be a canonical top-level Markdown file');
  if (!/^TASK-\d{8}-\d{6}$/.test(path.basename(path.resolve(taskDir)))) return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', 'target directory is not a task directory');
  const target = path.join(taskDir, artifact);
  if (path.dirname(path.resolve(target)) !== path.resolve(taskDir)) return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', 'artifact must be inside the current task directory');
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch (error) { return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', `artifact cannot be read: ${String(error)}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', 'artifact is not a regular file');
  try { fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK); }
  catch (error) { return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', `artifact is not readable and writable: ${String(error)}`); }
  return { path: target };
}

function applyRepairUnlocked(request: ArtifactRepairRequest): ArtifactFileResult {
  const schema = getArtifactSchema(request.family);
  if (!schema) return resultFailure('ARTIFACT_FAMILY_UNKNOWN', `unknown artifact family '${request.family}'`);
  const target = validateTarget(request.taskDir, request.family, request.artifact);
  if ('status' in target) return target;
  let content: string;
  try { content = fs.readFileSync(target.path, 'utf8'); }
  catch (error) { return resultFailure('ARTIFACT_REPAIR_TARGET_INVALID', String(error)); }
  const actualSha256 = sha256Content(content);
  if (actualSha256 !== request.expectedSha256) return resultFailure('ARTIFACT_REPAIR_BASELINE_MISMATCH', 'artifact SHA-256 does not match the expected repair baseline');
  const inspection = inspectArtifactStructure(content, schema);
  if (!inspection.repair || inspection.diagnostics.length !== 1) {
    return resultFailure('ARTIFACT_REPAIR_UNSAFE', inspection.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ') || 'no deterministic structural repair is available');
  }
  if (inspection.repair.kind !== request.operation.kind || inspection.repair.sectionId !== request.operation.sectionId || inspection.repair.from !== request.operation.from || inspection.repair.to !== request.operation.to) {
    return resultFailure('ARTIFACT_REPAIR_OPERATION_MISMATCH', 'repair operation does not match the current artifact structure');
  }
  if (inspection.semanticDigest !== request.expectedSemanticDigest) return resultFailure('ARTIFACT_REPAIR_BASELINE_MISMATCH', 'artifact semantic digest does not match the expected repair baseline');
  const rawLine = content.slice(inspection.repair.start, inspection.repair.end);
  const replacement = rawLine.replace(inspection.repair.from, inspection.repair.to);
  if (replacement === rawLine) return resultFailure('ARTIFACT_REPAIR_NO_PROGRESS', 'repair operation would not change artifact bytes');
  const transformed = `${content.slice(0, inspection.repair.start)}${replacement}${content.slice(inspection.repair.end)}`;
  if (transformed === content) return resultFailure('ARTIFACT_REPAIR_NO_PROGRESS', 'repair operation produced no byte change');
  const tempPath = path.join(request.taskDir, `.${request.artifact}.repair-${process.pid}-${Date.now()}.tmp`);
  let mode = 0o600;
  try {
    mode = fs.statSync(target.path).mode & 0o777;
    fs.writeFileSync(tempPath, transformed, { encoding: 'utf8', mode, flag: 'wx' });
    const currentStat = fs.lstatSync(target.path);
    if (currentStat.isSymbolicLink() || !currentStat.isFile() || sha256Content(fs.readFileSync(target.path, 'utf8')) !== actualSha256) {
      fs.unlinkSync(tempPath);
      return resultFailure('ARTIFACT_REPAIR_CONFLICT', 'artifact changed or was replaced during repair');
    }
    fs.renameSync(tempPath, target.path);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* preserve primary error */ }
    return resultFailure('ARTIFACT_REPAIR_WRITE_FAILED', String(error));
  }
  return {
    status: 'applied',
    changed: true,
    artifactSha256: sha256Content(transformed),
    semanticDigest: canonicalSemanticDigest(transformed),
    operation: inspection.repair,
    error: null
  };
}

function applyArtifactRepair(request: ArtifactRepairRequest): ArtifactFileResult {
  try {
    return withTaskExecutionLock(request.repoRoot, request.taskId, 'task-artifact.repair', () => applyRepairUnlocked(request));
  } catch (error) {
    return resultFailure('ARTIFACT_REPAIR_LOCK_FAILED', String(error));
  }
}

function initializeArtifactSkeleton(request: ArtifactInitRequest): ArtifactFileResult {
  const schema = getArtifactSchema(request.family);
  if (!schema) return resultFailure('ARTIFACT_FAMILY_UNKNOWN', `unknown artifact family '${request.family}'`);
  if (artifactRound(request.family, request.artifact) === null) return resultFailure('ARTIFACT_INIT_TARGET_INVALID', 'artifact must be a canonical top-level Markdown file');
  if (!/^TASK-\d{8}-\d{6}$/.test(path.basename(path.resolve(request.taskDir))) || path.basename(path.resolve(request.taskDir)) !== request.taskId) return resultFailure('ARTIFACT_INIT_TARGET_INVALID', 'target directory is not the requested task directory');
  const target = path.join(request.taskDir, request.artifact);
  if (path.dirname(path.resolve(target)) !== path.resolve(request.taskDir)) return resultFailure('ARTIFACT_INIT_TARGET_INVALID', 'artifact must be inside the current task directory');
  try {
    return withTaskExecutionLock(request.repoRoot, request.taskId, 'task-artifact.init', () => {
      try {
        const existing = fs.lstatSync(target);
        if (existing.isSymbolicLink() || !existing.isFile()) return resultFailure('ARTIFACT_INIT_TARGET_INVALID', 'artifact target is not a regular file');
        return resultNoOp(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return resultFailure('ARTIFACT_INIT_TARGET_INVALID', String(error));
      }
      const content = renderArtifactSkeleton({
        taskId: request.taskId,
        family: request.family,
        artifact: request.artifact,
        ...(request.locale ? { locale: request.locale } : {})
      });
      const tempPath = path.join(request.taskDir, `.${request.artifact}.init-${process.pid}-${Date.now()}.tmp`);
      try {
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try { fs.lstatSync(target); fs.unlinkSync(tempPath); return resultFailure('ARTIFACT_INIT_TARGET_EXISTS', 'artifact was created concurrently'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        fs.renameSync(tempPath, target);
      } catch (error) {
        try { fs.unlinkSync(tempPath); } catch { /* preserve primary error */ }
        return resultFailure('ARTIFACT_INIT_WRITE_FAILED', String(error));
      }
      return {
        status: 'applied',
        changed: true,
        artifactSha256: sha256Content(content),
        semanticDigest: canonicalSemanticDigest(content),
        operation: null,
        error: null
      };
    });
  } catch (error) {
    return resultFailure('ARTIFACT_INIT_LOCK_FAILED', String(error));
  }
}

export {
  applyArtifactRepair,
  canonicalSemanticDigest,
  initializeArtifactSkeleton,
  inspectArtifactStructure,
  sha256Content
};
export type {
  ArtifactFileResult,
  ArtifactInitRequest,
  ArtifactRepairOperation,
  ArtifactRepairRequest,
  ArtifactStructuralDiagnostic,
  ArtifactStructuralDiagnosticCode,
  ArtifactStructureResult
};
