import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareEntries, validateBaseline, violationEntry } from '../run-lint.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

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

const entry = (normalizedMessage, anchorSha256 = 'a'.repeat(64), count = 1) => ({
  file: 'lib/example.ts',
  ruleId: 'complexity',
  messageId: 'complex',
  normalizedMessage,
  anchorSha256,
  count
});

const metadata = {
  schemaVersion: 1,
  toolchain: { eslint: '10.12.0', typescriptEslint: '8.71.0', typescript: '6.0.3' },
  configDigest: 'config',
  scopeDigest: 'scope'
};

test('new violation fails even when an old violation in the same file and rule disappears', () => {
  const errors = compareEntries([entry('complexity=16')], [entry('complexity=16', 'b'.repeat(64))]);
  assert.deepEqual(errors.map(({ kind }) => kind).sort(), ['new', 'stale']);
});

test('a worsened metric fails even when the function AST is unchanged', () => {
  const errors = compareEntries([entry('complexity=16')], [entry('complexity=17')]);
  assert.ok(errors.some(({ kind }) => kind === 'new'));
  assert.ok(errors.some(({ kind }) => kind === 'stale'));
});

test('moving a diagnostic line without changing its function AST keeps its fingerprint', () => {
  const body = `function manyBranches(value) {
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
  const filePath = path.resolve('lib/example.ts');
  const message = { ruleId: 'complexity', messageId: 'complex', message: "Function 'manyBranches' has a complexity of 16. Maximum allowed is 15.", line: 1, column: 1 };
  const before = violationEntry({ filePath, message, source: body });
  const after = violationEntry({ filePath, message: { ...message, line: 4 }, source: `\n\n\n${body}` });
  assert.deepEqual(before, after);
  assert.deepEqual(compareEntries([entry(before.normalizedMessage, before.anchorSha256)], [entry(after.normalizedMessage, after.anchorSha256)]), []);
});

test('increased occurrence count fails and reduced count requires reviewed baseline update', () => {
  assert.equal(compareEntries([entry('complexity=16', 'a'.repeat(64), 1)], [entry('complexity=16', 'a'.repeat(64), 2)])[0]?.kind, 'worsened');
  assert.equal(compareEntries([entry('complexity=16', 'a'.repeat(64), 2)], [entry('complexity=16', 'a'.repeat(64), 1)])[0]?.kind, 'stale');
});

test('configuration, toolchain, and malformed entries fail baseline validation', () => {
  const valid = { ...metadata, entries: [entry('complexity=16')] };
  assert.equal(validateBaseline(valid, metadata), null);
  assert.match(validateBaseline({ ...valid, scopeDigest: 'other' }, metadata), /scopeDigest/);
  assert.match(validateBaseline({ ...valid, entries: [{ ...entry('complexity=16'), count: 0 }] }, metadata), /invalid violation/);
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
