type SanitizationError = { code: 'COMMENT_DOCUMENT_INVALID'; message: string; offset: number };
type SanitizationResult<T> = { ok: true; value: T } | { ok: false; error: SanitizationError };
type SanitizationOptions = { reservedMarkers?: readonly RegExp[] };
type PlaceholderSplit = { prefix: string; suffix: string };
type FenceRange = {
  start: number;
  end: number;
  openingEnd: number;
  closingStart: number;
  character: '`' | '~';
  opening: string;
  closing: string;
};
type Line = { start: number; end: number; text: string };

const CONTROL_MARKER_PATTERN = /<!--\s*(?:sync-issue|sync-pr|last-commit)\b[\s\S]*?-->|<!--\s*canonical-pr-change-report\s*-->/gi;

function ok<T>(value: T): SanitizationResult<T> {
  return { ok: true, value };
}

function invalid(message: string, offset: number): SanitizationResult<never> {
  return { ok: false, error: { code: 'COMMENT_DOCUMENT_INVALID', message, offset } };
}

function normalized(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function linesOf(value: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < value.length) {
    const newline = value.indexOf('\n', start);
    const end = newline === -1 ? value.length : newline;
    lines.push({ start, end: newline === -1 ? end : newline + 1, text: value.slice(start, end) });
    start = newline === -1 ? value.length : newline + 1;
  }
  if (value.length === 0) lines.push({ start: 0, end: 0, text: '' });
  return lines;
}

function openingFence(line: string): { character: '`' | '~'; length: number } | null | 'invalid' {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const character = match[1]![0] as '`' | '~';
  const info = match[2]!;
  if (character === '`' && info.includes('`')) return 'invalid';
  return { character, length: match[1]!.length };
}

