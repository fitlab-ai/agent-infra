import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPORT_FILE_NAME = 'pr-change-report.json';
const REPORT_VERSION = 1 as const;
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
  version: number;
  base: string;
  head: string;
  mergeBase: string;
  patchSha256: string;
  files: ChangeFile[];
  totals: ChangeTotals;
};

type Evidence = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  detail: string;
};

type Precheck = {
  id: PrecheckId;
  verdict: CheckVerdict;
  evidence: Evidence[];
  rationale: string;
};

type PrecheckCandidate = {
  taskIntentSha256: string;
  checks: Precheck[];
};

type PullRequestIdentity = {
  repository: string;
  number: number;
  base: { repository: string; ref: string; sha: string };
  head: { repository: string; ref: string; sha: string };
};

type PrChangeReport = {
  version: typeof REPORT_VERSION;
  identity: PullRequestIdentity;
  inputs: { taskIntentSha256: string };
  diff: {
    mergeBase: string;
    patchSha256: string;
    files: ChangeFile[];
    totals: ChangeTotals;
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

function parseChangeFile(value: unknown, index: number): ValidationResult<ChangeFile> {
  if (!isRecord(value)) return invalid(`diff.files[${index}] must be an object`);
  const pathValue = value.oldPath ?? value.newPath;
  if (!isNonEmptyString(pathValue)) return invalid(`diff.files[${index}] must have a path`);
  if (!isSafeRenderedText(value.status)) return invalid(`diff.files[${index}].status is invalid`);
  if (!(value.oldPath === null || isSafeRenderedText(value.oldPath))) return invalid(`diff.files[${index}].oldPath is invalid`);
  if (!(value.newPath === null || isSafeRenderedText(value.newPath))) return invalid(`diff.files[${index}].newPath is invalid`);
  if (!isIntegerOrNull(value.additions) || !isIntegerOrNull(value.deletions)) return invalid(`diff.files[${index}] line counts are invalid`);
  if ((value.additions === null) !== (value.deletions === null)) return invalid(`diff.files[${index}] line counts must both be null or integers`);
  for (const field of ['oldBytes', 'newBytes', 'netBytes']) {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || (field !== 'netBytes' && number < 0)) {
      return invalid(`diff.files[${index}].${field} is invalid`);
    }
  }
  if (value.netBytes !== (value.newBytes as number) - (value.oldBytes as number)) return invalid(`diff.files[${index}].netBytes is inconsistent`);
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
      netBytes: value.netBytes as number
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

function parseChecks(value: unknown, prefix = 'precheck.checks'): ValidationResult<Precheck[]> {
  if (!Array.isArray(value) || value.length !== PRECHECK_IDS.length) return invalid(`${prefix} must contain exactly six checks`);
  const checks: Precheck[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) return invalid(`${prefix}[${index}] must be an object`);
    const expectedId = PRECHECK_IDS[index]!;
    if (raw.id !== expectedId) return invalid(`${prefix}[${index}].id must be '${expectedId}'`);
    if (raw.verdict !== 'pass' && raw.verdict !== 'needs-review') return invalid(`${prefix}.${expectedId}.verdict is invalid`);
    if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) return invalid(`${prefix}.${expectedId}.evidence must not be empty`);
    const evidence: Evidence[] = [];
    for (let evidenceIndex = 0; evidenceIndex < raw.evidence.length; evidenceIndex += 1) {
      const parsed = parseEvidence(raw.evidence[evidenceIndex], expectedId, evidenceIndex);
      if (!parsed.ok) return parsed;
      evidence.push(parsed.value);
    }
    if (!isSafeRenderedText(raw.rationale)) return invalid(`${prefix}.${expectedId}.rationale is required`);
    checks.push({ id: expectedId, verdict: raw.verdict, evidence, rationale: raw.rationale });
  }
  return { ok: true, value: checks };
}

