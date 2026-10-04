import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compareEntries, validateBaseline, violationEntry } from '../run-lint.mjs';

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
