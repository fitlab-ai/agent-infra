import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { escapeHtmlText } from './comment-safety.ts';
import { isResourceIdentity } from './resource-identity.ts';
import type { ResourceIdentity } from './resource-identity.ts';

const REPORT_FILE_NAME = 'pr-change-report.json';
const REPORT_VERSION = 4 as const;
const CANONICAL_REPORT_PLACEHOLDER = '<!-- canonical-pr-change-report -->';
const CANONICAL_REPORT_HEADING = '### PR 代码增减';
const PRECHECK_IDS = [
  'target-alignment',
  'change-composition',
  'compatibility-policy',
  'legacy-path-cleanup',
  'redundancy',
  'scope-discipline'
] as const;
const PRECHECK_LABELS: Record<PrecheckId, string> = {
  'target-alignment': '目标对应',
  'change-composition': '变更构成',
  'compatibility-policy': '兼容性策略',
  'legacy-path-cleanup': '旧路径清理',
  redundancy: '冗余检查',
  'scope-discipline': '范围纪律'
};

type PrecheckId = typeof PRECHECK_IDS[number];
type CheckVerdict = 'pass' | 'needs-review';
type PrecheckVerdict = 'clear' | 'needs-review';
type PrecheckRoute = 'watch-pr' | 'review-code';

type ChangeFile = {
  status: string;
  oldPath: string | null;
  newPath: string | null;
  additions: number | null;
  deletions: number | null;
  oldBytes: number;
  newBytes: number;
  netBytes: number;
  locations: ChangeLocation[];
};

type ChangeLocation = { side: 'old' | 'new'; startLine: number; endLine: number };
type ScopedDiff = {
  kind: 'merge-base' | 'head-to-head';
  from: string;
  to: string;
  mergeBase: string | null;
  patchSha256: string;
  files: ChangeFile[];
  totals: ChangeTotals;
};
type IncrementDiff = { status: 'available' | 'unchanged' | 'unconfirmed'; fromHead: string | null; toHead: string; sourceReportSha256: string | null; diff: ScopedDiff | null };

type ChangeTotals = {
  files: number;
  textFiles: number;
  binaryFiles: number;
  additions: number;
  deletions: number;
  oldBytes: number;
  newBytes: number;
  netBytes: number;
};

type MechanicalChangeReport = {
  version: 2;
  base: string;
  head: string;
  full: ScopedDiff;
  increment: IncrementDiff;
};

type Evidence = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  detail: string;
};

type FunctionalGroup = {
  id: string;
  target: string;
  behaviorChange: string;
  necessity: string;
  files: string[];
  locations: { full: Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number }>; increment: Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number }> };
  tests: { coverage: string; cost: string };
};

type Precheck = {
  id: PrecheckId;
  verdict: CheckVerdict;
  evidence: Evidence[];
  rationale: string;
  groups?: FunctionalGroup[];
  unassigned?: { full: Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number; reason: 'shared' | 'unconfirmed'; explanation: string }>; increment: Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number; reason: 'shared' | 'unconfirmed'; explanation: string }> };
};

type PrecheckCandidate = {
  taskIntentSha256: string;
  checks: Precheck[];
};

type PullRequestIdentity = {
  repository: string;
  resource: ResourceIdentity;
  base: { repository: string; ref: string; sha: string };
  head: { repository: string; ref: string; sha: string };
};

type PrChangeReport = {
  version: typeof REPORT_VERSION;
  identity: PullRequestIdentity;
  inputs: { taskIntentSha256: string };
  diff: {
    full: ScopedDiff;
    increment: IncrementDiff;
  };
  precheck: {
    verdict: PrecheckVerdict;
    formalReview: false;
    route: PrecheckRoute;
    checks: Precheck[];
  };
};

type ValidationFailure = { code: string; message: string };
type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ValidationFailure };

function invalid(message: string, code = 'PR_CHANGE_REPORT_INVALID'): ValidationResult<never> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function containsControlMarker(value: string): boolean {
  return /<!--\s*(?:canonical-pr-change-report\b|sync-pr:|last-commit:)/i.test(value);
}

function isSafeRenderedText(value: unknown): value is string {
  return isNonEmptyString(value) && !containsControlMarker(value);
}

function isIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function validateChangeFileBytes(value: Record<string, unknown>, index: number): ValidationResult<null> {
  for (const field of ['oldBytes', 'newBytes', 'netBytes']) {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || (field !== 'netBytes' && number < 0)) {
      return invalid(`diff.files[${index}].${field} is invalid`);
    }
  }
  if (value.netBytes !== (value.newBytes as number) - (value.oldBytes as number)) return invalid(`diff.files[${index}].netBytes is inconsistent`);
  return { ok: true, value: null };
}

function parseChangeFile(value: unknown, index: number): ValidationResult<ChangeFile> {
  if (!isRecord(value)) return invalid(`diff.files[${index}] must be an object`);
  const pathValue = value.oldPath ?? value.newPath;
  if (!isNonEmptyString(pathValue)) return invalid(`diff.files[${index}] must have a path`);
  if (!isSafeRenderedText(value.status)) return invalid(`diff.files[${index}].status is invalid`);
  if (!(value.oldPath === null || isSafeRenderedText(value.oldPath))) return invalid(`diff.files[${index}].oldPath is invalid`);
  if (!(value.newPath === null || isSafeRenderedText(value.newPath))) return invalid(`diff.files[${index}].newPath is invalid`);
  if (!isIntegerOrNull(value.additions) || !isIntegerOrNull(value.deletions)) return invalid(`diff.files[${index}] line counts are invalid`);
  if ((value.additions === null) !== (value.deletions === null)) return invalid(`diff.files[${index}] line counts must both be null or integers`);
  const bytes = validateChangeFileBytes(value, index);
  if (!bytes.ok) return bytes;
  if (!Array.isArray(value.locations)) return invalid(`diff.files[${index}].locations must be an array`);
  const locations: ChangeLocation[] = [];
  for (const [position, item] of value.locations.entries()) {
    if (!isRecord(item) || (item.side !== 'old' && item.side !== 'new') ||
        !Number.isSafeInteger(item.startLine) || Number(item.startLine) < 1 ||
        !Number.isSafeInteger(item.endLine) || Number(item.endLine) < Number(item.startLine)) return invalid(`diff.files[${index}].locations[${position}] is invalid`);
    locations.push({ side: item.side, startLine: Number(item.startLine), endLine: Number(item.endLine) });
  }
  const addedPositions = locations.filter((item) => item.side === 'new').reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
  const deletedPositions = locations.filter((item) => item.side === 'old').reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
  if (value.additions === null ? locations.length !== 0 : addedPositions !== value.additions || deletedPositions !== value.deletions) return invalid(`diff.files[${index}] changed-line locations do not match numstat`);
  return {
    ok: true,
    value: {
      status: value.status,
      oldPath: value.oldPath as string | null,
      newPath: value.newPath as string | null,
      additions: value.additions as number | null,
      deletions: value.deletions as number | null,
      oldBytes: value.oldBytes as number,
      newBytes: value.newBytes as number,
      netBytes: value.netBytes as number,
      locations
    }
  };
}

