import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readStableFileSync } from '../host-control/secure-fs.ts';
import { parseArtifactName } from './artifact-name.ts';

import { scanVisibleMarkdown, type VisibleMarkdown, type VisibleHeading } from './markdown.ts';
import {
  getArtifactSchema,
  renderArtifactSkeleton
} from './artifact-schema.ts';
import { withTaskExecutionLock } from './task-execution-lock.ts';
import type {
  ArtifactSchema,
  ArtifactSchemaFamily,
  ArtifactSection
} from './artifact-schema.ts';

type ArtifactStructuralDiagnosticCode =
  | 'ARTIFACT_EMPTY'
  | 'ARTIFACT_MISSING_SECTION'
  | 'ARTIFACT_DUPLICATE_SECTION'
  | 'ARTIFACT_UNCLOSED_FENCE'
  | 'ARTIFACT_MARKER_MISSING'
  | 'ARTIFACT_MARKER_DUPLICATE'
  | 'ARTIFACT_MARKER_MISMATCH'
  | 'ARTIFACT_EMPTY_SECTION'
  | 'ARTIFACT_SECTION_ORDER_INVALID'
  | 'ARTIFACT_HEADING_TRAILING_PUNCTUATION'
  | 'ARTIFACT_REQUIRED_PATTERN_MISSING';

type ArtifactStructuralDiagnostic = Readonly<{
  code: ArtifactStructuralDiagnosticCode;
  message: string;
  sectionId: string | null;
  line: number | null;
}>;

type ArtifactStructureResult = Readonly<{
  ok: boolean;
  family: ArtifactSchemaFamily;
  semanticDigest: string;
  diagnostics: readonly ArtifactStructuralDiagnostic[];
}>;