function closesFence(line: string, fence: { character: '`' | '~'; length: number }): boolean {
  const escaped = fence.character === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${escaped}{${fence.length},}[ \\t]*$`).test(line);
}

function fenceRanges(value: string): SanitizationResult<FenceRange[]> {
  const ranges: FenceRange[] = [];
  let fence: { character: '`' | '~'; length: number; start: number; openingEnd: number } | null = null;
  for (const line of linesOf(value)) {
    if (!fence) {
      const opening = openingFence(line.text);
      if (opening === 'invalid') return invalid('fenced code info string is invalid', line.start);
      if (opening) fence = { ...opening, start: line.start, openingEnd: line.end };
      continue;
    }
    if (closesFence(line.text, fence)) {
      ranges.push({
        start: fence.start,
        end: line.end,
        openingEnd: fence.openingEnd,
        closingStart: line.start,
        character: fence.character,
        opening: value.slice(fence.start, fence.openingEnd),
        closing: value.slice(line.start, line.end)
      });
      fence = null;
    }
  }
  if (fence) return invalid('fenced code block is not closed', fence.start);
  return ok(ranges);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlText(value: string): string {
  return escapeHtml(value);
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeMarkdownLiteral(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&');
}

function markerSafe(value: string, markers: readonly RegExp[]): string {
  let result = value;
  for (const marker of markers) {
    const flags = marker.flags.includes('g') ? marker.flags : `${marker.flags}g`;
    const pattern = new RegExp(marker.source, flags);
    result = result.replace(pattern, (match) => escapeHtmlText(match));
  }
  return result;
}

function tagEnd(value: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function isMarkdownAutolink(value: string, start: number): boolean {
  const end = value.indexOf('>', start + 1);
  if (end === -1) return false;
  const target = value.slice(start + 1, end);
  return /^(?:https?:\/\/|mailto:)[^<>\s]+$/i.test(target)
    || /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(target);
}

function sanitizeOutside(value: string, baseOffset: number): SanitizationResult<string> {
  let result = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith('<!--', index)) {
      const end = value.indexOf('-->', index + 4);
      if (end === -1) return invalid('HTML comment is not closed', baseOffset + index);
      const token = value.slice(index, end + 3);
      result += escapeHtmlText(token);
      index = end + 3;
      continue;
    }
    if (value[index] === '<' && isMarkdownAutolink(value, index)) {
      const end = value.indexOf('>', index + 1);
      result += value.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (value[index] === '<' && /[\\/!?A-Za-z]/.test(value[index + 1] || '')) {
      const end = tagEnd(value, index);
      if (end === -1) return invalid('HTML-like tag is not closed', baseOffset + index);
      result += escapeHtmlText(value.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    result += value[index]!;
    index += 1;
  }
  return ok(result);
}

function sanitizeMarkdownDocument(value: string, options: SanitizationOptions = {}): SanitizationResult<string> {
  const source = normalized(value);
  const ranges = fenceRanges(source);
  if (!ranges.ok) return ranges;
  const markers = options.reservedMarkers || [];
  let result = '';
  let cursor = 0;
  for (const range of ranges.value) {
    const outside = sanitizeOutside(source.slice(cursor, range.start), cursor);
    if (!outside.ok) return outside;
    result += outside.value;
    result += markerSafe(source.slice(range.start, range.end), markers);
    cursor = range.end;
  }
  const tail = sanitizeOutside(source.slice(cursor), cursor);
  if (!tail.ok) return tail;
  return ok(result + tail.value);
}

function renderSafeCodeFence(value: string, language = '', reservedMarkers: readonly RegExp[] = [CONTROL_MARKER_PATTERN]): string {
  const content = markerSafe(normalized(value), reservedMarkers);
  const longestRun = Math.max(0, ...(content.match(/`+/g) || []).map((run) => run.length));
  const delimiter = '`'.repeat(Math.max(3, longestRun + 1));
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${delimiter}${language}\n${content}${suffix}${delimiter}`;
}

function commentRangesOutsideFences(source: string, ranges: readonly FenceRange[]): SanitizationResult<Array<{ start: number; end: number }>> {
  const comments: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const fence of [...ranges, { start: source.length, end: source.length }]) {
    const segment = source.slice(cursor, fence.start);
    let index = 0;
    while (index < segment.length) {
      const opening = segment.indexOf('<!--', index);
      if (opening === -1) break;
      const absoluteStart = cursor + opening;
      const closing = segment.indexOf('-->', opening + 4);
      if (closing === -1) return invalid('HTML comment is not closed', absoluteStart);
      comments.push({ start: absoluteStart, end: cursor + closing + 3 });
      index = closing + 3;
    }
    cursor = fence.end;
  }
  return ok(comments);
}

function splitDocumentPlaceholder(value: string, placeholder: string): SanitizationResult<PlaceholderSplit> {
  const source = normalized(value);
  const ranges = fenceRanges(source);
  if (!ranges.ok) return ranges;
  const positions: number[] = [];
  let cursor = source.indexOf(placeholder);
  while (cursor !== -1) {
    positions.push(cursor);
    cursor = source.indexOf(placeholder, cursor + placeholder.length);
  }
  if (positions.length !== 1) return invalid('document must contain exactly one placeholder', positions[1] ?? positions[0] ?? source.length);
  const position = positions[0]!;
  if (ranges.value.some((range) => position >= range.start && position < range.end)) {
    return invalid('placeholder must be outside fenced code', position);
  }
  const comments = commentRangesOutsideFences(source, ranges.value);
  if (!comments.ok) return comments;
  const containing = comments.value.find((comment) => position >= comment.start && position < comment.end);
  if (containing && (containing.start !== position || containing.end !== position + placeholder.length)) {
    return invalid('placeholder must not be nested in another HTML comment', position);
  }
  return ok({ prefix: source.slice(0, position), suffix: source.slice(position + placeholder.length) });
}

export {
  CONTROL_MARKER_PATTERN,
  escapeHtmlAttribute,
  escapeHtmlText,
  escapeMarkdownLiteral,
  fenceRanges,
  renderSafeCodeFence,
  sanitizeMarkdownDocument,
  splitDocumentPlaceholder
};
export type { FenceRange, SanitizationError, SanitizationOptions, SanitizationResult };