function parseTotals(value: unknown): ValidationResult<ChangeTotals> {
  if (!isRecord(value)) return invalid('diff.totals must be an object');
  const nonNegativeFields = ['files', 'textFiles', 'binaryFiles', 'additions', 'deletions', 'oldBytes', 'newBytes'];
  for (const field of [...nonNegativeFields, 'netBytes']) {
    const number = value[field];
    const invalidNumber = typeof number !== 'number' || !Number.isSafeInteger(number) || (nonNegativeFields.includes(field) && number < 0);
    if (invalidNumber) return invalid(`diff.totals.${field} is invalid`);
  }
  const fields = [...nonNegativeFields, 'netBytes'];
  return {
    ok: true,
    value: Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as ChangeTotals
  };
}

function totalsMatchFiles(totals: ChangeTotals, files: ChangeFile[]): boolean {
  const expected = files.reduce((result, file) => {
    result.files += 1;
    result.oldBytes += file.oldBytes;
    result.newBytes += file.newBytes;
    result.netBytes += file.netBytes;
    if (file.additions === null) result.binaryFiles += 1;
    else {
      result.textFiles += 1;
      result.additions += file.additions;
      result.deletions += file.deletions!;
    }
    return result;
  }, { files: 0, textFiles: 0, binaryFiles: 0, additions: 0, deletions: 0, oldBytes: 0, newBytes: 0, netBytes: 0 });
  return JSON.stringify(totals) === JSON.stringify(expected);
}

function parseEvidence(value: unknown, checkId: string, index: number): ValidationResult<Evidence> {
  if (!isRecord(value)) return invalid(`precheck.checks.${checkId}.evidence[${index}] must be an object`);
  if (!isSafeRenderedText(value.path) || !isSafeRenderedText(value.detail)) return invalid(`precheck.checks.${checkId}.evidence[${index}] path/detail is required`);
  const startLine = value.startLine;
  const endLine = value.endLine;
  if (!(startLine === null || (typeof startLine === 'number' && Number.isSafeInteger(startLine) && startLine > 0))) return invalid(`precheck.checks.${checkId}.evidence[${index}].startLine is invalid`);
  if (!(endLine === null || (typeof endLine === 'number' && Number.isSafeInteger(endLine) && endLine > 0))) return invalid(`precheck.checks.${checkId}.evidence[${index}].endLine is invalid`);
  if (startLine !== null && endLine !== null && endLine < startLine) return invalid(`precheck.checks.${checkId}.evidence[${index}] line range is invalid`);
  return { ok: true, value: { path: value.path, startLine, endLine, detail: value.detail } };
}

function parseFunctionalGroupFiles(value: unknown, prefix: string): ValidationResult<string[]> {
  if (!Array.isArray(value) || value.length === 0) return invalid(`${prefix} must be a non-empty array`);
  const files: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const file = value[index];
    if (!isSafeRenderedText(file)) return invalid(`${prefix}[${index}] must be a non-empty string`);
    files.push(file.trim());
  }
  return { ok: true, value: files };
}

function parseFunctionalGroupTests(value: unknown, prefix: string): ValidationResult<FunctionalGroup['tests']> {
  if (!isRecord(value)) return invalid(`${prefix} must be an object`);
  if (!isSafeRenderedText(value.coverage)) return invalid(`${prefix}.coverage is required`);
  if (!isSafeRenderedText(value.cost)) return invalid(`${prefix}.cost is required`);
  return { ok: true, value: { coverage: value.coverage.trim(), cost: value.cost.trim() } };
}

function parseFunctionalGroup(value: unknown, prefix: string, ids: Set<string>): ValidationResult<FunctionalGroup> {
  if (!isRecord(value)) return invalid(`${prefix} must be an object`);
  if (Object.hasOwn(value, 'additions') || Object.hasOwn(value, 'deletions') || Object.hasOwn(value, 'net') || Object.hasOwn(value, 'counts')) {
    return invalid(`${prefix} line counts are derived from diff files and must not be supplied`);
  }
  if (!isSafeRenderedText(value.id) || ids.has(value.id.trim())) return invalid(`${prefix}.id must be non-empty and unique`);
  if (!isSafeRenderedText(value.target)) return invalid(`${prefix}.target is required`);
  if (!isSafeRenderedText(value.behaviorChange)) return invalid(`${prefix}.behaviorChange is required`);
  if (!isSafeRenderedText(value.necessity)) return invalid(`${prefix}.necessity is required`);
  const files = parseFunctionalGroupFiles(value.files, `${prefix}.files`);
  if (!files.ok) return files;
  const parseRanges = (input: unknown, at: string): ValidationResult<Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number }>> => {
    if (!Array.isArray(input)) return invalid(`${at} must be an array`);
    const ranges = [];
    for (const [index, item] of input.entries()) {
      if (!isRecord(item) || !isSafeRenderedText(item.path) || (item.side !== 'old' && item.side !== 'new') ||
          !Number.isSafeInteger(item.startLine) || Number(item.startLine) < 1 || !Number.isSafeInteger(item.endLine) || Number(item.endLine) < Number(item.startLine)) return invalid(`${at}[${index}] is invalid`);
      ranges.push({ path: item.path.trim(), side: item.side as 'old' | 'new', startLine: Number(item.startLine), endLine: Number(item.endLine) });
    }
    return { ok: true, value: ranges };
  };
  if (!isRecord(value.locations)) return invalid(`${prefix}.locations must provide full and increment allocations`);
  const full = parseRanges(value.locations.full, `${prefix}.locations.full`);
  const increment = parseRanges(value.locations.increment, `${prefix}.locations.increment`);
  if (!full.ok) return full;
  if (!increment.ok) return increment;
  const tests = parseFunctionalGroupTests(value.tests, `${prefix}.tests`);
  if (!tests.ok) return tests;
  const id = value.id.trim();
  ids.add(id);
  return {
    ok: true,
    value: {
      id, target: value.target.trim(), behaviorChange: value.behaviorChange.trim(),
      necessity: value.necessity.trim(), files: files.value, locations: { full: full.value, increment: increment.value }, tests: tests.value
    }
  };
}