type ArtifactFileResult = Readonly<{
  status: 'applied' | 'no-op' | 'failed';
  changed: boolean;
  artifactSha256: string | null;
  semanticDigest: string | null;
  error: { code: string; message: string } | null;
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

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function markerPattern(marker: string): RegExp {
  return new RegExp(`<!--\\s*${escapeRegExp(marker)}\\s*-->`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerEntries(content: string, scanned: VisibleMarkdown): Array<{ marker: string; start: number; end: number; line: number; standalone: boolean }> {
  const entries: Array<{ marker: string; start: number; end: number; line: number; standalone: boolean }> = [];
  for (const line of scanned.lines) {
    const match = line.text.match(/<!--\s*(artifact-section:[^\s>]+)\s*-->/g);
    if (!match) continue;
    for (const raw of match) {
      const marker = raw.match(/artifact-section:[^\s>]+/)![0]!;
      const offset = line.text.indexOf(raw);
      entries.push({
        marker,
        start: line.start + offset,
        end: line.start + offset + raw.length,
        line: lineNumber(content, line.start),
        standalone: line.text.trim() === raw
      });
    }
  }
  return entries;
}

function sectionBodyBounds(content: string, heading: VisibleHeading, scanned: VisibleMarkdown): { start: number; end: number } {
  const next = scanned.headings.find((candidate) => candidate.start > heading.start && candidate.level <= 2);
  return { start: heading.end, end: next?.start ?? content.length };
}

function stripHtmlComments(content: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('<!--', cursor);
    if (start < 0) return result + content.slice(cursor);
    result += content.slice(cursor, start);
    const end = content.indexOf('-->', start + 4);
    if (end < 0) return result;
    cursor = end + 3;
  }
  return result;
}

function diagnostic(
  code: ArtifactStructuralDiagnosticCode,
  message: string,
  sectionId: string | null,
  line: number | null
): ArtifactStructuralDiagnostic {
  return { code, message, sectionId, line };
}

function sectionHeadings(schema: ArtifactSchema, section: ArtifactSection): readonly string[] {
  return [section.headings.zh, section.headings.en];
}

function canonicalContent(content: string): string {
  let normalized = content;
  normalized = normalized.replace(/\r\n/g, '\n');
  normalized = normalized.replace(/^<!--\s*artifact-context:[^\n]+-->\s*\n?/gm, '');
  normalized = normalized.replace(/^\s*<!--\s*artifact-section:[^\n]+-->\s*\n?/gm, '');
  normalized = normalized.replace(/^\s*<!--\s*artifact-slot:empty\s*-->\s*\n?/gm, '');
  return normalized;
}

function canonicalSemanticDigest(content: string): string {
  return sha256Content(canonicalContent(content));
}

function inspectArtifactStructure(
  content: string,
  schema: ArtifactSchema
): ArtifactStructureResult {
  const diagnostics: ArtifactStructuralDiagnostic[] = [];
  const scanned = scanVisibleMarkdown(content);
  if (!content.trim()) diagnostics.push(diagnostic('ARTIFACT_EMPTY', 'artifact is empty', null, null));
  if (scanned.hasUnclosedFence) diagnostics.push(diagnostic('ARTIFACT_UNCLOSED_FENCE', 'artifact contains an unclosed Markdown fence', null, null));

  const headingsBySection = new Map<string, typeof scanned.headings>();
  for (const section of schema.sections) {
    const aliases = sectionHeadings(schema, section);
    const exact = scanned.headings.filter((heading) => heading.level === 2 && aliases.includes(heading.text));
    const punctuated = scanned.headings.filter((heading) => heading.level === 2 && aliases.some((alias) => heading.text === `${alias}:` || heading.text === `${alias}：`));
    headingsBySection.set(section.id, exact.length > 0 ? exact : punctuated);
    if (exact.length > 1 || punctuated.length > 0 && exact.length > 0 || punctuated.length > 1) {
      const first = exact[1] ?? punctuated[0] ?? exact[0];
      diagnostics.push(diagnostic(
        'ARTIFACT_DUPLICATE_SECTION',
        `required section '${aliases[0]}' is duplicated or has an ambiguous punctuation variant`,
        section.id,
        first ? lineNumber(content, first.start) : null
      ));
    } else if (exact.length === 0 && punctuated.length === 1) {
      diagnostics.push(diagnostic(
        'ARTIFACT_HEADING_TRAILING_PUNCTUATION',
        `visible required H2 '${punctuated[0]!.text}' has trailing punctuation`,
        section.id,
        lineNumber(content, punctuated[0]!.start)
      ));
    } else if (exact.length === 0) {
      diagnostics.push(diagnostic('ARTIFACT_MISSING_SECTION', `required section '${aliases[0]}' is missing`, section.id, null));
    }
  }

  const markers = markerEntries(content, scanned);
  for (const section of schema.sections) {
    const matches = markers.filter((entry) => entry.marker === section.marker);
    if (matches.length === 0) {
      diagnostics.push(diagnostic('ARTIFACT_MARKER_MISSING', `section marker '${section.marker}' is missing`, section.id, null));
    } else if (matches.length > 1) {
      diagnostics.push(diagnostic('ARTIFACT_MARKER_DUPLICATE', `section marker '${section.marker}' is duplicated`, section.id, matches[1]!.line));
    }
    const marker = matches[0];
    const heading = headingsBySection.get(section.id)?.[0];
    if (marker && !marker.standalone) {
      diagnostics.push(diagnostic('ARTIFACT_MARKER_MISMATCH', `section marker '${section.marker}' must occupy its own visible line`, section.id, marker.line));
    }
    if (marker && heading) {
      const bounds = sectionBodyBounds(content, heading, scanned);
      if (marker.start < bounds.start || marker.start >= bounds.end) {
        diagnostics.push(diagnostic('ARTIFACT_MARKER_MISMATCH', `section marker '${section.marker}' is outside its section`, section.id, marker.line));
      }
      const body = stripHtmlComments(content.slice(bounds.start, bounds.end)).trim();
      if (!body) diagnostics.push(diagnostic('ARTIFACT_EMPTY_SECTION', `section '${section.headings.zh}' has no semantic body`, section.id, lineNumber(content, heading.start)));
    }
    if (marker && !heading && marker.standalone) {
      const nextHeading = scanned.headings.find((candidate) => candidate.start > marker.start && candidate.level <= 2);
      const body = stripHtmlComments(content.slice(marker.end, nextHeading?.start ?? content.length)).trim();
      if (!body) {
        diagnostics.push(diagnostic('ARTIFACT_EMPTY_SECTION', `section '${section.headings.zh}' has no semantic body`, section.id, marker.line));
      }
    }
  }
  for (const marker of markers) {
    if (!schema.sections.some((section) => markerPattern(section.marker).test(`<!-- ${marker.marker} -->`))) {
      diagnostics.push(diagnostic('ARTIFACT_MARKER_MISMATCH', `unknown section marker '${marker.marker}'`, null, marker.line));
    }
  }

  const orderedHeadings = schema.sections.flatMap((section) => {
    const heading = headingsBySection.get(section.id)?.[0];
    return heading ? [{ section, start: heading.start }] : [];
  });
  if (orderedHeadings.some((item, index) => index > 0 && item.start <= orderedHeadings[index - 1]!.start)) {
    diagnostics.push(diagnostic('ARTIFACT_SECTION_ORDER_INVALID', 'required sections are not in schema order', null, null));
  }
  const orderedMarkers = schema.sections.flatMap((section) => {
    const marker = markers.find((entry) => entry.marker === section.marker);
    return marker ? [{ section, start: marker.start }] : [];
  });
  if (orderedMarkers.some((item, index) => index > 0 && item.start <= orderedMarkers[index - 1]!.start)) {
    diagnostics.push(diagnostic('ARTIFACT_SECTION_ORDER_INVALID', 'section markers are not in schema order', null, null));
  }

  return {
    ok: diagnostics.length === 0,
    family: schema.family,
    semanticDigest: canonicalSemanticDigest(content),
    diagnostics
  };
}

function inspectArtifactPatterns(
  content: string,
  schema: ArtifactSchema
): ArtifactStructureResult {
  const diagnostics = schema.requiredPatterns
    .filter((pattern) => !new RegExp(pattern, 'm').test(content))
    .map((pattern) => diagnostic(
      'ARTIFACT_REQUIRED_PATTERN_MISSING',
      `artifact is missing required pattern '${pattern}'`,
      null,
      null
    ));
  return {
    ok: diagnostics.length === 0,
    family: schema.family,
    semanticDigest: canonicalSemanticDigest(content),
    diagnostics
  };
}

function inspectArtifactContract(
  content: string,
  schema: ArtifactSchema
): ArtifactStructureResult {
  const structure = inspectArtifactStructure(content, schema);
  const patterns = inspectArtifactPatterns(content, schema);
  const diagnostics = [...structure.diagnostics, ...patterns.diagnostics];
  return {
    ok: diagnostics.length === 0,
    family: schema.family,
    semanticDigest: canonicalSemanticDigest(content),
    diagnostics
  };
}

function resultFailure(code: string, message: string): ArtifactFileResult {
  return { status: 'failed', changed: false, artifactSha256: null, semanticDigest: null, error: { code, message } };
}

function resultNoOp(content: string): ArtifactFileResult {
  return {
    status: 'no-op',
    changed: false,
    artifactSha256: sha256Content(content),
    semanticDigest: canonicalSemanticDigest(content),
    error: null
  };
}

function artifactRound(family: ArtifactSchemaFamily, artifact: string): number | null {
  const identity = parseArtifactName(artifact);
  return identity?.family === family ? identity.round : null;
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
        return resultNoOp(readStableFileSync(target, { maxBytes: 1024 * 1024 }).bytes.toString('utf8'));
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
        error: null
      };
    });
  } catch (error) {
    return resultFailure('ARTIFACT_INIT_LOCK_FAILED', String(error));
  }
}

export {
  canonicalSemanticDigest,
  initializeArtifactSkeleton,
  inspectArtifactContract,
  inspectArtifactPatterns,
  inspectArtifactStructure,
  sha256Content
};
export type {
  ArtifactFileResult,
  ArtifactInitRequest,
  ArtifactStructuralDiagnostic,
  ArtifactStructuralDiagnosticCode,
  ArtifactStructureResult
};
