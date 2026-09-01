type IssueCommentViolationKind = 'canonical-artifact-link' | 'local-link';

type IssueCommentViolation = Readonly<{
  kind: IssueCommentViolationKind;
  line: number;
  column: number;
  token: string;
  message: string;
}>;

type Range = Readonly<{ start: number; end: number }>;
type Line = Readonly<{ start: number; end: number; text: string }>;
type HtmlAttribute = Readonly<{ name: string; index: number; value: string }>;
type HtmlTag = Readonly<{ end: number; attributes: readonly HtmlAttribute[] }>;

const CANONICAL_ARTIFACT = /^(?:analysis|review-analysis|plan|review-plan|code|review-code|manual-validation|validation-run|pr-review)(?:-r(?:[2-9]|[1-9]\d+))?\.md(?:[#?].*)?$/u;

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf('\n', start);
    const fullEnd = newline < 0 ? content.length : newline + 1;
    const end = newline < 0 ? content.length : newline;
    const text = content.slice(start, end).replace(/\r$/u, '');
    lines.push({ start, end: fullEnd, text });
    if (newline < 0) break;
    start = fullEnd;
  }
  return lines;
}

function runLength(content: string, index: number, character: string): number {
  let end = index;
  while (content[end] === character) end += 1;
  return end - index;
}

function exactRun(content: string, index: number, character: string, length: number): boolean {
  return content[index - 1] !== character
    && runLength(content, index, character) === length
    && content[index + length] !== character;
}

function escaped(content: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function rangeAt(ranges: readonly Range[], index: number): Range | null {
  for (const range of ranges) {
    if (index < range.start) return null;
    if (index < range.end) return range;
  }
  return null;
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function fenceOpening(line: string): { character: '`' | '~'; length: number } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line);
  if (!match) return null;
  const character = match[1]![0] as '`' | '~';
  if (character === '`' && line.slice(match[0].length).includes('`')) return null;
  return { character, length: match[1]!.length };
}

function fenceClosing(line: string, opening: { character: '`' | '~'; length: number }): boolean {
  const escapedCharacter = opening.character === '`' ? '`' : '~';
  const pattern = new RegExp(`^ {0,3}${escapedCharacter}{${opening.length},}[ \\t]*$`, 'u');
  return pattern.test(line);
}

function findFenceRanges(content: string): Range[] {
  const lines = splitLines(content);
  const ranges: Range[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = fenceOpening(lines[index]!.text);
    if (!opening) continue;
    for (let close = index + 1; close < lines.length; close += 1) {
      if (!fenceClosing(lines[close]!.text, opening)) continue;
      ranges.push({ start: lines[index]!.start, end: lines[close]!.end });
      index = close;
      break;
    }
  }
  return ranges;
}

function findHtmlCommentRanges(content: string, existing: readonly Range[]): Range[] {
  const ranges: Range[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf('<!--', cursor);
    if (start < 0) break;
    if (rangeAt(existing, start)) {
      cursor = rangeAt(existing, start)!.end;
      continue;
    }
    const endMarker = content.indexOf('-->', start + 4);
    if (endMarker < 0) break;
    ranges.push({ start, end: endMarker + 3 });
    cursor = endMarker + 3;
  }
  return ranges;
}

function fenceCandidateAt(content: string, index: number, length: number): boolean {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  return /^ {0,3}$/u.test(content.slice(lineStart, index)) && length >= 3;
}

function findInlineCodeRanges(content: string, existing: readonly Range[]): Range[] {
  const ranges: Range[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const protectedRange = rangeAt(existing, cursor);
    if (protectedRange) {
      cursor = protectedRange.end;
      continue;
    }
    if (content[cursor] !== '`' || escaped(content, cursor)) {
      cursor += 1;
      continue;
    }
    const length = runLength(content, cursor, '`');
    if (fenceCandidateAt(content, cursor, length)) {
      cursor += length;
      continue;
    }
    let closing = cursor + length;
    let found = -1;
    while (closing < content.length) {
      const skipped = rangeAt(existing, closing);
      if (skipped) {
        closing = skipped.end;
        continue;
      }
      if (content[closing] === '`' && !escaped(content, closing) && exactRun(content, closing, '`', length)) {
        found = closing;
        break;
      }
      closing += 1;
    }
    if (found < 0) {
      cursor += length;
      continue;
    }
    ranges.push({ start: cursor, end: found + length });
    cursor = found + length;
  }
  return ranges;
}