function validateMechanicalReport(value: unknown): ValidationResult<MechanicalChangeReport> {
  if (!isRecord(value)) return invalid('mechanical report must be an object', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  if (value.version !== 1 || !isSha(value.base) || !isSha(value.head) || !isSha(value.mergeBase) || !isSha(value.patchSha256)) {
    return invalid('mechanical report version, commit SHA, or patch SHA is invalid', 'PR_CHANGE_REPORT_MECHANICAL_INVALID');
  }
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
      version: 1,
      base: value.base,
      head: value.head,
      mergeBase: value.mergeBase,
      patchSha256: value.patchSha256,
      files,
      totals: totals.value
    }
  };
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

function validatePrChangeReport(value: unknown): ValidationResult<PrChangeReport> {
  if (!isRecord(value)) return invalid('change report must be an object');
  if (value.version !== REPORT_VERSION || !isRecord(value.identity) || !isRecord(value.inputs) || !isRecord(value.diff) || !isRecord(value.precheck)) {
    return invalid('change report has an invalid top-level shape');
  }
  const identity = value.identity;
  const identityRepository = identity.repository;
  const identityNumber = identity.number;
  if (!isNonEmptyString(identityRepository) || typeof identityNumber !== 'number' || !Number.isSafeInteger(identityNumber) || identityNumber <= 0) return invalid('change report identity is invalid');
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
  if (!isSha(diff.mergeBase) || !isSha(diff.patchSha256) || !Array.isArray(diff.files)) return invalid('change report diff is invalid');
  const files: ChangeFile[] = [];
  for (let index = 0; index < diff.files.length; index += 1) {
    const parsed = parseChangeFile(diff.files[index], index);
    if (!parsed.ok) return parsed;
    files.push(parsed.value);
  }
  const totals = parseTotals(diff.totals);
  if (!totals.ok) return totals;
  if (!totalsMatchFiles(totals.value, files)) return invalid('change report totals do not match files');
  if (value.precheck.formalReview !== false || (value.precheck.verdict !== 'clear' && value.precheck.verdict !== 'needs-review') ||
      (value.precheck.route !== 'watch-pr' && value.precheck.route !== 'review-code')) return invalid('change report precheck envelope is invalid');
  const checks = parseChecks(value.precheck.checks);
  if (!checks.ok) return checks;
  const derivedVerdict: PrecheckVerdict = checks.value.every((check) => check.verdict === 'pass') ? 'clear' : 'needs-review';
  const derivedRoute: PrecheckRoute = derivedVerdict === 'clear' ? 'watch-pr' : 'review-code';
  if (value.precheck.verdict !== derivedVerdict || value.precheck.route !== derivedRoute) return invalid('change report precheck verdict/route is not derived from checks');
  return {
    ok: true,
    value: {
      version: REPORT_VERSION,
      identity: {
        repository: identityRepository,
        number: identityNumber,
        base: base.value,
        head: head.value
      },
      inputs: { taskIntentSha256: inputTaskIntentSha256 },
      diff: { mergeBase: diff.mergeBase, patchSha256: diff.patchSha256, files, totals: totals.value },
      precheck: { verdict: value.precheck.verdict, formalReview: false, route: value.precheck.route, checks: checks.value }
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
    diff: {
      mergeBase: mechanical.mergeBase,
      patchSha256: mechanical.patchSha256,
      files: mechanical.files,
      totals: mechanical.totals
    },
    precheck
  });
}

