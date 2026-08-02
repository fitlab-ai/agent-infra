import fs from 'node:fs';
import path from 'node:path';

type ReviewFindingCounts = {
  blocker: number;
  major: number;
  minor: number;
};

type ReviewVerdict = 'Approved' | 'Changes Requested' | 'Rejected';
type ReviewSummary = {
  verdict: ReviewVerdict;
  counts: ReviewFindingCounts | null;
  manualValidation: number | null;
  countState: 'placeholders' | 'numeric';
};
type ReviewSummaryErrorCode =
  | 'REVIEW_SUMMARY_NOT_FOUND'
  | 'REVIEW_SUMMARY_PLACEHOLDER_INVALID'
  | 'REVIEW_SUMMARY_COUNT_MISMATCH';
type ReviewSummaryParseResult =
  | { ok: true; summary: ReviewSummary; findingsStart: number; findingsEnd: number }
  | { ok: false; code: ReviewSummaryErrorCode; message: string };
type ReviewSummaryFinalizeResult =
  | { ok: true; changed: boolean; content: string }
  | { ok: false; code: ReviewSummaryErrorCode; message: string };

const SUMMARY_HEADINGS = new Set(['审查摘要', 'Review Summary']);
const PLACEHOLDERS = [
  '{unresolved-blockers}',
  '{unresolved-major}',
  '{unresolved-minor}'
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maxRound(entries: string[], stem: string): number {
  let max = 0;
  for (const entry of entries) {
    if (entry === `${stem}.md`) {
      max = Math.max(max, 1);
      continue;
    }
    const match = entry.match(new RegExp(`^${escapeRegExp(stem)}-r(\\d+)\\.md$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function artifactName(stem: string, round: number): string {
  return round === 1 ? `${stem}.md` : `${stem}-r${round}.md`;
}

function normalizeVerdict(raw: unknown): ReviewVerdict | '' {
  const value = String(raw).trim().toLowerCase();
  if (value === '通过' || value === 'approved') return 'Approved';
  if (value === '需要修改' || value === 'changes requested') return 'Changes Requested';
  if (value === '拒绝' || value === 'rejected') return 'Rejected';
  return '';
}

function extractSection(content: string, names: string[]): string {
  const lines = content.split(/\r?\n/);
  const nameSet = new Set(names);
  const start = lines.findIndex((line) => {
    const match = line.trim().match(/^##\s+(.+?)\s*$/);
    return match ? nameSet.has(match[1]!) : false;
  });
  if (start === -1) return '';
  const sectionLines = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]!)) break;
    sectionLines.push(lines[index]);
  }
  return sectionLines.join('\n');
}

function summaryBounds(content: string): { start: number; end: number } | null {
  const headings = [...content.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => ({ index: match.index, end: match.index + match[0].length, name: match[1]! }));
  const summaries = headings.filter((heading) => SUMMARY_HEADINGS.has(heading.name));
  if (summaries.length !== 1) return null;
  const summary = summaries[0]!;
  const next = headings.find((heading) => heading.index > summary.index);
  return { start: summary.end, end: next?.index ?? content.length };
}

function uniqueLine(
  content: string,
  bounds: { start: number; end: number },
  pattern: RegExp
): { value: string; start: number; end: number } | null {
  const section = content.slice(bounds.start, bounds.end);
  const matches = [...section.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return {
    value: match[1]!,
    start: bounds.start + match.index,
    end: bounds.start + match.index + match[0].length
  };
}

function parseCounts(value: string): ReviewFindingCounts | null {
  const zh = /^(\d+)\s*阻塞项，\s*(\d+)\s*主要，\s*(\d+)\s*次要(?:\s*\/.*)?$/.exec(value);
  const en = /^(\d+)\s*blockers?,\s*(\d+)\s*majors?,\s*(\d+)\s*minors?(?:\s*\/.*)?$/i.exec(value);
  const match = zh ?? en;
  if (!match) return null;
  const [blocker, major, minor] = match.slice(1, 4).map(Number);
  if (![blocker, major, minor].every(Number.isSafeInteger)) return null;
  return { blocker: blocker!, major: major!, minor: minor! };
}

function parseManualValidation(value: string): number | null {
  const match = /\*\*(?:人工校验|Manual[- ]validation)\*\*[:：]\s*(\d+)/i.exec(value);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : null;
}

function hasCanonicalPlaceholders(value: string): boolean {
  const zh = /^\{unresolved-blockers\}\s*阻塞项，\s*\{unresolved-major\}\s*主要，\s*\{unresolved-minor\}\s*次要(?:\s*\/.*)?$/.test(value);
  const en = /^\{unresolved-blockers\}\s*blockers?,\s*\{unresolved-major\}\s*majors?,\s*\{unresolved-minor\}\s*minors?(?:\s*\/.*)?$/i.test(value);
  return zh || en;
}

function parseReviewSummary(content: string): ReviewSummaryParseResult {
  const bounds = summaryBounds(content);
  if (!bounds) {
    return { ok: false, code: 'REVIEW_SUMMARY_NOT_FOUND', message: 'review artifact must contain one review summary section' };
  }
  const verdictLine = uniqueLine(
    content,
    bounds,
    /^[-*]?\s*\*\*(?:总体结论|Overall Verdict)\*\*[:：]\s*(.+?)\s*$/gim
  );
  const findingsLine = uniqueLine(
    content,
    bounds,
    /^[-*]?\s*\*\*(?:发现（AI 可处理）|Findings \(AI-actionable\))\*\*[:：]\s*(.+?)\s*$/gim
  );
  const verdict = verdictLine ? normalizeVerdict(verdictLine.value) : '';
  if (!verdict || !findingsLine) {
    return { ok: false, code: 'REVIEW_SUMMARY_NOT_FOUND', message: 'review summary verdict or finding count line is missing or repeated' };
  }

  const counts = parseCounts(findingsLine.value);
  if (counts) {
    return {
      ok: true,
      summary: { verdict, counts, manualValidation: parseManualValidation(findingsLine.value), countState: 'numeric' },
      findingsStart: findingsLine.start,
      findingsEnd: findingsLine.end
    };
  }
  const placeholderOccurrences = PLACEHOLDERS.map((token) => (
    [...findingsLine.value.matchAll(new RegExp(escapeRegExp(token), 'g'))].length
  ));
  if (hasCanonicalPlaceholders(findingsLine.value) && placeholderOccurrences.every((count) => count === 1)) {
    return {
      ok: true,
      summary: { verdict, counts: null, manualValidation: parseManualValidation(findingsLine.value), countState: 'placeholders' },
      findingsStart: findingsLine.start,
      findingsEnd: findingsLine.end
    };
  }
  return {
    ok: false,
    code: 'REVIEW_SUMMARY_PLACEHOLDER_INVALID',
    message: 'review summary finding counts must be three canonical placeholders or non-negative integers'
  };
}

function equalCounts(left: ReviewFindingCounts, right: ReviewFindingCounts): boolean {
  return left.blocker === right.blocker && left.major === right.major && left.minor === right.minor;
}

function finalizeReviewSummaryContent(
  content: string,
  counts: ReviewFindingCounts
): ReviewSummaryFinalizeResult {
  const parsed = parseReviewSummary(content);
  if (!parsed.ok) return parsed;
  if (parsed.summary.countState === 'numeric') {
    if (equalCounts(parsed.summary.counts!, counts)) return { ok: true, changed: false, content };
    return {
      ok: false,
      code: 'REVIEW_SUMMARY_COUNT_MISMATCH',
      message: 'review summary finding counts do not match the ledger snapshot'
    };
  }
  let line = content.slice(parsed.findingsStart, parsed.findingsEnd);
  line = line
    .replace(PLACEHOLDERS[0], String(counts.blocker))
    .replace(PLACEHOLDERS[1], String(counts.major))
    .replace(PLACEHOLDERS[2], String(counts.minor));
  return {
    ok: true,
    changed: true,
    content: content.slice(0, parsed.findingsStart) + line + content.slice(parsed.findingsEnd)
  };
}

function parseVerdict(reviewPath: string):
  | { ok: true; verdict: 'Approved' | 'Approved-with-issues' | 'Changes Requested' | 'Rejected' }
  | { ok: false; verdict: null; message: string } {
  if (!fs.existsSync(reviewPath)) {
    return { ok: false, verdict: null, message: `Review artifact not found: ${path.basename(reviewPath)}` };
  }
  const parsed = parseReviewSummary(fs.readFileSync(reviewPath, 'utf8'));
  if (!parsed.ok) {
    return {
      ok: false,
      verdict: null,
      message: `cannot parse review summary in ${path.basename(reviewPath)}: ${parsed.message}`
    };
  }
  const { verdict, counts } = parsed.summary;
  if (verdict !== 'Approved') return { ok: true, verdict };
  return {
    ok: true,
    verdict: counts && equalCounts(counts, { blocker: 0, major: 0, minor: 0 })
      ? 'Approved'
      : 'Approved-with-issues'
  };
}

export {
  artifactName,
  equalCounts,
  escapeRegExp,
  extractSection,
  finalizeReviewSummaryContent,
  maxRound,
  normalizeVerdict,
  parseReviewSummary,
  parseVerdict
};
export type {
  ReviewFindingCounts,
  ReviewSummary,
  ReviewSummaryErrorCode,
  ReviewSummaryFinalizeResult,
  ReviewSummaryParseResult,
  ReviewVerdict
};