function parseFunctionalGroups(value: unknown, prefix: string): ValidationResult<FunctionalGroup[]> {
  if (!Array.isArray(value) || value.length === 0) return invalid(`${prefix} must be a non-empty array`);
  const groups: FunctionalGroup[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const group = parseFunctionalGroup(value[index], `${prefix}[${index}]`, ids);
    if (!group.ok) return group;
    groups.push(group.value);
  }
  return { ok: true, value: groups };
}

function indexDiffFiles(files: ChangeFile[]): ValidationResult<Map<string, ChangeFile>> {
  const fileByPath = new Map<string, ChangeFile>();
  for (const file of files) {
    const key = file.oldPath ?? file.newPath;
    if (!key || fileByPath.has(key)) return invalid(`diff file path '${key ?? ''}' is missing or duplicated`);
    fileByPath.set(key, file);
  }
  return { ok: true, value: fileByPath };
}

function collectGroupMembership(
  groups: FunctionalGroup[], fileByPath: Map<string, ChangeFile>
): ValidationResult<Set<string>> {
  const assigned = new Set<string>();
  for (const group of groups) {
    for (const member of group.files) {
      const file = fileByPath.get(member);
      if (!file) return invalid(`change-composition group '${group.id}' references unknown diff file '${member}'`);
      assigned.add(member);
    }
  }
  return { ok: true, value: assigned };
}

type AssignedRange = { path: string; side: 'old' | 'new'; startLine: number; endLine: number };

function validateAllocation(ranges: AssignedRange[], unassigned: AssignedRange[], files: ChangeFile[], scope: string): ValidationResult<null> {
  const expected = new Map<string, Array<[number, number]>>();
  for (const file of files) {
    const filePath = file.oldPath ?? file.newPath!;
    for (const location of file.locations) {
      const key = `${filePath}\0${location.side}`;
      expected.set(key, [...(expected.get(key) ?? []), [location.startLine, location.endLine]]);
    }
  }
  const actual = new Map<string, Array<[number, number]>>();
  for (const range of [...ranges, ...unassigned]) {
    const key = `${range.path}\0${range.side}`;
    if (!expected.has(key)) return invalid(`${scope} allocation references wrong path or direction '${range.path}' (${range.side})`);
    actual.set(key, [...(actual.get(key) ?? []), [range.startLine, range.endLine]]);
  }
  const normalize = (intervals: Array<[number, number]>) => {
    const merged: Array<[number, number]> = [];
    for (const [start, end] of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) return null;
      if (previous && start === previous[1] + 1) previous[1] = end;
      else merged.push([start, end]);
    }
    return merged;
  };
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of keys) {
    const wanted = normalize(expected.get(key) ?? []);
    const supplied = normalize(actual.get(key) ?? []);
    if (!wanted || !supplied) return invalid(`${scope} allocation overlaps or duplicates changed lines at '${key.replace('\0', ':')}'`);
    if (JSON.stringify(wanted) !== JSON.stringify(supplied)) return invalid(`${scope} allocations do not exactly cover changed lines at '${key.replace('\0', ':')}'`);
  }
  return { ok: true, value: null };
}

function validateGroupMembership(checks: Precheck[], full: ChangeFile[], increment: ChangeFile[]): ValidationResult<Precheck[]> {
  const composition = checks.find((check) => check.id === 'change-composition');
  if (!composition?.groups) return invalid('precheck.checks.change-composition.groups is required');
  const allFiles = [...full, ...increment.filter((file) => !full.some((item) => (item.oldPath ?? item.newPath) === (file.oldPath ?? file.newPath)))];
  const indexed = indexDiffFiles(allFiles);
  if (!indexed.ok) return indexed;
  const assigned = collectGroupMembership(composition.groups, indexed.value);
  if (!assigned.ok) return assigned;
  const missingFile = [...indexed.value.keys()].find((file) => !assigned.value.has(file));
  if (missingFile) return invalid(`diff file '${missingFile}' is absent from change-composition groups`);
  const knownPaths = new Set([...full, ...increment].map((file) => file.oldPath ?? file.newPath!));
  for (const group of composition.groups) if (group.files.some((file) => !knownPaths.has(file))) return invalid(`change-composition group '${group.id}' references a file outside either diff`);
  const unassigned = composition.unassigned;
  if (!unassigned) return invalid('change-composition unassigned full/increment ranges are required');
  const fullRanges = composition.groups.flatMap((group) => group.locations.full);
  const incrementRanges = composition.groups.flatMap((group) => group.locations.increment);
  const fullCheck = validateAllocation(fullRanges, unassigned.full, full, 'full');
  if (!fullCheck.ok) return fullCheck;
  const incrementCheck = validateAllocation(incrementRanges, unassigned.increment, increment, 'increment');
  if (!incrementCheck.ok) return incrementCheck;
  return { ok: true, value: checks };
}

function parseEvidenceList(value: unknown, checkId: PrecheckId, prefix: string): ValidationResult<Evidence[]> {
  if (!Array.isArray(value) || value.length === 0) return invalid(`${prefix}.${checkId}.evidence must not be empty`);
  const evidence: Evidence[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseEvidence(value[index], checkId, index);
    if (!parsed.ok) return parsed;
    evidence.push(parsed.value);
  }
  return { ok: true, value: evidence };
}

function parseCheck(value: unknown, index: number, prefix: string): ValidationResult<Precheck> {
  const expectedId = PRECHECK_IDS[index]!;
  const entryPrefix = `${prefix}[${index}]`;
  const at = `${prefix}.${expectedId}`;
  if (!isRecord(value)) return invalid(`${entryPrefix} must be an object`);
  if (value.id !== expectedId) return invalid(`${entryPrefix}.id must be '${expectedId}'`);
  if (value.verdict !== 'pass' && value.verdict !== 'needs-review') return invalid(`${at}.verdict is invalid`);
  const evidence = parseEvidenceList(value.evidence, expectedId, prefix);
  if (!evidence.ok) return evidence;
  if (!isSafeRenderedText(value.rationale)) return invalid(`${at}.rationale is required`);
  if (expectedId !== 'change-composition') {
    if (Object.hasOwn(value, 'groups')) return invalid(`${at}.groups is not allowed`);
    return { ok: true, value: { id: expectedId, verdict: value.verdict, evidence: evidence.value, rationale: value.rationale } };
  }
  const groups = parseFunctionalGroups(value.groups, `${at}.groups`);
  if (!groups.ok) return groups;
  const rawUnassigned = value.unassigned;
  if (!isRecord(rawUnassigned)) return invalid(`${at}.unassigned must provide full and increment ranges`);
  const parseUnassigned = (input: unknown, prefix: string): ValidationResult<Array<AssignedRange & { reason: 'shared' | 'unconfirmed'; explanation: string }>> => {
    if (!Array.isArray(input)) return invalid(`${prefix} must be an array`);
    const result = [];
    for (const [index, item] of input.entries()) {
      if (!isRecord(item) || !isSafeRenderedText(item.path) || (item.side !== 'old' && item.side !== 'new') ||
          !Number.isSafeInteger(item.startLine) || Number(item.startLine) < 1 || !Number.isSafeInteger(item.endLine) || Number(item.endLine) < Number(item.startLine) ||
          (item.reason !== 'shared' && item.reason !== 'unconfirmed') || !isSafeRenderedText(item.explanation)) return invalid(`${prefix}[${index}] is invalid`);
      result.push({ path: item.path.trim(), side: item.side as 'old' | 'new', startLine: Number(item.startLine), endLine: Number(item.endLine), reason: item.reason as 'shared' | 'unconfirmed', explanation: item.explanation.trim() });
    }
    return { ok: true, value: result };
  };
  const unassignedFull = parseUnassigned(rawUnassigned.full, `${at}.unassigned.full`);
  const unassignedIncrement = parseUnassigned(rawUnassigned.increment, `${at}.unassigned.increment`);
  if (!unassignedFull.ok) return unassignedFull;
  if (!unassignedIncrement.ok) return unassignedIncrement;
  return { ok: true, value: { id: expectedId, verdict: value.verdict, evidence: evidence.value, rationale: value.rationale, groups: groups.value, unassigned: { full: unassignedFull.value, increment: unassignedIncrement.value } } };
}

