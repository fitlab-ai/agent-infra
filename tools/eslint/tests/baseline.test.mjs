import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { collectEntries, compareEntries, validateBaseline, violationEntry } from '../run-lint.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

async function lintText(source, { cwd, configPath, filePath }) {
  const eslint = new ESLint({ cwd, overrideConfigFile: configPath, cache: false });
  return eslint.lintText(source, { filePath });
}

function complexityBranches(name, count = 16) {
  return `function ${name}(value) {\n${Array.from({ length: count }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}\n  return -1;\n}`;
}

function deepBody(value = 'value') {
  return `if (${value} > 0) { if (${value} > 1) { if (${value} > 2) { if (${value} > 3) { if (${value} > 4) return; } } } }`;
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
  const baselineHash = () => createHash('sha256').update(readFileSync(baselinePath)).digest('hex');
  return { root, toolDir, run, writeSource, baselinePath, baselineHash };
}

function withLintFixture(callback) {
  const fixture = createLintFixture();
  try {
    const seed = fixture.run(['--write-baseline']);
    assert.equal(seed.status, 0, seed.stdout + seed.stderr);
    return callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const complexitySource = `export function probe(x: number) {
${Array.from({ length: 16 }, (_, index) => `  if (x === ${index}) return ${index};`).join('\n')}
  return -1;
}`;
const depthSource = `export function probe(x: number) {
  if (x > 0) {
    if (x > 1) {
      if (x > 2) {
        if (x > 3) {
          if (x > 4) return x;
        }
      }
    }
  }
  return 0;
}`;

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

test('new method fails even when another method in the same file and rule disappears', () => {
  const errors = compareEntries([entry('a'.repeat(64))], [entry('b'.repeat(64))]);
  assert.deepEqual(errors.map(({ kind }) => kind).sort(), ['new', 'stale']);
});

test('rule IDs keep separate exemptions for the same stable method', () => {
  const complexity = entry('a'.repeat(64), 16, 1, 'complexity');
  const maxDepth = entry('a'.repeat(64), 5, 1, 'max-depth');
  assert.equal(compareEntries([complexity], [maxDepth])[0]?.kind, 'new');
  assert.equal(compareEntries([complexity, maxDepth], [maxDepth, complexity]).length, 0);
});

test('body metrics and diagnostic counts do not change a method exemption identity', () => {
  const errors = compareEntries([entry('a'.repeat(64), 16, 1)], [entry('a'.repeat(64), 24, 3)]);
  assert.deepEqual(errors, []);
});

test('editing a named function body keeps its stable identity while its metric changes', () => {
  const beforeBody = `function manyBranches(value) {
  if (value === 0) return 0;
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  if (value === 7) return 7;
  if (value === 8) return 8;
  if (value === 9) return 9;
  if (value === 10) return 10;
  if (value === 11) return 11;
  if (value === 12) return 12;
  if (value === 13) return 13;
  if (value === 14) return 14;
  return 15;
}`;
  const afterBody = `function manyBranches(value) {
  if (value < 0) return -1;
${Array.from({ length: 17 }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}
  return 99;
}`;
  const filePath = path.resolve('lib/example.ts');
  const before = violationEntry({
    filePath,
    message: { ruleId: 'complexity', messageId: 'complex', message: "Function 'manyBranches' has a complexity of 16. Maximum allowed is 15.", line: 1, column: 1 },
    source: beforeBody
  });
  const after = violationEntry({
    filePath,
    message: { ruleId: 'complexity', messageId: 'complex', message: "Function 'manyBranches' has a complexity of 18. Maximum allowed is 15.", line: 1, column: 1 },
    source: afterBody
  });
  assert.equal(before.stableId, after.stableId);
  assert.notEqual(before.metric, after.metric);
  assert.deepEqual(compareEntries([before], [after]), []);
});

test('removing an exemption requires baseline update and regression becomes new afterward', () => {
  assert.equal(compareEntries([entry('a'.repeat(64))], [])[0]?.kind, 'stale');
  assert.equal(compareEntries([], [entry('a'.repeat(64))])[0]?.kind, 'new');
});

test('stable identities distinguish overload implementations, owners, nested names, and anonymous bindings', () => {
  const filePath = path.resolve('lib/example.ts');
  const message = (line, token, name = 'complexity') => ({
    ruleId: 'complexity',
    messageId: 'complex',
    message: `Function '${name}' has a complexity of 16. Maximum allowed is 15.`,
    line,
    column: source.split('\n')[line - 1].indexOf(token) + 1
  });
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
  const overload = violationEntry({ filePath, message: message(4, '(', 'overloaded'), source });
  const firstInner = violationEntry({ filePath, message: message(5, 'function'), source });
  const secondInner = violationEntry({ filePath, message: message(9, 'function'), source });
  const firstAnonymous = violationEntry({ filePath, message: message(6, 'function'), source });
  const secondAnonymous = violationEntry({ filePath, message: message(10, 'function'), source });
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
  const make = (line) => violationEntry({
    filePath,
    message: { ruleId: 'complexity', messageId: 'complex', message: "Arrow function has a complexity of 16. Maximum allowed is 15.", line, column: source.split('\n')[line - 1].indexOf('=>') + 1 },
    source
  });
  assert.notEqual(make(2).stableId, make(3).stableId);
});

test('editing an earlier callback body keeps a later chained callback identity', () => {
  const filePath = path.resolve('lib/example.ts');
  const makeSource = (filterBody) => `function owner(items) {
  return items.filter(value => { ${filterBody} }).map(value => {
${Array.from({ length: 16 }, (_, index) => `    if (value === ${index}) return value;`).join('\n')}
    return value;
  });
}`;
  const makeEntry = (source) => {
    const offset = source.indexOf('value => {', source.indexOf('.map'));
    const line = source.slice(0, offset).split('\n').length;
    const column = offset - source.lastIndexOf('\n', offset - 1);
    return violationEntry({
      filePath,
      message: { ruleId: 'complexity', messageId: 'complex', message: "Arrow function has a complexity of 17. Maximum allowed is 15.", line, column },
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
    const column = offset - source.lastIndexOf('\n', offset - 1);
    return violationEntry({
      filePath,
      message: { ruleId: 'complexity', messageId: 'complex', message: `Function '${displayName}' has a complexity of 16. Maximum allowed is 15.`, line, column },
      source
    });
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
    message: { ruleId: 'complexity', messageId: 'complex', message: "Function 'run' has a complexity of 16. Maximum allowed is 15.", line: 2, column: 9 },
    source
  }), /Stable method identity collision: .*lib\/example\.ts complexity Duplicate\.run/);
});

test('real complexity diagnostics for new object methods and function-valued properties fail the baseline gate', async () => {
  const fixture = createLintFixture();
  try {
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

    const addedMethod = `added(value) {\n${Array.from({ length: 16 }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}\n  return -1;\n}`;
    const getter = `get value() {\n${Array.from({ length: 16 }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}\n  return -1;\n}`;
    const setter = `set value(value) {\n${Array.from({ length: 16 }, (_, index) => `  if (value === ${index}) return;`).join('\n')}\n}`;
    const field = (prefix = '') => `${prefix}action = (value: number) => {\n${Array.from({ length: 16 }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}\n  return -1;\n};`;
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
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('real max-depth diagnostics distinguish object accessors and static/instance fields', async () => {
  const fixture = createLintFixture();
  try {
    const source = `const object = {
  get value() { ${deepBody('left')} },
  set value(right) { ${deepBody('right')} }
};
class Fields {
  static action = (left: number) => { ${deepBody('left')} };
  action = (right: number) => { ${deepBody('right')} };
  static handler = function same(left: number) { ${deepBody('left')} };
  handler = function same(right: number) { ${deepBody('right')} };
}`;
    const filePath = path.join(fixture.root, 'lib/roles.ts');
    const results = await lintText(source, {
      cwd: fixture.root,
      configPath: path.join(fixture.toolDir, 'eslint.config.mjs'),
      filePath
    });
    const messages = results.flatMap((result) => result.messages).filter((message) => message.ruleId === 'max-depth');
    assert.equal(messages.length, 6, JSON.stringify(results.flatMap((result) => result.messages)));
    const entries = collectEntries(results.map((result) => ({ ...result, source })));
    assert.equal(entries.length, 6);
    assert.equal(new Set(entries.map((entry) => entry.stableId)).size, 6);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('real duplicate same-role function fields remain fail-closed on identity collision', async () => {
  const fixture = createLintFixture();
  try {
    const source = `class Duplicate {
  static action = (left: number) => { ${deepBody('left')} };
  static action = (right: number) => { ${deepBody('right')} };
}`;
    const results = await lintText(source, {
      cwd: fixture.root,
      configPath: path.join(fixture.toolDir, 'eslint.config.mjs'),
      filePath: path.join(fixture.root, 'lib/duplicate.ts')
    });
    assert.equal(results.flatMap((result) => result.messages).filter((message) => message.ruleId === 'max-depth').length, 2);
    assert.throws(() => collectEntries(results.map((result) => ({ ...result, source }))), /Stable method identity collision: .*max-depth/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
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

test('inline ESLint comments cannot suppress either gated complexity rule', () => {
  withLintFixture(({ run, writeSource }) => {
    const cases = [
      ['complexity-disable', '/* eslint-disable complexity */\n', complexitySource, 'complexity'],
      ['complexity-off', '/* eslint complexity: "off" */\n', complexitySource, 'complexity'],
      ['max-depth-disable', '/* eslint-disable max-depth */\n', depthSource, 'max-depth'],
      ['max-depth-off', '/* eslint max-depth: "off" */\n', depthSource, 'max-depth']
    ];
    for (const [name, comment, source, ruleId] of cases) {
      writeSource(`lib/${name}.ts`, `${comment}${source}\n`);
      const result = run();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`new: lib/${name}\\.ts ${ruleId} `));
    }
  });
});

test('an actual ESLint configuration change invalidates the stored baseline', () => {
  withLintFixture(({ run, toolDir, writeSource, baselineHash }) => {
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

test('CI refuses baseline writes without changing the baseline file', () => {
  withLintFixture(({ run, baselineHash }) => {
    const before = baselineHash();
    for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
      const result = run(['--write-baseline'], env);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /Refusing to write the ESLint baseline in a CI environment/);
      assert.equal(baselineHash(), before);
    }
  });
});
