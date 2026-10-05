import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { lintContract } from './eslint.config.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TOOL_DIR, '../..');
const BASELINE_PATH = path.join(TOOL_DIR, 'baseline.json');
const RULES = Object.fromEntries(Object.keys(lintContract.rules).map((ruleId) => [ruleId, lintContract.rules[ruleId][1]]));
const SCOPE = lintContract.scanFiles;
const require = createRequire(import.meta.url);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stableJson = (value) => JSON.stringify(sortObjectKeys(value), (_key, item) =>
  typeof item === 'bigint' ? { $bigint: item.toString() } : item
);

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
  }
  return value;
}

function packageVersion(name) {
  let current = path.dirname(require.resolve(name));
  while (current !== path.dirname(current)) {
    try {
      const candidate = JSON.parse(readFileSync(path.join(current, 'package.json'), 'utf8'));
      if (candidate.name === name) return candidate.version;
    } catch {
      // Continue walking until the package root is found.
    }
    current = path.dirname(current);
  }
  throw new Error(`Cannot locate package metadata for ${name}`);
}

export function metadata() {
  const toolchain = {
    eslint: packageVersion('eslint'),
    typescriptEslint: packageVersion('typescript-eslint'),
    typescript: packageVersion('typescript')
  };
  return {
    schemaVersion: 1,
    toolchain,
    configDigest: sha256(stableJson({
      eslintConfig: sha256(readFileSync(path.join(TOOL_DIR, 'eslint.config.mjs'))),
      parser: toolchain.typescriptEslint
    })),
    scopeDigest: sha256(stableJson({ files: SCOPE, ignores: lintContract.ignores, eslintFiles: lintContract.files }))
  };
}

function lineColumnToOffset(source, line, column) {
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const next = source.indexOf('\n', offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return Math.min(source.length, offset + column - 1);
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const REMOVED_AST_KEYS = new Set([
  'parent', 'loc', 'range', 'start', 'end', 'tokens', 'comments', 'leadingComments', 'trailingComments'
]);

function astForSource(source, filePath) {
  const parsed = tseslint.parser.parseForESLint(source, {
    filePath,
    sourceType: 'module',
    ecmaVersion: 'latest',
    loc: true,
    range: true,
    tokens: false,
    comment: false
  });
  return parsed;
}

function findAnchor(parsed, source, line, column) {
  const offset = lineColumnToOffset(source, line, column);
  const pathToNode = [];
  const { ast, visitorKeys } = parsed;

  function find(node, ancestors) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.range)) return false;
    if (node.range[0] > offset || node.range[1] < offset) return false;
    pathToNode.length = 0;
    pathToNode.push(...ancestors, node);
    for (const key of visitorKeys[node.type] ?? []) {
      const children = node[key];
      if (Array.isArray(children)) {
        for (const child of children) if (find(child, [...ancestors, node])) return true;
      } else if (find(children, [...ancestors, node])) return true;
    }
    return true;
  }

  find(ast, []);
  const functionNode = [...pathToNode].reverse().find((node) => FUNCTION_TYPES.has(node.type));
  if (functionNode) return functionNode;
  const statementNode = [...pathToNode].reverse().find((node) => node.type.endsWith('Statement'));
  return statementNode ?? ast;
}

function canonicalAst(value) {
  if (Array.isArray(value)) return value.map(canonicalAst);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!REMOVED_AST_KEYS.has(key)) result[key] = canonicalAst(value[key]);
  }
  return result;
}

function metricMessage(ruleId, message) {
  if (ruleId === 'complexity') {
    const match = /complexity of (\d+)/i.exec(message);
    if (match) return `complexity=${match[1]}`;
  }
  if (ruleId === 'max-depth') {
    const match = /nested too deeply \((\d+)\)/i.exec(message);
    if (match) return `depth=${match[1]}`;
  }
  throw new Error(`Unrecognized ${ruleId} diagnostic: ${message}`);
}

export function violationEntry({ filePath, message, source }) {
  const relativePath = path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
  const parsed = astForSource(source, filePath);
  const anchor = findAnchor(parsed, source, message.line, message.column);
  const normalizedMessage = metricMessage(message.ruleId, message.message);
  const anchorSha256 = sha256(stableJson(canonicalAst(anchor)));
  return {
    file: relativePath,
    ruleId: message.ruleId,
    messageId: message.messageId,
    normalizedMessage,
    anchorSha256
  };
}

export function collectEntries(results) {
  const entries = new Map();
  for (const result of results) {
    if (result.fatalErrorCount > 0) continue;
    for (const message of result.messages) {
      if (!Object.hasOwn(RULES, message.ruleId)) continue;
      const entry = violationEntry({ filePath: result.filePath, message, source: result.source ?? '' });
      const key = stableJson(entry);
      entries.set(key, { ...entry, count: (entries.get(key)?.count ?? 0) + 1 });
    }
  }
  return [...entries.values()].sort(compareBaselineEntries);
}

