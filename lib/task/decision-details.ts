type SourceLine = {
  start: number;
  end: number;
  text: string;
};

type VisibleHeading = SourceLine & {
  level: number;
  text: string;
};

type VisibleAnchor = SourceLine & {
  id: string;
};

type VisibleMarkdown = {
  lines: SourceLine[];
  headings: VisibleHeading[];
  anchors: VisibleAnchor[];
};

type DecisionDetailBlock = {
  id: string;
  heading: string;
  canonical: boolean;
  start: number;
  end: number;
  content: string;
};

type DecisionDetailResolution =
  | { status: 'found'; block: DecisionDetailBlock }
  | { status: 'missing'; reason: string }
  | { status: 'ambiguous'; reason: string; candidates: DecisionDetailBlock[] };

type DecisionDetailDuplicate = {
  id: string;
  blocks: DecisionDetailBlock[];
};

type DecisionDetailInspection =
  | { ok: true; blocks: DecisionDetailBlock[] }
  | {
      ok: false;
      code: 'DECISION_DETAIL_DUPLICATE';
      message: string;
      blocks: DecisionDetailBlock[];
      duplicates: DecisionDetailDuplicate[];
    };

const DECISION_ID = /^(AN|PL|CD|HD)-[1-9]\d*(?=$|[\s:：])/i;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const ANCHOR = /^\s*<a\s+id=(['"])([^'"]+)\1\s*><\/a>\s*$/;
const FIELD = /^\s*[-*]\s+\*\*([^*]+)\*\*\s*[:：]\s*/;
const OPTION_HEADING = /^(?:方案|Option)\s+[A-Z](?:\b|\s*[:：])/i;

function sourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    lines.push({ start, end, text: content.slice(start, end).replace(/\r$/, '') });
    start = newline === -1 ? content.length : newline + 1;
  }
  return lines;
}

