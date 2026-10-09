import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { collectEntries, compareEntries, createBaseline, metadata as lintMetadata, validateBaseline, violationEntry } from '../run-lint.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

async function lintText(source, { cwd, configPath, filePath }) {
  const eslint = new ESLint({ cwd, overrideConfigFile: configPath, cache: false });
  return eslint.lintText(source, { filePath });
}

function complexityBranches(name, count = 16) {
  return `function ${name}(value) {\n${branchChecks('value', count)}\n  return -1;\n}`;
}

function branchChecks(value, count = 16, indent = '  ') {
  return Array.from({ length: count }, (_, index) => `${indent}if (${value} === ${index}) return ${index};`).join('\n');
}

function deepBody(value = 'value') {
  return `if (${value} > 0) { if (${value} > 1) { if (${value} > 2) { if (${value} > 3) { if (${value} > 4) return; } } } }`;
}

function diagnosticAt(source, line, token, { ruleId = 'complexity', metric = 16, name = 'probe' } = {}) {
  const column = source.split('\n')[line - 1].indexOf(token) + 1;
  assert.ok(column > 0, `missing diagnostic anchor ${token} on line ${line}`);
  const message = ruleId === 'max-depth'
    ? `Function nested too deeply (${metric}). Maximum allowed is 4.`
    : name === null
      ? `Arrow function has a complexity of ${metric}. Maximum allowed is 15.`
      : `Function '${name}' has a complexity of ${metric}. Maximum allowed is 15.`;
  return { ruleId, messageId: ruleId === 'max-depth' ? 'maxDepth' : 'complex', message, line, column };
}

function createLintFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task05-lint-cli-'));
  const toolDir = path.join(root, 'tools/eslint');
  mkdirSync(toolDir, { recursive: true });
  for (const file of ['run-lint.mjs', 'eslint.config.mjs', 'package.json']) {
    copyFileSync(path.join(TOOL_DIR, '..', file), path.join(toolDir, file));
  }
  symlinkSync(path.join(TOOL_DIR, '../node_modules'), path.join(toolDir, 'node_modules'), 'dir');
  for (const directory of ['bin', 'lib', 'tests']) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, 'simple.ts'), 'export const ok = 1;\n');
  }
  const run = (args = [], env = {}) => spawnSync(process.execPath, [path.join(toolDir, 'run-lint.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env }
  });
  const writeSource = (file, source) => {
    const filePath = path.join(root, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  };
  const baselinePath = path.join(toolDir, 'baseline.json');
  writeFileSync(baselinePath, `${JSON.stringify(createBaseline([], lintMetadata()), null, 2)}\n`);
  const baselineHash = () => createHash('sha256').update(readFileSync(baselinePath)).digest('hex');
  return { root, toolDir, run, writeSource, baselinePath, baselineHash };
}

async function withLintFixture(callback) {
  const fixture = createLintFixture();
  try {
    return await callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const complexitySource = `export ${complexityBranches('probe')}`;
const depthSource = `export function probe(value) { ${deepBody('value')} }`;
const oldId = 'a'.repeat(64);
const nextId = 'b'.repeat(64);

const entry = (stableId = 'a'.repeat(64), metric = 16, count = 1, ruleId = 'complexity') => ({
  file: 'lib/example.ts',
  ruleId,
  stableId,
  displayName: 'probe',
  metric,
  count
});

const metadata = {
  schemaVersion: 2,
  toolchain: { eslint: '10.12.0', typescriptEslint: '8.71.0', typescript: '6.0.3' },
  configDigest: 'config',
  scopeDigest: 'scope'
};

test('comparison scopes exemptions by method and rule, not metric/count', () => {
  const complexity = entry(oldId);
  const maxDepth = entry(oldId, 5, 1, 'max-depth');
  assert.deepEqual(compareEntries([complexity], [entry(nextId)]).map(({ kind }) => kind).sort(), ['new', 'stale']);
  assert.deepEqual(compareEntries([complexity], [entry(oldId, 24, 3)]), []);
  assert.equal(compareEntries([complexity], [maxDepth])[0]?.kind, 'new');
  assert.deepEqual(compareEntries([complexity, maxDepth], [maxDepth, complexity]), []);
});

test('editing a named function body keeps its stable identity while its metric changes', () => {
  const beforeBody = complexityBranches('manyBranches', 15);
  const afterBody = complexityBranches('manyBranches', 17);
  const filePath = path.resolve('lib/example.ts');
  const before = violationEntry({
    filePath,
    message: diagnosticAt(beforeBody, 1, 'function', { metric: 16, name: 'manyBranches' }),
    source: beforeBody
  });
  const after = violationEntry({
    filePath,
    message: diagnosticAt(afterBody, 1, 'function', { metric: 18, name: 'manyBranches' }),
    source: afterBody
  });
  assert.equal(before.stableId, after.stableId);
  assert.notEqual(before.metric, after.metric);
  assert.deepEqual(compareEntries([before], [after]), []);
});

test('removing an exemption requires baseline update and regression becomes new afterward', () => {
  const stableEntry = entry(oldId);
  assert.equal(compareEntries([stableEntry], [])[0]?.kind, 'stale');
  assert.equal(compareEntries([], [stableEntry])[0]?.kind, 'new');
});

test('stable identities distinguish overload implementations, owners, nested names, and anonymous bindings', () => {
  const filePath = path.resolve('lib/example.ts');
  const source = `class First {
  overloaded(value: string): number;
  overloaded(value: number): number;
  overloaded(value: string | number) { if (value === 0) return 0; return 1; }
  same() { function inner() { if (a) {} } }
  anonymous = function () { if (a) {} };
}
class Second {
  same() { function inner() { if (a) {} } }
  anonymous = function () { if (a) {} };
}`;
  const at = (line, token, name) => violationEntry({ filePath, message: diagnosticAt(source, line, token, { name }), source });
  const overload = at(4, '(', 'overloaded');
  const firstInner = at(5, 'function');
  const secondInner = at(9, 'function');
  const firstAnonymous = at(6, 'function');
  const secondAnonymous = at(10, 'function');
  assert.equal(overload.displayName, 'First.overloaded');
  assert.notEqual(firstInner.stableId, secondInner.stableId);
  assert.notEqual(firstAnonymous.stableId, secondAnonymous.stableId);
  assert.equal(new Set([overload.stableId, firstInner.stableId, secondInner.stableId, firstAnonymous.stableId, secondAnonymous.stableId]).size, 5);
});

test('anonymous callbacks in the same owner and call slot receive distinct identities', () => {
  const filePath = path.resolve('lib/example.ts');
  const source = `function owner(items) {
  items.map(value => { if (value) {} });
  items.map(value => { if (value) {} });
}`;
  const make = (line) => violationEntry({ filePath, message: diagnosticAt(source, line, '=>', { name: null }), source });
  assert.notEqual(make(2).stableId, make(3).stableId);
});

test('editing an earlier callback body keeps a later chained callback identity', () => {
  const filePath = path.resolve('lib/example.ts');
  const makeSource = (filterBody) => `function owner(items) {
  return items.filter(value => { ${filterBody} }).map(value => {
${branchChecks('value', 16, '    ')}
    return value;
  });
}`;
  const makeEntry = (source) => {
    const line = source.slice(0, source.indexOf('.map')).split('\n').length;
    return violationEntry({
      filePath,
      message: diagnosticAt(source, line, 'value =>', { metric: 17, name: null }),
      source
    });
  };
  const before = makeEntry(makeSource('if (value) return true; return false;'));
  const after = makeEntry(makeSource('if (value) { if (enabled) return true; } return false;'));
  assert.equal(before.stableId, after.stableId);
});

test('accessors, same-named function-expression bindings, and repeated anonymous class owners stay distinct', () => {
  const filePath = path.resolve('lib/example.ts');
  const source = `class Accessors {
  get value() { if (ready) return 1; return 0; }
  set value(next) { if (next) return; }
}
const left = function repeated() { if (leftReady) return 1; return 0; };
const right = function repeated() { if (rightReady) return 1; return 0; };
function owner() {
  const classes = [
    class { run() { if (first) return 1; return 0; } },
    class { run() { if (second) return 1; return 0; } }
  ];
}`;
  const entryAt = (token, displayName) => {
    const offset = source.indexOf(token);
    const line = source.slice(0, offset).split('\n').length;
    return violationEntry({ filePath, message: diagnosticAt(source, line, token, { name: displayName }), source });
  };
  const getter = entryAt('if (ready)', 'value');
  const setter = entryAt('if (next)', 'value');
  const leftBinding = entryAt('if (leftReady)', 'repeated');
  const rightBinding = entryAt('if (rightReady)', 'repeated');
  const firstClassOwner = entryAt('if (first)', 'run');
  const secondClassOwner = entryAt('if (second)', 'run');
  assert.notEqual(getter.stableId, setter.stableId);
  assert.notEqual(leftBinding.stableId, rightBinding.stableId);
  assert.notEqual(firstClassOwner.stableId, secondClassOwner.stableId);
  assert.equal(new Set([getter.stableId, setter.stableId, leftBinding.stableId, rightBinding.stableId, firstClassOwner.stableId, secondClassOwner.stableId]).size, 6);
});

test('ambiguous duplicate named declarations fail with a readable collision diagnostic', () => {
  const filePath = path.resolve('lib/example.ts');
  const source = `class Duplicate {
  run() { if (a) {} }
  run() { if (b) {} }
}`;
  assert.throws(() => violationEntry({
    filePath,
    message: diagnosticAt(source, 2, 'run', { name: 'run' }),
    source
  }), /Stable method identity collision: .*lib\/example\.ts complexity Duplicate\.run/);
});

test('real complexity diagnostics for new object methods and function-valued properties fail the baseline gate', async () => {
  await withLintFixture(async (fixture) => {
    const filePath = path.join(fixture.root, 'lib/outer.ts');
    const lint = (source) => lintText(source, {
      cwd: fixture.root,
      configPath: path.join(fixture.toolDir, 'eslint.config.mjs'),
      filePath
    });
    const outer = complexityBranches('outer');
    fixture.writeSource('lib/outer.ts', outer);
    const seeded = fixture.run(['--write-baseline']);
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const beforeResults = await lint(outer);
    const baseline = collectEntries(beforeResults.map((result) => ({ ...result, source: outer })));

    const addedMethod = `added(value) {\n${branchChecks('value', 16, '    ')}\n    return -1;\n}`;
    const getter = `get value() {\n${branchChecks('value', 16, '    ')}\n    return -1;\n}`;
    const setter = `set value(value) {\n${branchChecks('value', 16, '    ')}\n}`;
    const field = (prefix = '') => `${prefix}action = (value: number) => {\n${branchChecks('value', 16, '    ')}\n    return -1;\n};`;
    const source = `${outer.slice(0, -2)}\n  const object = { ${addedMethod}, ${getter}, ${setter} };\n  class Fields { ${field('static ')} ${field()} }\n  return object;\n}`;
    fixture.writeSource('lib/outer.ts', source);

    const results = await lint(source);
    const messages = results.flatMap((result) => result.messages);
    assert.equal(messages.filter((message) => message.ruleId === 'complexity').length, 6, JSON.stringify(messages));
    const current = collectEntries(results.map((result) => ({ ...result, source })));
    const changes = compareEntries(baseline, current);
    const added = changes.filter((change) => change.kind === 'new');
    assert.equal(added.length, 5, JSON.stringify(changes));
    assert.equal(changes.filter((change) => change.kind === 'stale').length, 0, JSON.stringify(changes));
    assert.equal(new Set(added.map((change) => change.entry.stableId)).size, 5);
    const gated = fixture.run();
    assert.equal(gated.status, 1, gated.stdout + gated.stderr);
    const gateLines = `${gated.stdout}${gated.stderr}`.trim().split('\n');
    assert.equal(gateLines.length, 5, JSON.stringify(gateLines));
    assert.ok(gateLines.every((line) => line.startsWith('new: ')), JSON.stringify(gateLines));
  });
});

test('real max-depth identities distinguish roles and fail closed on same-role collisions', async () => {
  await withLintFixture(async (fixture) => {
    const lint = (source, file) => lintText(source, {
      cwd: fixture.root,
      configPath: path.join(fixture.toolDir, 'eslint.config.mjs'),
      filePath: path.join(fixture.root, file)
    });
    const roles = `const object = {
  get value() { ${deepBody('left')} },
  set value(right) { ${deepBody('right')} }
};
class Fields {
  static action = (left: number) => { ${deepBody('left')} };
  action = (right: number) => { ${deepBody('right')} };
  static handler = function same(left: number) { ${deepBody('left')} };
  handler = function same(right: number) { ${deepBody('right')} };
}`;
    const results = await lint(roles, 'lib/roles.ts');
    const messages = results.flatMap((result) => result.messages).filter((message) => message.ruleId === 'max-depth');
    assert.equal(messages.length, 6, JSON.stringify(results.flatMap((result) => result.messages)));
    const entries = collectEntries(results.map((result) => ({ ...result, source: roles })));
    assert.equal(entries.length, 6);
    assert.equal(new Set(entries.map((entry) => entry.stableId)).size, 6);

    const duplicate = `class Duplicate {
  static action = (left: number) => { ${deepBody('left')} };
  static action = (right: number) => { ${deepBody('right')} };
}`;
    const collisions = await lint(duplicate, 'lib/duplicate.ts');
    assert.equal(collisions.flatMap((result) => result.messages).filter((message) => message.ruleId === 'max-depth').length, 2);
    assert.throws(() => collectEntries(collisions.map((result) => ({ ...result, source: duplicate }))), /Stable method identity collision: .*max-depth/);
  });
});

test('collectEntries aggregates metric and normalized summary from the same method-rule identity', () => {
  const source = `function probe(value) { if (a) {} }`;
  const filePath = path.resolve('lib/example.ts');
  const entries = collectEntries([{
    filePath,
    source,
    fatalErrorCount: 0,
    messages: [
      { ruleId: 'max-depth', messageId: 'maxDepth', message: "Function nested too deeply (6). Maximum allowed is 4.", line: 1, column: 1 },
      { ruleId: 'max-depth', messageId: 'maxDepth', message: "Function nested too deeply (5). Maximum allowed is 4.", line: 1, column: 1 }
    ]
  }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.metric, 6);
  assert.equal(entries[0]?.normalizedMessage, 'depth=6');
  assert.equal(entries[0]?.count, 2);
});

test('configuration, toolchain, and malformed entries fail baseline validation', () => {
  const valid = { ...metadata, entries: [entry()] };
  assert.equal(validateBaseline(valid, metadata), null);
  assert.match(validateBaseline({ ...valid, schemaVersion: 1 }, metadata), /unsupported baseline schemaVersion/);
  assert.match(validateBaseline({ ...valid, scopeDigest: 'other' }, metadata), /scopeDigest/);
  assert.match(validateBaseline({ ...valid, entries: [{ ...entry(), count: 0 }] }, metadata), /invalid violation/);
});

test('inline ESLint comments cannot suppress either gated complexity rule', async () => {
  await withLintFixture(async ({ run, writeSource }) => {
    const cases = [
      ['complexity-disable', '/* eslint-disable complexity */\n', complexitySource, 'complexity'],
      ['complexity-off', '/* eslint complexity: "off" */\n', complexitySource, 'complexity'],
      ['max-depth-disable', '/* eslint-disable max-depth */\n', depthSource, 'max-depth'],
      ['max-depth-off', '/* eslint max-depth: "off" */\n', depthSource, 'max-depth']
    ];
    for (const [name, comment, source, ruleId] of cases) {
      writeSource(`lib/${name}.ts`, `${comment}${source}\n`);
    }
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const diagnostics = result.stderr.trim().split('\n');
    assert.equal(diagnostics.length, cases.length, result.stderr);
    for (const [name, , , ruleId] of cases) {
      assert.ok(diagnostics.some((line) => line.startsWith(`new: lib/${name}.ts ${ruleId} `)), result.stderr);
    }
  });
});

test('an actual ESLint configuration change invalidates the stored baseline', async () => {
  await withLintFixture(async ({ run, toolDir, writeSource, baselineHash }) => {
    writeSource('lib/new/probe.ts', `${complexitySource}\n`);
    const configPath = path.join(toolDir, 'eslint.config.mjs');
    const config = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, config.replace("'tests/fixtures/**'", "'tests/fixtures/**', 'lib/new/**'"));
    const before = baselineHash();
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Invalid baseline: baseline configDigest does not match/);
    assert.equal(baselineHash(), before);
  });
});

test('CI refuses baseline writes without changing the baseline file', async () => {
  await withLintFixture(async ({ run, baselineHash }) => {
    const before = baselineHash();
    for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
      const result = run(['--write-baseline'], env);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /Refusing to write the ESLint baseline in a CI environment/);
      assert.equal(baselineHash(), before);
    }
  });
});