function compareBaselineEntries(left, right) {
  const leftKey = stableJson(left);
  const rightKey = stableJson(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function createBaseline(entries, extra = metadata()) {
  return { ...extra, entries: [...entries].sort(compareBaselineEntries) };
}

export function validateBaseline(baseline, expected = metadata()) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return 'baseline must be an object';
  for (const key of ['schemaVersion', 'toolchain', 'configDigest', 'scopeDigest', 'entries']) {
    if (!Object.hasOwn(baseline, key)) return `baseline is missing ${key}`;
  }
  if (baseline.schemaVersion !== expected.schemaVersion) return `unsupported baseline schemaVersion ${baseline.schemaVersion}`;
  for (const key of ['toolchain', 'configDigest', 'scopeDigest']) {
    if (stableJson(baseline[key]) !== stableJson(expected[key])) return `baseline ${key} does not match the current lint configuration`;
  }
  if (!Array.isArray(baseline.entries)) return 'baseline entries must be an array';
  for (const entry of baseline.entries) {
    if (!entry || typeof entry !== 'object' ||
      typeof entry.file !== 'string' || typeof entry.ruleId !== 'string' ||
      typeof entry.messageId !== 'string' || typeof entry.normalizedMessage !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.anchorSha256) || !Number.isSafeInteger(entry.count) || entry.count < 1) {
      return 'baseline contains an invalid violation entry';
    }
  }
  return null;
}

export function compareEntries(baselineEntries, currentEntries) {
  const key = ({ count, ...entry }) => stableJson(entry);
  const baseline = new Map(baselineEntries.map((entry) => [key(entry), entry.count]));
  const current = new Map(currentEntries.map((entry) => [key(entry), entry.count]));
  const errors = [];

  for (const [fingerprint, count] of current) {
    const previous = baseline.get(fingerprint) ?? 0;
    if (count > previous) errors.push({ kind: previous ? 'worsened' : 'new', entry: currentEntries.find((item) => key(item) === fingerprint), count, previous });
  }
  for (const [fingerprint, count] of baseline) {
    const observed = current.get(fingerprint) ?? 0;
    if (observed < count) errors.push({ kind: 'stale', entry: baselineEntries.find((item) => key(item) === fingerprint), count: observed, previous: count });
  }
  return errors;
}

async function lint() {
  const eslint = new ESLint({
    cwd: ROOT_DIR,
    overrideConfigFile: path.join(TOOL_DIR, 'eslint.config.mjs')
  });
  const results = await eslint.lintFiles(SCOPE);
  return { eslint, results, fatalErrorCount: results.reduce((sum, result) => sum + result.fatalErrorCount, 0), entries: collectEntries(results) };
}

function atomicWriteBaseline(baseline) {
  const temporaryPath = `${BASELINE_PATH}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporaryPath, BASELINE_PATH);
}

function printScan({ results, fatalErrorCount, entries }) {
  const counts = Object.fromEntries(Object.keys(RULES).map((ruleId) => [ruleId, entries.reduce((sum, entry) => sum + (entry.ruleId === ruleId ? entry.count : 0), 0)]));
  process.stdout.write(`${JSON.stringify({ files: results.length, fatalErrorCount, counts, entries }, null, 2)}\n`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const allowedArgs = new Set(['--scan', '--write-baseline']);
  const unknownArg = [...args].find((argument) => !allowedArgs.has(argument));
  if (unknownArg || (args.has('--scan') && args.has('--write-baseline'))) {
    process.stderr.write('Usage: node run-lint.mjs [--scan | --write-baseline]\n');
    process.exitCode = 2;
    return;
  }
  if (args.has('--write-baseline') && (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')) {
    process.stderr.write('Refusing to write the ESLint baseline in a CI environment.\n');
    process.exitCode = 2;
    return;
  }
  const scan = await lint();
  if (args.has('--scan')) {
    printScan(scan);
    if (scan.fatalErrorCount) process.exitCode = 1;
    return;
  }
  if (scan.fatalErrorCount) {
    process.stderr.write(`ESLint reported ${scan.fatalErrorCount} fatal parsing/configuration error(s).\n`);
    process.exitCode = 1;
    return;
  }
  if (args.has('--write-baseline')) {
    atomicWriteBaseline(createBaseline(scan.entries));
    process.stdout.write(`Wrote ${scan.entries.length} baseline fingerprint(s) to ${path.relative(ROOT_DIR, BASELINE_PATH)}; review the diff before committing.\n`);
    return;
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    process.stderr.write(`Cannot read baseline ${path.relative(ROOT_DIR, BASELINE_PATH)}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const invalid = validateBaseline(baseline);
  if (invalid) {
    process.stderr.write(`Invalid baseline: ${invalid}\n`);
    process.exitCode = 1;
    return;
  }
  const errors = compareEntries(baseline.entries, scan.entries);
  for (const item of errors) {
    const entry = item.entry;
    process.stderr.write(`${item.kind}: ${entry.file} ${entry.ruleId} ${entry.normalizedMessage} (baseline ${item.previous}, current ${item.count})\n`);
  }
  if (errors.length) process.exitCode = 1;
  else process.stdout.write(`ESLint baseline check passed for ${scan.results.length} files (${scan.entries.length} fingerprints).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { main };