function scanVisibleMarkdown(content: string): VisibleMarkdown {
  const lines = sourceLines(content);
  const visible: SourceLine[] = [];
  const headings: VisibleHeading[] = [];
  const anchors: VisibleAnchor[] = [];
  let fence: { character: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    if (fence) {
      const close = line.text.match(FENCE_CLOSE);
      if (close && close[1]![0] === fence.character && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = line.text.match(FENCE_OPEN);
    const marker = open?.[1];
    const info = open?.[2] ?? '';
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = { character: marker[0] as '`' | '~', length: marker.length };
      continue;
    }
    visible.push(line);
    const heading = line.text.match(HEADING);
    if (heading) headings.push({ ...line, level: heading[1]!.length, text: heading[2]!.trim() });
    const anchor = line.text.match(ANCHOR);
    if (anchor) anchors.push({ ...line, id: anchor[2]! });
  }
  return { lines: visible, headings, anchors };
}

function parseDecisionDetailBlocks(content: string): DecisionDetailBlock[] {
  const scanned = scanVisibleMarkdown(content);
  const details = scanned.headings.filter((heading) => heading.level === 3 && DECISION_ID.test(heading.text));
  return details.map((heading) => {
    const next = scanned.headings.find((candidate) => (
      candidate.start > heading.start && candidate.level <= 3
    ));
    const end = next?.start ?? content.length;
    return {
      id: heading.text.match(DECISION_ID)![0]!,
      heading: heading.text,
      canonical: /\[needs-human-decision\]/i.test(heading.text),
      start: heading.start,
      end,
      content: content.slice(heading.start, end).trim()
    };
  });
}

function parseDecisionEvidence(evidence: string): { ok: true; artifact: string; anchor: string } | { ok: false } {
  const separator = evidence.indexOf('#');
  if (separator <= 0 || evidence.indexOf('#', separator + 1) !== -1) return { ok: false };
  const artifact = evidence.slice(0, separator);
  const anchor = evidence.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(artifact)) return { ok: false };
  if (!anchor || /[\s\u0000-\u001f#]/.test(anchor)) return { ok: false };
  return { ok: true, artifact, anchor };
}

function sameId(left: string, right: string): boolean {
  return left.toUpperCase() === right.toUpperCase();
}

function resolveDecisionDetail(content: string, rowId: string, anchor: string): DecisionDetailResolution {
  const scanned = scanVisibleMarkdown(content);
  const blocks = parseDecisionDetailBlocks(content);
  const explicit = scanned.anchors.filter((candidate) => candidate.id === anchor);
  if (explicit.length > 1) {
    return { status: 'ambiguous', reason: `evidence anchor '${anchor}' occurs more than once`, candidates: [] };
  }
  if (explicit.length === 1) {
    const marker = explicit[0]!;
    const followingLine = scanned.lines.find((line) => line.start > marker.end && line.text.trim());
    const followingHeading = followingLine
      ? scanned.headings.find((heading) => heading.start === followingLine.start)
      : undefined;
    const candidate = followingHeading?.level === 3
      ? blocks.find((block) => block.start === followingHeading.start)
      : undefined;
    if (!candidate || !sameId(candidate.id, rowId) || !candidate.canonical) {
      return { status: 'missing', reason: `evidence anchor '${anchor}' does not identify a canonical ${rowId} detail` };
    }
    return { status: 'found', block: candidate };
  }
  if (!sameId(anchor, rowId)) {
    return { status: 'missing', reason: `evidence anchor '${anchor}' is not the ledger id '${rowId}'` };
  }
  const matches = blocks.filter((block) => sameId(block.id, rowId) && block.canonical);
  if (matches.length === 0) return { status: 'missing', reason: `no canonical ${rowId} detail was found` };
  if (matches.length > 1) {
    return { status: 'ambiguous', reason: `more than one canonical ${rowId} detail was found`, candidates: matches };
  }
  return { status: 'found', block: matches[0]! };
}

function inspectDecisionDetailDuplicates(content: string): DecisionDetailInspection {
  const blocks = parseDecisionDetailBlocks(content);
  const grouped = new Map<string, DecisionDetailBlock[]>();
  for (const block of blocks) {
    const key = block.id.toUpperCase();
    const group = grouped.get(key) ?? [];
    group.push(block);
    grouped.set(key, group);
  }
  const duplicates: DecisionDetailDuplicate[] = [];
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    duplicates.push({ id: group[0]!.id, blocks: group });
  }
  if (duplicates.length === 0) return { ok: true, blocks };
  const summary = duplicates.map((duplicate) => {
    const types = duplicate.blocks.map((block) => block.canonical ? 'canonical' : 'informal').join(', ');
    return `${duplicate.id} (${duplicate.blocks.length} blocks: ${types})`;
  }).join(', ');
  return {
    ok: false,
    code: 'DECISION_DETAIL_DUPLICATE',
    message: `Duplicate decision detail ids: ${summary}`,
    blocks,
    duplicates
  };
}

type FieldKey = 'decision' | 'why' | 'impact' | 'risk' | 'analogy' | 'recommend' | 'reason' | 'implementation';

const FIELD_KEYS: Record<string, FieldKey> = {
  '为什么现在要决定': 'why', 'why decide now': 'why', 'why a decision is needed now': 'why',
  '要决定什么': 'decision', 'what to decide': 'decision', 'what needs a decision': 'decision',
  '会影响什么': 'impact', 'what it affects': 'impact', 'what this affects': 'impact',
  '如果选错或暂不处理': 'risk', 'if wrong or postponed': 'risk',
  'what could go wrong': 'risk',
  '打个比方': 'analogy', '例子': 'analogy', 'example': 'analogy',
  '建议选哪个': 'recommend', 'recommended option': 'recommend', 'recommended choice': 'recommend',
  '为什么这样建议': 'reason', 'why this recommendation': 'reason', 'why this choice': 'reason',
  '是否需要实现': 'implementation', 'implementation required': 'implementation'
};

const TERMINAL_FIELD_KEYS = new Set<FieldKey>(['recommend', 'reason', 'implementation']);

function normalizeDecisionDetailForDisplay(block: DecisionDetailBlock): string {
  const body = block.content;
  const scanned = scanVisibleMarkdown(body);
  const heading = scanned.headings.find((candidate) => candidate.level === 3);
  if (!heading) return body.trim();
  const options = scanned.headings.filter((candidate) => candidate.level === 4 && OPTION_HEADING.test(candidate.text));
  const optionRanges = options.map((option, index) => ({
    start: option.start,
    end: options[index + 1]?.start
      ?? scanned.headings.find((candidate) => candidate.start > option.start && candidate.level <= 3)?.start
      ?? scanned.lines.find((line) => (
        line.start > option.start
        && FIELD.test(line.text)
        && TERMINAL_FIELD_KEYS.has(FIELD_KEYS[line.text.match(FIELD)![1]!.trim().toLowerCase()] as FieldKey)
      ))?.start
      ?? body.length
  }));
  const topLines = scanned.lines.filter((line) => (
    line.start > heading.end && !optionRanges.some((range) => line.start >= range.start && line.start < range.end)
  ));
  const fields: { key: FieldKey | null; line: SourceLine }[] = [];
  for (const line of topLines) {
    const match = line.text.match(FIELD);
    if (!match) continue;
    const key = FIELD_KEYS[match[1]!.trim().toLowerCase()];
    fields.push({ key: key ?? null, line });
  }
  if (fields.some((field) => field.key === null)) return body.trim();
  const byKey = new Map<FieldKey, string>();
  const selectedRanges: { start: number; end: number }[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field.key) continue;
    const nextOption = optionRanges.find((range) => range.start > field.line.start)?.start ?? body.length;
    const end = Math.min(fields[index + 1]?.line.start ?? body.length, nextOption);
    const value = body.slice(field.line.start, end).trim();
    byKey.set(field.key, value);
    selectedRanges.push({ start: field.line.start, end });
  }
  selectedRanges.push(...optionRanges);
  const required: FieldKey[] = ['decision', 'why', 'impact', 'recommend', 'reason'];
  if (required.some((key) => !byKey.has(key)) || options.length < 2) return body.trim();
  const sortedRanges = selectedRanges.sort((left, right) => left.start - right.start);
  let cursor = heading.end;
  for (const range of sortedRanges) {
    if (/\S/.test(body.slice(cursor, range.start))) return body.trim();
    cursor = Math.max(cursor, range.end);
  }
  if (/\S/.test(body.slice(cursor))) return body.trim();
  const ordered: string[] = [
    byKey.get('decision')!, byKey.get('why')!, byKey.get('impact')!
  ];
  for (const optional of ['risk', 'analogy'] as const) if (byKey.has(optional)) ordered.push(byKey.get(optional)!);
  ordered.push(...optionRanges.map((range) => body.slice(range.start, range.end).trim()));
  ordered.push(byKey.get('recommend')!, byKey.get('reason')!);
  if (byKey.has('implementation')) ordered.push(byKey.get('implementation')!);
  return [body.slice(heading.start, heading.end).trim(), ...ordered].join('\n\n').trim();
}

export {
  inspectDecisionDetailDuplicates,
  normalizeDecisionDetailForDisplay,
  parseDecisionDetailBlocks,
  parseDecisionEvidence,
  resolveDecisionDetail,
  scanVisibleMarkdown
};
export type {
  DecisionDetailBlock,
  DecisionDetailDuplicate,
  DecisionDetailInspection,
  DecisionDetailResolution,
  SourceLine,
  VisibleHeading,
  VisibleMarkdown
};