function protectedRanges(content: string): Range[] {
  const fences = findFenceRanges(content);
  const comments = findHtmlCommentRanges(content, fences);
  const base = mergeRanges([...fences, ...comments]);
  return mergeRanges([...base, ...findInlineCodeRanges(content, base)]);
}

function lineColumn(content: string, index: number): { line: number; column: number } {
  const prefix = content.slice(0, index);
  const line = prefix.split('\n').length;
  const lastNewline = prefix.lastIndexOf('\n');
  return { line, column: index - lastNewline };
}

function destinationKind(destination: string): IssueCommentViolationKind | null {
  const target = destination.trim().replace(/^<|>$/gu, '');
  const normalized = target.replaceAll('\\', '/');
  const basename = normalized.replace(/^\.\//u, '');
  if (CANONICAL_ARTIFACT.test(basename) && !basename.includes('/')) return 'canonical-artifact-link';
  if (
    /(?:^|\/)\.agents\/workspace\/active\//u.test(normalized)
    || /^(?:~(?:\/|$)|\/(?:root|workspace|Users|home|tmp|var\/tmp|private\/tmp|var\/folders)(?:\/|$))/u.test(normalized)
    || /^(?:[A-Za-z]:\/|\\\\|\/\/)/u.test(normalized)
    || /^(?:%TEMP%|\$TMPDIR)(?:\/|$)/iu.test(normalized)
  ) return 'local-link';
  return null;
}

function violation(
  content: string,
  index: number,
  kind: IssueCommentViolationKind,
  token: string
): IssueCommentViolation {
  const position = lineColumn(content, index);
  const message = kind === 'canonical-artifact-link'
      ? 'artifact 文件引用必须使用代码文本而不是 Markdown 链接'
      : '本地路径不得作为 Issue 评论中的可点击链接';
  return { kind, line: position.line, column: position.column, token, message };
}

function matchingBracket(content: string, start: number, open: string, close: string): number {
  for (let index = start; index < content.length; index += 1) {
    if (escaped(content, index)) continue;
    if (content[index] === close) return index;
    if (content[index] === open) {
      const nested = matchingBracket(content, index + 1, open, close);
      if (nested < 0) return -1;
      index = nested;
    }
  }
  return -1;
}

function linkDestination(content: string, start: number): {
  end: number;
  destination: string;
} | null {
  const closeBracket = matchingBracket(content, start + 1, '[', ']');
  if (closeBracket < 0 || content[closeBracket + 1] !== '(') return null;
  const closeParenthesis = matchingBracket(content, closeBracket + 2, '(', ')');
  if (closeParenthesis < 0) return null;
  const inside = content.slice(closeBracket + 2, closeParenthesis).trim();
  const match = /^(?:<([^>\r\n]*)>|(\S+))/u.exec(inside);
  if (!match) {
    return {
      end: closeParenthesis + 1,
      destination: ''
    };
  }
  return {
    end: closeParenthesis + 1,
    destination: match[1] ?? match[2]!
  };
}

function referenceDestination(line: Line): { index: number; end: number; destination: string } | null {
  const match = /^ {0,3}\[[^\]\r\n]+\]:\s*(?:<([^>\r\n]*)>|(\S+))/u.exec(line.text);
  if (!match) return null;
  const bracket = line.text.indexOf('[');
  return {
    index: line.start + bracket,
    end: line.end,
    destination: match[1] ?? match[2]!
  };
}

function externalUrlRangeAt(content: string, index: number): Range | null {
  const match = /^(?:https?:\/\/|mailto:)[^\s<>()\[\]]+/iu.exec(content.slice(index));
  if (!match) return null;
  return { start: index, end: index + match[0].length };
}