function reportFilePath(taskDir: string): string {
  return path.join(taskDir, REPORT_FILE_NAME);
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
  const output = execFileSync(process.execPath, [script, '--base', baseSha, '--head', headSha, '--cwd', repoRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const parsed: unknown = JSON.parse(output);
  const validated = validateMechanicalReport(parsed);
  if (!validated.ok) throw new Error(`${validated.error.code}: ${validated.error.message}`);
  return validated.value;
}

const CHANGE_CATEGORIES = [
  { label: '运行时代码', prefixes: ['bin/', 'lib/', 'src/', 'scripts/'] },
  { label: '测试与校验', prefixes: ['test/', 'tests/'] },
  { label: '模板与生成内容', prefixes: ['templates/'] },
  { label: '技能与协作配置', prefixes: ['.agents/'] },
  { label: '文档与其他', prefixes: [] }
] as const;

function emptyChangeTotals(): ChangeTotals {
  return { files: 0, textFiles: 0, binaryFiles: 0, additions: 0, deletions: 0, oldBytes: 0, newBytes: 0, netBytes: 0 };
}

function categoryForChangeFile(file: ChangeFile): (typeof CHANGE_CATEGORIES)[number] {
  const filePath = file.newPath || file.oldPath || '';
  return CHANGE_CATEGORIES.find((category) => category.prefixes.some((prefix) => filePath.startsWith(prefix))) || CHANGE_CATEGORIES[CHANGE_CATEGORIES.length - 1]!;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function renderRepresentativePath(file: ChangeFile): string {
  const paths = file.oldPath && file.newPath && file.oldPath !== file.newPath
    ? [file.oldPath, file.newPath]
    : [representativePath(file)];
  return paths.map((filePath) => `<code>${escapeHtml(filePath)}</code>`).join(' → ');
}

function isPureRename(file: ChangeFile): boolean {
  if (!file.status.startsWith('R') || !file.oldPath || !file.newPath || file.oldPath === file.newPath) return false;
  return file.additions === null ? file.netBytes === 0 : file.additions === 0 && file.deletions === 0;
}

function representativeScore(file: ChangeFile, metric: 'lines' | 'bytes'): number {
  return metric === 'lines' ? file.additions! + file.deletions! : Math.abs(file.netBytes);
}

function representativeFiles(files: ChangeFile[], metric: 'lines' | 'bytes'): ChangeFile[] {
  return files
    .filter((file) => metric === 'bytes' || (file.additions !== null && file.deletions !== null))
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
  const rename = isPureRename(file) ? '（纯 rename）' : '';
  const category = `${categoryForChangeFile(file).label}${rename}`;
  const pathValue = renderRepresentativePath(file);
  if (metric === 'lines') {
    const additions = file.additions!;
    const deletions = file.deletions!;
    return `  - ${pathValue}（${category}）：新增 ${additions} 行、删除 ${deletions} 行，共变更 ${additions + deletions} 行。`;
  }
  const kind = file.additions === null ? '二进制' : '文本';
  return `  - ${pathValue}（${category}）：净字节 ${signedNumber(file.netBytes)}，绝对变化 ${Math.abs(file.netBytes)}（${kind}）。`;
}

function renderRepresentativeFiles(files: ChangeFile[]): string[] {
  const lineFiles = representativeFiles(files, 'lines');
  const byteFiles = representativeFiles(files, 'bytes');
  return [
    '#### 代表性变更文件',
    '',
    '- 行数变化最大（按新增行+删除行，最多展示 3 个）：',
    ...(lineFiles.length > 0 ? lineFiles.map((file) => renderRepresentativeFile(file, 'lines')) : ['  - 无可比较的文本文件。']),
    '- 绝对净字节变化最大（最多展示 3 个）：',
    ...(byteFiles.length > 0 ? byteFiles.map((file) => renderRepresentativeFile(file, 'bytes')) : ['  - 无文件可比较。'])
  ];
}

function renderCanonicalChangeReport(report: PrChangeReport): string {
  const totals = report.diff.totals;
  const categories = summarizeChangeCategories(report.diff.files);
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
  const analysis = report.precheck.verdict === 'clear'
    ? '各项适宜性检查均通过，当前变更可继续进入后续流程。'
    : '部分适宜性检查需要复核，当前变更应先进入正式代码审查。';
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
    `- 补丁摘要：\`${report.diff.patchSha256}\`。`,
    '',
    ...renderRepresentativeFiles(report.diff.files),
    '',
    '#### 适宜性预检',
    `- 结论：${precheckSummary}；${route}；正式审查：否。`,
    `- 高层分析：${analysis} 详细证据保留在结构化报告中。`
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
  reportFilePath,
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