function parseChecks(value: unknown, prefix = 'precheck.checks', diff?: { full: ChangeFile[]; increment: ChangeFile[] }): ValidationResult<Precheck[]> {
  if (!Array.isArray(value) || value.length !== PRECHECK_IDS.length) return invalid(`${prefix} must contain exactly six checks`);
  const checks: Precheck[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseCheck(value[index], index, prefix);
    if (!parsed.ok) return parsed;
    checks.push(parsed.value);
  }
  if (diff) return validateGroupMembership(checks, diff.full, diff.increment);
  return { ok: true, value: checks };
}

function validateScopedMechanical(value: unknown): ValidationResult<ScopedDiff & { version?: 2; base?: string; head?: string }> {
  if (!isRecord(value)) return invalid('mechanical report must be an object', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  if ((value.version !== undefined && value.version !== 2) || (value.kind !== 'merge-base' && value.kind !== 'head-to-head') || (value.base !== undefined && !isSha(value.base)) || (value.head !== undefined && !isSha(value.head)) || !isSha(value.from) || !isSha(value.head ?? value.to) || !(value.mergeBase === null || isSha(value.mergeBase)) || !isSha(value.patchSha256)) {
    return invalid('mechanical report version, commit SHA, or patch SHA is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  }
  if ((value.kind === 'merge-base' && (!isSha(value.mergeBase) || value.from !== value.mergeBase)) || (value.kind === 'head-to-head' && (value.mergeBase !== null || value.from === value.head))) return invalid('mechanical report comparison endpoints are invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  if (!Array.isArray(value.files)) return invalid('mechanical report files must be an array', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  const files: ChangeFile[] = [];
  for (let index = 0; index < value.files.length; index += 1) {
    const parsed = parseChangeFile(value.files[index], index);
    if (!parsed.ok) return { ...parsed, error: { ...parsed.error, code: 'PR_CHANGE_REPORT_MECHANICAL_INVALID' } };
    files.push(parsed.value);
  }
  const totals = parseTotals(value.totals);
  if (!totals.ok) return { ...totals, error: { ...totals.error, code: 'PR_CHANGE_REPORT_MECHANICAL_INVALID' } };
  if (!totalsMatchFiles(totals.value, files)) return invalid('mechanical report totals do not match files', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  return {
    ok: true,
    value: {
      ...(value.version === undefined ? {} : { version: 2 as const }),
      kind: value.kind,
      from: value.from,
      to: value.head ?? value.to,
      mergeBase: value.mergeBase,
      patchSha256: value.patchSha256,
      files,
      totals: totals.value,
      ...(value.base === undefined ? {} : { base: value.base }),
      ...(value.head === undefined ? {} : { head: value.head })
    } as ScopedDiff & { version?: 2; base?: string; head?: string }
  };
}

function validateMechanicalReport(value: unknown): ValidationResult<MechanicalChangeReport> {
  if (!isRecord(value) || value.version !== 2 || !isSha(value.base) || !isSha(value.head)) return invalid('mechanical bundle version or PR identity is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  const full = validateScopedMechanical(value.full);
  if (!full.ok) return full;
  if (full.value.kind !== 'merge-base' || full.value.to !== value.head || (full.value.base !== undefined && full.value.base !== value.base) || (full.value.head !== undefined && full.value.head !== value.head)) return invalid('mechanical full diff identity is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  const rawIncrement = value.increment;
  if (!isRecord(rawIncrement) || !['available', 'unchanged', 'unconfirmed'].includes(String(rawIncrement.status)) || !(rawIncrement.fromHead === null || isSha(rawIncrement.fromHead)) || rawIncrement.toHead !== value.head || !(rawIncrement.sourceReportSha256 === null || isSha(rawIncrement.sourceReportSha256))) return invalid('mechanical increment identity is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  let incrementDiff: ScopedDiff | null = null;
  if (rawIncrement.status === 'available') {
    const parsed = validateScopedMechanical(rawIncrement.diff);
    if (!parsed.ok) return parsed;
    if (parsed.value.kind !== 'head-to-head' || parsed.value.from !== rawIncrement.fromHead || parsed.value.to !== value.head || (parsed.value.head !== undefined && parsed.value.head !== value.head) || !isSha(rawIncrement.sourceReportSha256)) return invalid('mechanical increment endpoints are invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
    incrementDiff = parsed.value;
  } else if (rawIncrement.diff !== null || (rawIncrement.status === 'unchanged' && (rawIncrement.fromHead !== value.head || rawIncrement.sourceReportSha256 !== null)) || (rawIncrement.status === 'unconfirmed' && (rawIncrement.fromHead !== null || rawIncrement.sourceReportSha256 !== null))) return invalid('mechanical increment status is inconsistent', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  const { version: _fullVersion, base: _fullBase, head: _fullHead, ...fullDiff } = full.value;
  const normalizedIncrement = incrementDiff ? (({ version: _incVersion, base: _incBase, head: _incHead, ...rest }) => rest)(incrementDiff as ScopedDiff & { version: 2; base: string; head: string }) : null;
  return { ok: true, value: { version: 2, base: value.base, head: value.head, full: fullDiff, increment: { status: rawIncrement.status as IncrementDiff['status'], fromHead: rawIncrement.fromHead as string | null, toHead: value.head, sourceReportSha256: rawIncrement.sourceReportSha256 as string | null, diff: normalizedIncrement } } };
}

function validatePrecheckCandidate(value: unknown): ValidationResult<PrecheckCandidate> {
  if (!isRecord(value)) return invalid('precheck candidate must be an object', 'PR_CHANGE_REPORT_PRECHECK_INVALID');
  const inputs = isRecord(value.inputs) ? value.inputs : null;
  const taskIntentSha256 = inputs?.taskIntentSha256 ?? value.taskIntentSha256;
  if (!isSha(taskIntentSha256)) return invalid('precheck candidate taskIntentSha256 is invalid', 'PR_CHANGE_REPORT_PRECHECK_INVALID');
  const parsed = parseChecks(isRecord(value.precheck) ? value.precheck.checks : value.checks, 'checks');
  if (!parsed.ok) return { ...parsed, error: { ...parsed.error, code: 'PR_CHANGE_REPORT_PRECHECK_INVALID' } };
  return { ok: true, value: { taskIntentSha256, checks: parsed.value } };
}

function parseScopedDiff(diff: unknown, expectedKind: 'merge-base' | 'head-to-head'): ValidationResult<ScopedDiff> {
  if (!isRecord(diff) || diff.kind !== expectedKind || !isSha(diff.from) || !isSha(diff.to) || !(diff.mergeBase === null || isSha(diff.mergeBase)) || !isSha(diff.patchSha256) || !Array.isArray(diff.files)) return invalid(`change report ${expectedKind} diff is invalid`);
  if ((expectedKind === 'merge-base' && diff.mergeBase !== diff.from) || (expectedKind === 'head-to-head' && diff.mergeBase !== null)) return invalid(`change report ${expectedKind} endpoints are invalid`);
  const files: ChangeFile[] = [];
  for (let index = 0; index < diff.files.length; index += 1) {
    const parsed = parseChangeFile(diff.files[index], index);
    if (!parsed.ok) return parsed;
    files.push(parsed.value);
  }
  const totals = parseTotals(diff.totals);
  if (!totals.ok) return totals;
  if (!totalsMatchFiles(totals.value, files)) return invalid('change report totals do not match files');
  return { ok: true, value: { kind: expectedKind, from: diff.from, to: diff.to, mergeBase: diff.mergeBase as string | null, patchSha256: diff.patchSha256, files, totals: totals.value } };
}

function parseReportPrecheck(report: Record<string, unknown>, diff: { full: ChangeFile[]; increment: ChangeFile[] }): ValidationResult<Precheck[]> {
  if ((report.precheck as Record<string, unknown>).formalReview !== false ||
      ((report.precheck as Record<string, unknown>).verdict !== 'clear' && (report.precheck as Record<string, unknown>).verdict !== 'needs-review') ||
      ((report.precheck as Record<string, unknown>).route !== 'watch-pr' && (report.precheck as Record<string, unknown>).route !== 'review-code')) return invalid('change report precheck envelope is invalid');
  const checks = parseChecks((report.precheck as Record<string, unknown>).checks, 'precheck.checks', diff);
  if (!checks.ok) return checks;
  const derivedVerdict: PrecheckVerdict = checks.value.every((check) => check.verdict === 'pass') ? 'clear' : 'needs-review';
  const derivedRoute: PrecheckRoute = derivedVerdict === 'clear' ? 'watch-pr' : 'review-code';
  if ((report.precheck as Record<string, unknown>).verdict !== derivedVerdict || (report.precheck as Record<string, unknown>).route !== derivedRoute) return invalid('change report precheck verdict/route is not derived from checks');
  return checks;
}

function validatePrChangeReport(value: unknown): ValidationResult<PrChangeReport> {
  if (!isRecord(value)) return invalid('change report must be an object');
  if (value.version !== REPORT_VERSION || !isRecord(value.identity) || !isRecord(value.inputs) || !isRecord(value.diff) || !isRecord(value.precheck)) {
    return invalid('change report has an invalid top-level shape');
  }
  const identity = value.identity;
  const identityRepository = identity.repository;
  const identityResource = identity.resource;
  if (!isNonEmptyString(identityRepository) || !isResourceIdentity(identityResource)) return invalid('change report identity is invalid');
  const parseIdentityPart = (part: unknown, name: string): ValidationResult<{ repository: string; ref: string; sha: string }> => {
    if (!isRecord(part) || !isNonEmptyString(part.repository) || !isNonEmptyString(part.ref) || !isSha(part.sha)) return invalid(`change report identity.${name} is invalid`);
    return { ok: true, value: { repository: part.repository, ref: part.ref, sha: part.sha } };
  };
  const base = parseIdentityPart(identity.base, 'base');
  const head = parseIdentityPart(identity.head, 'head');
  if (!base.ok) return base;
  if (!head.ok) return head;
  const inputTaskIntentSha256 = value.inputs.taskIntentSha256;
  if (!isSha(inputTaskIntentSha256)) return invalid('change report taskIntentSha256 is invalid');
  const diff = value.diff;
  const full = parseScopedDiff(diff.full, 'merge-base');
  if (!full.ok) return full;
  if (!isRecord(diff.increment) || !['available', 'unchanged', 'unconfirmed'].includes(String(diff.increment.status)) || !isSha(diff.increment.toHead) || !(diff.increment.fromHead === null || isSha(diff.increment.fromHead)) || !(diff.increment.sourceReportSha256 === null || isSha(diff.increment.sourceReportSha256))) return invalid('change report increment identity is invalid');
  let incrementDiff: ScopedDiff | null = null;
  if (diff.increment.status === 'available') {
    const parsedIncrement = parseScopedDiff(diff.increment.diff, 'head-to-head');
    if (!parsedIncrement.ok) return parsedIncrement;
    if (!isSha(diff.increment.fromHead) || parsedIncrement.value.from !== diff.increment.fromHead || parsedIncrement.value.to !== diff.increment.toHead || !isSha(diff.increment.sourceReportSha256)) return invalid('change report increment source identity is invalid');
    incrementDiff = parsedIncrement.value;
  } else if (diff.increment.diff !== null || (diff.increment.status === 'unchanged' && (diff.increment.fromHead !== diff.increment.toHead || diff.increment.sourceReportSha256 !== null)) || (diff.increment.status === 'unconfirmed' && (diff.increment.fromHead !== null || diff.increment.sourceReportSha256 !== null))) return invalid('change report increment status is inconsistent');
  if (full.value.from !== base.value.sha && !isSha(full.value.mergeBase)) return invalid('change report full diff lacks merge-base identity');
  if (full.value.to !== head.value.sha || diff.increment.toHead !== head.value.sha) return invalid('change report diff endpoints do not match pull request identity');
  const checks = parseReportPrecheck(value as Record<string, unknown>, { full: full.value.files, increment: incrementDiff?.files ?? [] });
  if (!checks.ok) return checks;
  return {
    ok: true,
    value: {
      version: REPORT_VERSION,
      identity: {
        repository: identityRepository,
        resource: identityResource,
        base: base.value,
        head: head.value
      },
      inputs: { taskIntentSha256: inputTaskIntentSha256 },
      diff: { full: full.value, increment: { status: diff.increment.status as IncrementDiff['status'], fromHead: diff.increment.fromHead as string | null, toHead: diff.increment.toHead as string, sourceReportSha256: diff.increment.sourceReportSha256 as string | null, diff: incrementDiff } },
      precheck: { verdict: value.precheck.verdict as PrecheckVerdict, formalReview: false, route: value.precheck.route as PrecheckRoute, checks: checks.value }
    }
  };
}

function taskIntentProjection(taskContent: string): ValidationResult<string> {
  const normalized = taskContent.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => /^#\s+(?:任务(?::|：)?|Task\s*:?)\s*.*$/i.test(line.trim()));
  const end = lines.findIndex((line, index) => index > start && /^##\s+(?:上下文|Context)\s*$/i.test(line.trim()));
  if (start < 0 || end < 0 || end <= start) return invalid('task semantic section must have # 任务/# Task and ## 上下文/## Context boundaries', 'TASK_SEMANTIC_INPUT_INVALID');
  return { ok: true, value: lines.slice(start, end).map((line) => line.replace(/[ \t]+$/g, '')).join('\n').trim() };
}

function taskIntentDigest(taskContent: string): ValidationResult<{ sha256: string; projection: string }> {
  const projection = taskIntentProjection(taskContent);
  if (!projection.ok) return projection;
  const value = `task-intent-v1\n${projection.value}\n`;
  return { ok: true, value: { sha256: createHash('sha256').update(value, 'utf8').digest('hex'), projection: projection.value } };
}

function derivePrecheck(checks: Precheck[]): Pick<PrChangeReport['precheck'], 'verdict' | 'route' | 'formalReview'> {
  const clear = checks.every((check) => check.verdict === 'pass');
  return { verdict: clear ? 'clear' : 'needs-review', route: clear ? 'watch-pr' : 'review-code', formalReview: false };
}

function buildPrChangeReport(
  identity: PullRequestIdentity,
  taskIntentSha256: string,
  mechanical: MechanicalChangeReport,
  candidate: PrecheckCandidate
): ValidationResult<PrChangeReport> {
  if (!isSha(taskIntentSha256) || candidate.taskIntentSha256 !== taskIntentSha256) return invalid('task intent digest does not match the precheck candidate', 'PR_CHANGE_REPORT_TASK_INTENT_MISMATCH');
  if (mechanical.base !== identity.base.sha || mechanical.head !== identity.head.sha) return invalid('mechanical report does not match the pull request base/head', 'PR_CHANGE_REPORT_IDENTITY_MISMATCH');
  const precheck = { ...derivePrecheck(candidate.checks), checks: candidate.checks };
  return validatePrChangeReport({
    version: REPORT_VERSION,
    identity,
    inputs: { taskIntentSha256 },
    diff: { full: mechanical.full, increment: mechanical.increment },
    precheck
  });
}

function readPrChangeReport(file: string): ValidationResult<PrChangeReport> {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return invalid('change report must be a regular file', 'PR_CHANGE_REPORT_INVALID');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validatePrChangeReport(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return invalid('change report is missing', 'PR_CHANGE_REPORT_MISSING');
    if (error instanceof SyntaxError) return invalid('change report is not valid JSON', 'PR_CHANGE_REPORT_INVALID');
    return invalid(error instanceof Error ? error.message : String(error), 'PR_CHANGE_REPORT_INVALID');
  }
}

function writePrChangeReportAtomic(file: string, report: PrChangeReport): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    try {
      const directoryDescriptor = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch {
      // Directory fsync is not available on every supported platform.
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function runMechanicalChangeReport(repoRoot: string, baseSha: string, headSha: string, previous?: { headSha: string; reportSha256: string | null }): MechanicalChangeReport {
  const script = path.join(repoRoot, '.agents', 'skills', 'create-pr', 'scripts', 'change-report.mjs');
  const invoke = (kind: 'merge-base' | 'head-to-head', fromHead?: string): ScopedDiff & { version?: 2; base?: string; head?: string } => {
    const args = [script, '--base', baseSha, '--head', headSha, '--kind', kind, ...(fromHead ? ['--from-head', fromHead] : []), '--cwd', repoRoot];
    const output = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    const parsed: unknown = JSON.parse(output);
    const validated = validateScopedMechanical(parsed);
    if (!validated.ok) throw new Error(`${validated.error.code}: ${validated.error.message}`);
    return validated.value;
  };
  const full = invoke('merge-base');
  let increment: IncrementDiff;
  if (!previous || !isSha(previous.headSha)) increment = { status: 'unconfirmed', fromHead: null, toHead: headSha, sourceReportSha256: null, diff: null };
  else if (previous.headSha === headSha) increment = { status: 'unchanged', fromHead: headSha, toHead: headSha, sourceReportSha256: null, diff: null };
  else if (!isSha(previous.reportSha256)) increment = { status: 'unconfirmed', fromHead: null, toHead: headSha, sourceReportSha256: null, diff: null };
  else increment = { status: 'available', fromHead: previous.headSha, toHead: headSha, sourceReportSha256: previous.reportSha256, diff: invoke('head-to-head', previous.headSha) };
  const bundle = validateMechanicalReport({ version: 2, base: baseSha, head: headSha, full, increment });
  if (!bundle.ok) throw new Error(`${bundle.error.code}: ${bundle.error.message}`);
  return bundle.value;
}

const DOCUMENTATION_CATEGORY = { label: '文档', prefixes: ['docs/'] } as const;

const CHANGE_CATEGORIES = [
  { label: '运行时代码', prefixes: ['bin/', 'lib/', 'src/', 'scripts/'] },
  { label: '测试与校验', prefixes: ['test/', 'tests/'] },
  { label: '模板与生成内容', prefixes: ['templates/'] },
  { label: '技能与协作配置', prefixes: ['.agents/'] },
  DOCUMENTATION_CATEGORY,
  { label: '其他', prefixes: [] }
] as const;

function emptyChangeTotals(): ChangeTotals {
  return { files: 0, textFiles: 0, binaryFiles: 0, additions: 0, deletions: 0, oldBytes: 0, newBytes: 0, netBytes: 0 };
}

function categoryForChangeFile(file: ChangeFile): (typeof CHANGE_CATEGORIES)[number] {
  const filePath = file.newPath || file.oldPath || '';
  const category = CHANGE_CATEGORIES.find((entry) => entry.prefixes.some((prefix) => prefix && filePath.startsWith(prefix)));
  if (category) return category;
  if (/\.(?:md|mdx|markdown|rst)$/i.test(filePath)) return DOCUMENTATION_CATEGORY;
  return CHANGE_CATEGORIES[CHANGE_CATEGORIES.length - 1]!;
}

function summarizeChangeCategories(files: ChangeFile[]): Array<{ label: string; totals: ChangeTotals }> {
  const summaries = new Map<(typeof CHANGE_CATEGORIES)[number]['label'], ChangeTotals>();
  for (const file of files) {
    const category = categoryForChangeFile(file);
    const totals = summaries.get(category.label) || emptyChangeTotals();
    totals.files += 1;
    totals.oldBytes += file.oldBytes;
    totals.newBytes += file.newBytes;
    totals.netBytes += file.netBytes;
    if (file.additions === null) totals.binaryFiles += 1;
    else {
      totals.textFiles += 1;
      totals.additions += file.additions;
      totals.deletions += file.deletions!;
    }
    summaries.set(category.label, totals);
  }
  const result: Array<{ label: string; totals: ChangeTotals }> = [];
  for (const category of CHANGE_CATEGORIES) {
    const totals = summaries.get(category.label);
    if (totals) result.push({ label: category.label, totals });
  }
  return result;
}

function signedNumber(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

function renderLineCounts(totals: ChangeTotals): [string, string, string] {
  if (totals.textFiles === 0) return ['—', '—', '—'];
  return [String(totals.additions), String(totals.deletions), signedNumber(totals.additions - totals.deletions)];
}

const MAX_REPRESENTATIVE_FILES = 3;

function representativePath(file: ChangeFile): string {
  return file.newPath || file.oldPath || '';
}

function escapeReportText(value: string): string {
  return escapeHtmlText(value).replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

function renderRepresentativePath(file: ChangeFile): string {
  const paths = file.oldPath && file.newPath && file.oldPath !== file.newPath
    ? [file.oldPath, file.newPath]
    : [representativePath(file)];
  return paths.map((filePath) => `<code>${escapeReportText(filePath)}</code>`).join(' → ');
}

function representativeScore(file: ChangeFile, metric: 'lines' | 'bytes'): number {
  return metric === 'lines' ? file.additions! + file.deletions! : Math.abs(file.netBytes);
}

function representativeFiles(files: ChangeFile[], metric: 'lines' | 'bytes'): ChangeFile[] {
  return files
    .filter((file) => file.additions !== null && file.deletions !== null)
    .slice()
    .sort((left, right) => {
      const scoreDifference = representativeScore(right, metric) - representativeScore(left, metric);
      if (scoreDifference !== 0) return scoreDifference;
      const leftPath = representativePath(left);
      const rightPath = representativePath(right);
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    })
    .slice(0, MAX_REPRESENTATIVE_FILES);
}

function renderRepresentativeFile(file: ChangeFile, metric: 'lines' | 'bytes'): string {
  const category = categoryForChangeFile(file).label;
  const pathValue = renderRepresentativePath(file);
  if (metric === 'lines') {
    const additions = file.additions!;
    const deletions = file.deletions!;
    return `  - ${pathValue}（${category}）：新增 ${additions} 行、删除 ${deletions} 行，共变更 ${additions + deletions} 行。`;
  }
  return `  - ${pathValue}（${category}）：净字节 ${signedNumber(file.netBytes)}，绝对变化 ${Math.abs(file.netBytes)}。`;
}

function renderRepresentativeFiles(files: ChangeFile[]): string[] {
  const lineFiles = representativeFiles(files, 'lines');
  const byteFiles = representativeFiles(files, 'bytes');
  return [
    '#### 代表性变更文件',
    '',
    '- 行数变化最大（仅文本文件，按新增行+删除行，最多展示 3 个）：',
    ...(lineFiles.length > 0 ? lineFiles.map((file) => renderRepresentativeFile(file, 'lines')) : ['  - 无可比较的文本文件。']),
    '- 绝对净字节变化最大（仅文本文件，最多展示 3 个）：',
    ...(byteFiles.length > 0 ? byteFiles.map((file) => renderRepresentativeFile(file, 'bytes')) : ['  - 无可比较的文本文件。'])
  ];
}

function renderEvidence(evidence: Evidence): string {
  const location = evidence.startLine === null && evidence.endLine === null
    ? ''
    : evidence.startLine !== null && evidence.endLine !== null
      ? evidence.endLine === evidence.startLine
        ? `:${evidence.startLine}`
        : `:${evidence.startLine}-${evidence.endLine}`
      : `:${evidence.startLine ?? evidence.endLine}`;
  return `  - 证据：<code>${escapeReportText(evidence.path)}</code>${location}：${escapeReportText(evidence.detail)}`;
}

function countLocations(ranges: AssignedRange[]): number {
  return ranges.reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
}

function renderFunctionalGroups(groups: FunctionalGroup[], files: ChangeFile[], incrementFiles: ChangeFile[], incrementStatus: IncrementDiff['status'], unassigned: Precheck['unassigned']): string[] {
  const filesByPath = new Map(files.map((file) => [file.oldPath ?? file.newPath!, file]));
  return groups.flatMap((group) => {
    const incrementByPath = new Map(incrementFiles.map((file) => [file.oldPath ?? file.newPath!, file]));
    const fullAdded = countLocations(group.locations.full.filter((range) => range.side === 'new'));
    const fullDeleted = countLocations(group.locations.full.filter((range) => range.side === 'old'));
    const incAdded = countLocations(group.locations.increment.filter((range) => range.side === 'new'));
    const incDeleted = countLocations(group.locations.increment.filter((range) => range.side === 'old'));
    const unknownFiles = group.files.filter((member) => filesByPath.get(member)?.additions === null || incrementByPath.get(member)?.additions === null).length;
    return [
      `  - **功能组 ${escapeReportText(group.id)}**：${escapeReportText(group.target)}`,
      `    - 行为变化：${escapeReportText(group.behaviorChange)}`,
      `    - 必要性：${escapeReportText(group.necessity)}`,
      `    - 文件：${group.files.map((member) => {
        const file = filesByPath.get(member)!;
        return file.oldPath && file.newPath && file.oldPath !== file.newPath
          ? `<code>${escapeReportText(file.oldPath)}</code> → <code>${escapeReportText(file.newPath)}</code>`
          : `<code>${escapeReportText(member)}</code>`;
      }).join('、')}`,
      `    - 完整 PR：新增 ${fullAdded}、删除 ${fullDeleted}、净增 ${fullAdded - fullDeleted}；本轮增量：${incrementStatus === 'available' ? `新增 ${incAdded}、删除 ${incDeleted}、净增 ${incAdded - incDeleted}` : incrementStatus === 'unchanged' ? 'head 未变化，增量为 0' : '未确认，不报告数字'}${unknownFiles ? `；另有 ${unknownFiles} 个二进制文件行数不可计` : ''}。`,
      `    - 测试覆盖：${escapeReportText(group.tests.coverage)}；成本：${escapeReportText(group.tests.cost)}`
    ];
  }).concat((['full', 'increment'] as const).flatMap((scope) => {
    const items = unassigned?.[scope] ?? [];
    if (items.length === 0) return [];
    const added = countLocations(items.filter((item) => item.side === 'new'));
    const deleted = countLocations(items.filter((item) => item.side === 'old'));
    return [`  - **${scope === 'full' ? '完整 PR ' : '本轮增量'}未归属位置**：新增 ${added}、删除 ${deleted}；${items.map((item) => `${escapeReportText(item.reason)}：${escapeReportText(item.explanation)}`).join('；')}`];
  }));
}

function renderPrechecks(checks: Precheck[], files: ChangeFile[], incrementFiles: ChangeFile[], incrementStatus: IncrementDiff['status']): string[] {
  return checks.flatMap((check) => [
    `- **${PRECHECK_LABELS[check.id]}（${check.id}）**：${check.verdict === 'pass' ? '通过' : '需复核'}。${escapeReportText(check.rationale)}`,
    ...check.evidence.map(renderEvidence),
    ...(check.groups ? renderFunctionalGroups(check.groups, files, incrementFiles, incrementStatus, check.unassigned) : [])
  ]);
}

function renderCanonicalChangeReport(report: PrChangeReport): string {
  const totals = report.diff.full.totals;
  const categories = summarizeChangeCategories(report.diff.full.files);
  const rows = categories.map(({ label, totals: categoryTotals }) => {
    const [additions, deletions, netLines] = renderLineCounts(categoryTotals);
    return `| ${label} | ${categoryTotals.files} | ${additions} | ${deletions} | ${netLines} | ${categoryTotals.oldBytes} | ${categoryTotals.newBytes} | ${signedNumber(categoryTotals.netBytes)} | ${categoryTotals.textFiles} / ${categoryTotals.binaryFiles} |`;
  });
  const [additions, deletions, netLines] = renderLineCounts(totals);
  const passedChecks = report.precheck.checks.filter((check) => check.verdict === 'pass').length;
  const needsReviewChecks = report.precheck.checks.length - passedChecks;
  const precheckSummary = report.precheck.verdict === 'clear'
    ? `**通过**（${passedChecks}/${report.precheck.checks.length} 项通过）`
    : `**需复核**（${passedChecks} 项通过，${needsReviewChecks} 项需复核）`;
  const route = report.precheck.route === 'watch-pr' ? '继续监控 PR' : '转入代码审查';
  return [
    CANONICAL_REPORT_HEADING,
    '',
    '| 变更类别 | 文件数 | 新增行 | 删除行 | 净增行 | 旧字节 | 新字节 | 净字节 | 文本 / 二进制 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    `| **合计** | ${totals.files} | ${additions} | ${deletions} | ${netLines} | ${totals.oldBytes} | ${totals.newBytes} | ${signedNumber(totals.netBytes)} | ${totals.textFiles} / ${totals.binaryFiles} |`,
    '',
    `- 总体统计：新增 ${totals.additions} 行、删除 ${totals.deletions} 行；旧字节 ${totals.oldBytes}，新字节 ${totals.newBytes}。`,
    `- 变更明细按高层类别聚合展示；完整逐文件事实保留在结构化报告中供审计。`,
    `- 完整 PR 补丁摘要：\`${report.diff.full.patchSha256}\`；merge-base：\`${report.diff.full.mergeBase}\`。`,
    `- 本轮增量：${report.diff.increment.status === 'available' ? `head-to-head \`${report.diff.increment.fromHead}\` → \`${report.diff.increment.toHead}\`，补丁摘要 \`${report.diff.increment.diff!.patchSha256}\`，新增 ${report.diff.increment.diff!.totals.additions}、删除 ${report.diff.increment.diff!.totals.deletions}` : report.diff.increment.status === 'unchanged' ? 'head 未变化，增量为 0。' : '未确认：缺少同一 PR 的有效上一份报告，未推算增量。'}`,
    '',
    ...renderRepresentativeFiles(report.diff.full.files),
    '',
    '#### 适宜性预检',
    `- 结论：${precheckSummary}；${route}；正式审查：否。`,
    ...renderPrechecks(report.precheck.checks, report.diff.full.files, report.diff.increment.diff?.files ?? [], report.diff.increment.status)
  ].join('\n');
}

function replaceCanonicalReportPlaceholder(body: string, report: PrChangeReport): ValidationResult<string> {
  const matches = body.split(CANONICAL_REPORT_PLACEHOLDER).length - 1;
  if (matches !== 1 || body.includes('<!-- sync-pr:') || /<!--\s*last-commit:/i.test(body) || body.includes(CANONICAL_REPORT_HEADING) ||
      body.includes(REPORT_FILE_NAME) || /"(?:identity|precheck|diff)"\s*:\s*\{/.test(body)) {
    return invalid('summary body must contain exactly one canonical report placeholder and no report bypass content', 'PR_SUMMARY_BODY_CONTRACT_INVALID');
  }
  const rendered = renderCanonicalChangeReport(report);
  if (containsControlMarker(rendered)) return invalid('canonical report contains a reserved control marker', 'PR_SUMMARY_RENDER_INVALID');
  const value = body.replace(CANONICAL_REPORT_PLACEHOLDER, rendered);
  if (containsControlMarker(value)) return invalid('summary contains a reserved control marker', 'PR_SUMMARY_RENDER_INVALID');
  return { ok: true, value };
}

export {
  CANONICAL_REPORT_HEADING,
  CANONICAL_REPORT_PLACEHOLDER,
  PRECHECK_IDS,
  REPORT_FILE_NAME,
  REPORT_VERSION,
  buildPrChangeReport,
  readPrChangeReport,
  renderCanonicalChangeReport,
  replaceCanonicalReportPlaceholder,
  runMechanicalChangeReport,
  taskIntentDigest,
  taskIntentProjection,
  validateMechanicalReport,
  validatePrecheckCandidate,
  validatePrChangeReport,
  writePrChangeReportAtomic
};
export type {
  ChangeFile,
  ChangeTotals,
  CheckVerdict,
  Evidence,
  MechanicalChangeReport,
  Precheck,
  PrecheckCandidate,
  PrecheckId,
  PrecheckRoute,
  PrecheckVerdict,
  PrChangeReport,
  PullRequestIdentity,
  ValidationFailure,
  ValidationResult
};