function htmlTag(content: string, start: number): HtmlTag | null {
  if (content[start] !== '<' || content.startsWith('<!--', start)) return null;
  let quote: '"' | "'" | null = null;
  let end = -1;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      end = index;
      break;
    }
  }
  if (end < 0) return null;

  let cursor = start + 1;
  const closing = content[cursor] === '/';
  if (closing) cursor += 1;
  if (!/[A-Za-z]/u.test(content[cursor] ?? '')) return null;
  cursor += 1;
  while (cursor < end && /[A-Za-z0-9:-]/u.test(content[cursor]!)) cursor += 1;
  if (closing) {
    while (cursor < end && /\s/u.test(content[cursor]!)) cursor += 1;
    return cursor === end ? { end: end + 1, attributes: [] } : null;
  }

  const attributes: HtmlAttribute[] = [];
  while (cursor < end) {
    while (cursor < end && /\s/u.test(content[cursor]!)) cursor += 1;
    if (cursor >= end) break;
    if (content[cursor] === '/') {
      cursor += 1;
      while (cursor < end && /\s/u.test(content[cursor]!)) cursor += 1;
      if (cursor !== end) return null;
      break;
    }
    const nameStart = cursor;
    if (!/[A-Za-z_:]/u.test(content[cursor]!)) return null;
    cursor += 1;
    while (cursor < end && /[A-Za-z0-9_.:-]/u.test(content[cursor]!)) cursor += 1;
    const name = content.slice(nameStart, cursor);
    while (cursor < end && /\s/u.test(content[cursor]!)) cursor += 1;
    if (content[cursor] !== '=') continue;
    cursor += 1;
    while (cursor < end && /\s/u.test(content[cursor]!)) cursor += 1;
    if (cursor >= end) return null;
    const valueStart = cursor;
    let valueEnd = cursor;
    if (content[cursor] === '"' || content[cursor] === "'") {
      const valueQuote = content[cursor]!;
      cursor += 1;
      const quotedStart = cursor;
      while (cursor < end && content[cursor] !== valueQuote) cursor += 1;
      valueEnd = cursor;
      attributes.push({ name, index: nameStart, value: content.slice(quotedStart, valueEnd) });
      if (cursor < end) cursor += 1;
    } else {
      while (cursor < end && !/[\s>]/u.test(content[cursor]!)) cursor += 1;
      valueEnd = cursor;
      attributes.push({ name, index: nameStart, value: content.slice(valueStart, valueEnd) });
    }
  }
  return { end: end + 1, attributes };
}

function htmlDestinations(tag: HtmlTag): readonly HtmlAttribute[] {
  return tag.attributes.filter(({ name }) => /^(?:href|src)$/iu.test(name));
}

function findIssueCommentViolations(content: string): IssueCommentViolation[] {
  const ranges = protectedRanges(content);
  const violations: IssueCommentViolation[] = [];
  const lines = splitLines(content);
  let index = 0;
  while (index < content.length) {
    const protectedRange = rangeAt(ranges, index);
    if (protectedRange) {
      index = protectedRange.end;
      continue;
    }
    const line = lines.find((candidate) => index >= candidate.start && index < candidate.end);
    if (line && index === line.start) {
      const reference = referenceDestination(line);
      if (reference) {
        const kind = destinationKind(reference.destination);
        if (kind) violations.push(violation(content, reference.index, kind, reference.destination));
        index = reference.end;
        continue;
      }
    }
    if (content[index] === '[' && !escaped(content, index)) {
      const link = linkDestination(content, index);
      if (link) {
        const kind = destinationKind(link.destination);
        if (kind) violations.push(violation(content, index, kind, link.destination));
        index = link.end;
        continue;
      }
    }
    if (content[index] === '<' && !content.startsWith('<!--', index)) {
      const tag = htmlTag(content, index);
      if (tag) {
        for (const attribute of htmlDestinations(tag)) {
          const kind = destinationKind(attribute.value);
          if (kind) violations.push(violation(content, attribute.index, kind, attribute.value));
        }
        index = tag.end;
        continue;
      }
    }
    const url = externalUrlRangeAt(content, index);
    if (url) {
      index = url.end;
      continue;
    }
    index += 1;
  }
  return violations.sort((left, right) => {
    const leftIndex = content.indexOf(left.token);
    const rightIndex = content.indexOf(right.token);
    return left.line - right.line || left.column - right.column || leftIndex - rightIndex;
  });
}

export { findIssueCommentViolations };
export type { IssueCommentViolation, IssueCommentViolationKind };
