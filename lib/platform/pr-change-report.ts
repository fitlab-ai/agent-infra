import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { escapeHtmlText } from './comment-safety.ts';
import { isResourceIdentity } from './resource-identity.ts';
import type { ResourceIdentity } from './resource-identity.ts';

const REPORT_FILE_NAME = 'pr-change-report.json';
const REPORT_VERSION = 5 as const;
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
  kind: 'merge-base';
  from: string;
  to: string;
  mergeBase: string;
  patchSha256: string;
  files: ChangeFile[];
  totals: ChangeTotals;
};

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
  version: 3;
  base: string;
  head: string;
  full: ScopedDiff;
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
  locations: { full: Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number }> };
  tests: { coverage: string; cost: string };
};

type Precheck = {
  id: PrecheckId;
  verdict: CheckVerdict;
  evidence: Evidence[];
  rationale: string;
  groups?: FunctionalGroup[];
  unassigned?: { full: Array<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number; reason: 'shared' | 'unconfirmed'; explanation: string }> };
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

function withErrorCode<T>(result: ValidationResult<T>, code: string): ValidationResult<T> {
  return result.ok ? result : { ...result, error: { ...result.error, code } };
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

function validateChangeFilePaths(value: Record<string, unknown>, index: number): ValidationResult<{ status: string; oldPath: string | null; newPath: string | null }> {
  const pathValue = value.oldPath ?? value.newPath;
  if (!isNonEmptyString(pathValue)) return invalid(`diff.files[${index}] must have a path`);
  if (!isSafeRenderedText(value.status)) return invalid(`diff.files[${index}].status is invalid`);
  if (!(value.oldPath === null || isSafeRenderedText(value.oldPath))) return invalid(`diff.files[${index}].oldPath is invalid`);
  if (!(value.newPath === null || isSafeRenderedText(value.newPath))) return invalid(`diff.files[${index}].newPath is invalid`);
  return { ok: true, value: { status: value.status, oldPath: value.oldPath as string | null, newPath: value.newPath as string | null } };
}

function validateChangeFileLineCounts(value: Record<string, unknown>, index: number): ValidationResult<{ additions: number | null; deletions: number | null }> {
  if (!isIntegerOrNull(value.additions) || !isIntegerOrNull(value.deletions)) return invalid(`diff.files[${index}] line counts are invalid`);
  if ((value.additions === null) !== (value.deletions === null)) return invalid(`diff.files[${index}] line counts must both be null or integers`);
  return { ok: true, value: { additions: value.additions, deletions: value.deletions } };
}

function parseChangeFileLocations(value: Record<string, unknown>, index: number): ValidationResult<ChangeLocation[]> {
  if (!Array.isArray(value.locations)) return invalid(`diff.files[${index}].locations must be an array`);
  const locations: ChangeLocation[] = [];
  for (const [position, item] of value.locations.entries()) {
    if (!isRecord(item) || (item.side !== 'old' && item.side !== 'new') ||
        !Number.isSafeInteger(item.startLine) || Number(item.startLine) < 1 ||
        !Number.isSafeInteger(item.endLine) || Number(item.endLine) < Number(item.startLine)) return invalid(`diff.files[${index}].locations[${position}] is invalid`);
    locations.push({ side: item.side, startLine: Number(item.startLine), endLine: Number(item.endLine) });
  }
  return { ok: true, value: locations };
}

function validateChangedLineLocations(locations: ChangeLocation[], additions: number | null, deletions: number | null, index: number): ValidationResult<null> {
  const addedPositions = locations.filter((item) => item.side === 'new').reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
  const deletedPositions = locations.filter((item) => item.side === 'old').reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
  if (additions === null ? locations.length !== 0 : addedPositions !== additions || deletedPositions !== deletions) return invalid(`diff.files[${index}] changed-line locations do not match numstat`);
  return { ok: true, value: null };
}

function parseChangeFile(value: unknown, index: number): ValidationResult<ChangeFile> {
  if (!isRecord(value)) return invalid(`diff.files[${index}] must be an object`);
  const paths = validateChangeFilePaths(value, index);
  if (!paths.ok) return paths;
  const lineCounts = validateChangeFileLineCounts(value, index);
  if (!lineCounts.ok) return lineCounts;
  const bytes = validateChangeFileBytes(value, index);
  if (!bytes.ok) return bytes;
  const locations = parseChangeFileLocations(value, index);
  if (!locations.ok) return locations;
  const verifiedLocations = validateChangedLineLocations(locations.value, lineCounts.value.additions, lineCounts.value.deletions, index);
  if (!verifiedLocations.ok) return verifiedLocations;
  return {
    ok: true,
    value: {
      status: paths.value.status,
      oldPath: paths.value.oldPath,
      newPath: paths.value.newPath,
      additions: lineCounts.value.additions,
      deletions: lineCounts.value.deletions,
      oldBytes: value.oldBytes as number,
      newBytes: value.newBytes as number,
      netBytes: value.netBytes as number,
      locations: locations.value
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

function validateFunctionalGroupFields(value: Record<string, unknown>, prefix: string, ids: Set<string>): ValidationResult<null> {
  if (Object.hasOwn(value, 'additions') || Object.hasOwn(value, 'deletions') || Object.hasOwn(value, 'net') || Object.hasOwn(value, 'counts')) {
    return invalid(`${prefix} line counts are derived from diff files and must not be supplied`);
  }
  if (!isSafeRenderedText(value.id) || ids.has(value.id.trim())) return invalid(`${prefix}.id must be non-empty and unique`);
  if (!isSafeRenderedText(value.target)) return invalid(`${prefix}.target is required`);
  if (!isSafeRenderedText(value.behaviorChange)) return invalid(`${prefix}.behaviorChange is required`);
  if (!isSafeRenderedText(value.necessity)) return invalid(`${prefix}.necessity is required`);
  return { ok: true, value: null };
}

function parseAssignedRange(item: unknown, at: string): ValidationResult<AssignedRange> {
  if (!isRecord(item) || !isSafeRenderedText(item.path) || (item.side !== 'old' && item.side !== 'new') ||
      !Number.isSafeInteger(item.startLine) || Number(item.startLine) < 1 || !Number.isSafeInteger(item.endLine) || Number(item.endLine) < Number(item.startLine)) return invalid(`${at} is invalid`);
  return { ok: true, value: { path: item.path.trim(), side: item.side, startLine: Number(item.startLine), endLine: Number(item.endLine) } };
}

function parseFunctionalGroupLocations(value: unknown, prefix: string): ValidationResult<FunctionalGroup['locations']> {
  if (!isRecord(value) || !Array.isArray(value.full)) return invalid(`${prefix}.locations.full must be an array`);
  const full: AssignedRange[] = [];
  for (const [index, item] of value.full.entries()) {
    const range = parseAssignedRange(item, `${prefix}.locations.full[${index}]`);
    if (!range.ok) return range;
    full.push(range.value);
  }
  return { ok: true, value: { full } };
}

function parseFunctionalGroup(value: unknown, prefix: string, ids: Set<string>): ValidationResult<FunctionalGroup> {
  if (!isRecord(value)) return invalid(`${prefix} must be an object`);
  const fields = validateFunctionalGroupFields(value, prefix, ids);
  if (!fields.ok) return fields;
  const files = parseFunctionalGroupFiles(value.files, `${prefix}.files`);
  if (!files.ok) return files;
  const locations = parseFunctionalGroupLocations(value.locations, prefix);
  if (!locations.ok) return locations;
  const tests = parseFunctionalGroupTests(value.tests, `${prefix}.tests`);
  if (!tests.ok) return tests;
  const id = (value.id as string).trim();
  ids.add(id);
  return {
    ok: true,
    value: {
      id, target: (value.target as string).trim(), behaviorChange: (value.behaviorChange as string).trim(),
      necessity: (value.necessity as string).trim(), files: files.value, locations: locations.value, tests: tests.value
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

function findMissingGroupFile(
  indexed: Map<string, ChangeFile>, assigned: Set<string>, composition: Precheck
): string | null {
  const groupAllocatedPaths = new Set(composition.groups!.flatMap((group) => group.locations.full).map((range) => range.path));
  const unassignedPaths = new Set(composition.unassigned!.full.map((range) => range.path));
  const missingFile = [...indexed].find(([filePath, file]) => !assigned.has(filePath)
    && !(file.locations.length > 0 && unassignedPaths.has(filePath) && !groupAllocatedPaths.has(filePath)));
  return missingFile?.[0] ?? null;
}

function validateAllocatedFileMembers(groups: FunctionalGroup[], files: ChangeFile[]): ValidationResult<null> {
  for (const group of groups) {
    const allocatedPaths = new Set(group.locations.full.map((range) => range.path));
    const memberPaths = new Set(group.files);
    for (const filePath of allocatedPaths) {
      if (!memberPaths.has(filePath)) return invalid(`change-composition group '${group.id}' allocates locations outside its files list`);
    }
    for (const filePath of memberPaths) {
      const hasLineLocations = files.some((file) => (file.oldPath ?? file.newPath) === filePath && file.locations.length > 0);
      if (hasLineLocations && !allocatedPaths.has(filePath)) return invalid(`change-composition group '${group.id}' lists a text file without allocated locations`);
    }
  }
  return { ok: true, value: null };
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

function validateGroupMembership(checks: Precheck[], files: ChangeFile[]): ValidationResult<Precheck[]> {
  const composition = checks.find((check) => check.id === 'change-composition');
  if (!composition?.groups) return invalid('precheck.checks.change-composition.groups is required');
  const indexed = indexDiffFiles(files);
  if (!indexed.ok) return indexed;
  const assigned = collectGroupMembership(composition.groups, indexed.value);
  if (!assigned.ok) return assigned;
  const unassigned = composition.unassigned;
  if (!unassigned) return invalid('change-composition unassigned full ranges are required');
  const fullRanges = composition.groups.flatMap((group) => group.locations.full);
  const fullCheck = validateAllocation(fullRanges, unassigned.full, files, 'full');
  if (!fullCheck.ok) return fullCheck;
  const missingFile = findMissingGroupFile(indexed.value, assigned.value, composition);
  if (missingFile) return invalid(`diff file '${missingFile}' is absent from change-composition groups`);
  const members = validateAllocatedFileMembers(composition.groups, files);
  if (!members.ok) return members;
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

function parseUnassignedRanges(value: unknown, prefix: string): ValidationResult<Array<AssignedRange & { reason: 'shared' | 'unconfirmed'; explanation: string }>> {
  if (!Array.isArray(value)) return invalid(`${prefix} must be an array`);
  const ranges: Array<AssignedRange & { reason: 'shared' | 'unconfirmed'; explanation: string }> = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return invalid(`${prefix}[${index}] is invalid`);
    const range = parseAssignedRange(item, `${prefix}[${index}]`);
    if (!range.ok) return range;
    if ((item.reason !== 'shared' && item.reason !== 'unconfirmed') || !isSafeRenderedText(item.explanation)) return invalid(`${prefix}[${index}] is invalid`);
    ranges.push({ ...range.value, reason: item.reason, explanation: item.explanation.trim() });
  }
  return { ok: true, value: ranges };
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
  if (!isRecord(rawUnassigned)) return invalid(`${at}.unassigned.full must be an array`);
  const unassignedFull = parseUnassignedRanges(rawUnassigned.full, `${at}.unassigned.full`);
  if (!unassignedFull.ok) return unassignedFull;
  return { ok: true, value: { id: expectedId, verdict: value.verdict, evidence: evidence.value, rationale: value.rationale, groups: groups.value, unassigned: { full: unassignedFull.value } } };
}

function parseChecks(value: unknown, prefix = 'precheck.checks', diff?: ChangeFile[]): ValidationResult<Precheck[]> {
  if (!Array.isArray(value) || value.length !== PRECHECK_IDS.length) return invalid(`${prefix} must contain exactly six checks`);
  const checks: Precheck[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseCheck(value[index], index, prefix);
    if (!parsed.ok) return parsed;
    checks.push(parsed.value);
  }
  if (diff) return validateGroupMembership(checks, diff);
  return { ok: true, value: checks };
}

function parseScopedDiffContents(value: Record<string, unknown>, errorCode: string): ValidationResult<ScopedDiff> {
  if (value.kind !== 'merge-base' || !isSha(value.from) || !isSha(value.to) || value.mergeBase !== value.from || !isSha(value.patchSha256)) {
    return invalid('complete PR diff identity is invalid', errorCode);
  }
  if (!Array.isArray(value.files)) return invalid('complete PR diff files must be an array', errorCode);
  const files: ChangeFile[] = [];
  for (let index = 0; index < value.files.length; index += 1) {
    const parsed = withErrorCode(parseChangeFile(value.files[index], index), errorCode);
    if (!parsed.ok) return parsed;
    files.push(parsed.value);
  }
  const totals = withErrorCode(parseTotals(value.totals), errorCode);
  if (!totals.ok) return totals;
  if (!totalsMatchFiles(totals.value, files)) return invalid('complete PR diff totals do not match files', errorCode);
  return { ok: true, value: { kind: 'merge-base', from: value.from, to: value.to, mergeBase: value.mergeBase, patchSha256: value.patchSha256, files, totals: totals.value } };
}

function validateScopedMechanical(value: unknown): ValidationResult<ScopedDiff> {
  if (!isRecord(value)) return invalid('mechanical report must be an object', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  return parseScopedDiffContents(value, 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
}

function validateMechanicalFull(value: unknown, base: string, head: string): ValidationResult<ScopedDiff> {
  const full = validateScopedMechanical(value);
  if (!full.ok) return full;
  if (!isSha(base) || full.value.to !== head || full.value.mergeBase !== full.value.from) return invalid('mechanical complete PR diff identity is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  return full;
}

function validateMechanicalReport(value: unknown): ValidationResult<MechanicalChangeReport> {
  if (!isRecord(value) || value.version !== 3 || !isSha(value.base) || !isSha(value.head)) return invalid('mechanical bundle version or PR identity is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  const full = validateMechanicalFull(value.full, value.base, value.head);
  if (!full.ok) return full;
  return { ok: true, value: { version: 3, base: value.base, head: value.head, full: full.value } };
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

function parseScopedDiff(diff: unknown): ValidationResult<ScopedDiff> {
  if (!isRecord(diff)) return invalid('change report complete PR diff is invalid');
  return parseScopedDiffContents(diff, 'PR_CHANGE_REPORT_INVALID');
}

function parseReportPrecheck(report: Record<string, unknown>, full: ChangeFile[]): ValidationResult<Precheck[]> {
  if ((report.precheck as Record<string, unknown>).formalReview !== false ||
      ((report.precheck as Record<string, unknown>).verdict !== 'clear' && (report.precheck as Record<string, unknown>).verdict !== 'needs-review') ||
      ((report.precheck as Record<string, unknown>).route !== 'watch-pr' && (report.precheck as Record<string, unknown>).route !== 'review-code')) return invalid('change report precheck envelope is invalid');
  const checks = parseChecks((report.precheck as Record<string, unknown>).checks, 'precheck.checks', full);
  if (!checks.ok) return checks;
  const derivedVerdict: PrecheckVerdict = checks.value.every((check) => check.verdict === 'pass') ? 'clear' : 'needs-review';
  const derivedRoute: PrecheckRoute = derivedVerdict === 'clear' ? 'watch-pr' : 'review-code';
  if ((report.precheck as Record<string, unknown>).verdict !== derivedVerdict || (report.precheck as Record<string, unknown>).route !== derivedRoute) return invalid('change report precheck verdict/route is not derived from checks');
  return checks;
}

function parseReportIdentityPart(part: unknown, name: string): ValidationResult<{ repository: string; ref: string; sha: string }> {
  if (!isRecord(part) || !isNonEmptyString(part.repository) || !isNonEmptyString(part.ref) || !isSha(part.sha)) return invalid(`change report identity.${name} is invalid`);
  return { ok: true, value: { repository: part.repository, ref: part.ref, sha: part.sha } };
}

function parseReportIdentity(value: Record<string, unknown>): ValidationResult<PullRequestIdentity> {
  if (!isNonEmptyString(value.repository) || !isResourceIdentity(value.resource)) return invalid('change report identity is invalid');
  const base = parseReportIdentityPart(value.base, 'base');
  if (!base.ok) return base;
  const head = parseReportIdentityPart(value.head, 'head');
  if (!head.ok) return head;
  return { ok: true, value: { repository: value.repository, resource: value.resource, base: base.value, head: head.value } };
}

function validatePrChangeReport(value: unknown): ValidationResult<PrChangeReport> {
  if (!isRecord(value) || value.version !== REPORT_VERSION || !isRecord(value.identity) || !isRecord(value.inputs) || !isRecord(value.diff) || !isRecord(value.precheck)) {
    return invalid('change report has an invalid top-level shape');
  }
  const identity = parseReportIdentity(value.identity);
  if (!identity.ok) return identity;
  const inputTaskIntentSha256 = value.inputs.taskIntentSha256;
  if (!isSha(inputTaskIntentSha256)) return invalid('change report taskIntentSha256 is invalid');
  const full = parseScopedDiff(value.diff.full);
  if (!full.ok) return full;
  if (full.value.to !== identity.value.head.sha || full.value.mergeBase !== full.value.from) return invalid('change report complete PR endpoints do not match pull request identity');
  const checks = parseReportPrecheck(value, full.value.files);
  if (!checks.ok) return checks;
  return {
    ok: true,
    value: {
      version: REPORT_VERSION,
      identity: identity.value,
      inputs: { taskIntentSha256: inputTaskIntentSha256 },
      diff: { full: full.value },
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
    diff: { full: mechanical.full },
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

function runMechanicalChangeReport(repoRoot: string, baseSha: string, headSha: string): MechanicalChangeReport {
  const script = path.join(repoRoot, '.agents', 'skills', 'create-pr', 'scripts', 'change-report.mjs');
  const invoke = (): ScopedDiff => {
    const args = [script, '--base', baseSha, '--head', headSha, '--cwd', repoRoot];
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
  const full = invoke();
  const bundle = validateMechanicalReport({ version: 3, base: baseSha, head: headSha, full });
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

function escapeReportTableCell(value: string): string {
  return escapeReportText(value).replaceAll('|', '&#124;');
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function renderLineCountTriple(added: number, deleted: number): [string, string, string] {
  return [String(added), String(deleted), signedNumber(added - deleted)];
}

function renderScopeLineCounts(ranges: AssignedRange[]): [string, string, string] {
  const added = countLocations(ranges.filter((range) => range.side === 'new'));
  const deleted = countLocations(ranges.filter((range) => range.side === 'old'));
  return renderLineCountTriple(added, deleted);
}

function renderFunctionalGroupRow(group: FunctionalGroup): string {
  const counts = renderScopeLineCounts(group.locations.full);
  return `| ${escapeReportTableCell(`${group.id} — ${group.target}`)} | ${counts[0]} | ${counts[1]} | ${counts[2]} | — |`;
}

function renderUnassignedSummaryRows(unassigned: Precheck['unassigned']): string[] {
  return (['shared', 'unconfirmed'] as const).flatMap((reason) => {
    const ranges = unassigned?.full.filter((range) => range.reason === reason) ?? [];
    if (ranges.length === 0) return [];
    const counts = renderScopeLineCounts(ranges);
    const label = reason === 'shared' ? '共享' : '待确认';
    return [`| 未归属（${label}） | ${counts[0]} | ${counts[1]} | ${counts[2]} | — |`];
  });
}

function renderFunctionalGroupTotals(report: PrChangeReport): string {
  const full = report.diff.full;
  const unknownFiles = full.files.filter((file) => file.additions === null).length;
  const counts = renderLineCountTriple(full.totals.additions, full.totals.deletions);
  return `| **合计（机械统计）** | ${counts[0]} | ${counts[1]} | ${counts[2]} | ${unknownFiles} 个文件 |`;
}

function renderFunctionalGroupSummary(groups: FunctionalGroup[], report: PrChangeReport, unassigned: Precheck['unassigned']): string[] {
  const rows = groups.map(renderFunctionalGroupRow);
  rows.push(...renderUnassignedSummaryRows(unassigned));
  rows.push(renderFunctionalGroupTotals(report));
  return [
    '#### 功能模块代码增减（行）',
    '',
    `完整 PR：目标分支 merge-base \`${shortSha(report.diff.full.mergeBase)}\` → 当前 HEAD \`${shortSha(report.diff.full.to)}\`。`,
    '',
    '| 功能模块 | 新增行 | 删除行 | 净增行 | 不可计行文件 |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    '模块行只统计已分配的精确文本行；binary 或 numstat 未知文件不虚构行数，文件数在机械总计中透明列出。'
  ];
}

function renderFunctionalGroups(groups: FunctionalGroup[], files: ChangeFile[], unassigned: Precheck['unassigned']): string[] {
  const filesByPath = new Map(files.map((file) => [file.oldPath ?? file.newPath!, file]));
  return groups.flatMap((group) => [
    `  - **功能组 ${escapeReportText(group.id)}**：${escapeReportText(group.target)}`,
    `    - 行为变化：${escapeReportText(group.behaviorChange)}`,
    `    - 必要性：${escapeReportText(group.necessity)}`,
    `    - 文件：${group.files.map((member) => {
      const file = filesByPath.get(member) ?? [...filesByPath.values()].find((candidate) => candidate.oldPath === member || candidate.newPath === member)!;
      return file.oldPath && file.newPath && file.oldPath !== file.newPath
        ? `<code>${escapeReportText(file.oldPath)}</code> → <code>${escapeReportText(file.newPath)}</code>`
        : `<code>${escapeReportText(member)}</code>`;
    }).join('、')}`,
    `    - 测试覆盖：${escapeReportText(group.tests.coverage)}；成本：${escapeReportText(group.tests.cost)}`
  ]).concat((unassigned?.full ?? []).length === 0 ? [] : [
    `  - **完整 PR 未归属位置说明**：${unassigned!.full.map((item) => `${escapeReportText(item.reason)}：${escapeReportText(item.explanation)}`).join('；')}`
  ]);
}

function renderPrechecks(checks: Precheck[]): string[] {
  return checks.flatMap((check) => [
    `- **${PRECHECK_LABELS[check.id]}（${check.id}）**：${check.verdict === 'pass' ? '通过' : '需复核'}。${escapeReportText(check.rationale)}`,
    ...check.evidence.map(renderEvidence)
  ]);
}

function renderCanonicalChangeReport(report: PrChangeReport): string {
  const totals = report.diff.full.totals;
  const composition = report.precheck.checks.find((check) => check.id === 'change-composition');
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
    ...renderFunctionalGroupSummary(composition?.groups ?? [], report, composition?.unassigned),
    '',
    '#### 功能模块与验证变化',
    ...renderFunctionalGroups(
      composition?.groups ?? [],
      report.diff.full.files,
      composition?.unassigned
    ),
    '',
    `- 总体统计：新增 ${totals.additions} 行、删除 ${totals.deletions} 行；旧字节 ${totals.oldBytes}，新字节 ${totals.newBytes}。`,
    `- 变更明细按高层类别聚合展示；完整逐文件事实保留在结构化报告中供审计。`,
    `- 完整 PR 补丁摘要：\`${report.diff.full.patchSha256}\`；merge-base：\`${report.diff.full.mergeBase}\`。`,
    '',
    ...renderRepresentativeFiles(report.diff.full.files),
    '',
    '#### 适宜性预检',
    `- 结论：${precheckSummary}；${route}；正式审查：否。`,
    ...renderPrechecks(report.precheck.checks)
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
